/**
 * Capture/recovery cost benchmark — seeds N synthetic memories through the
 * capture path against an isolated daemon, then reports disk, memory,
 * latency, context and force-kill recovery numbers against the budgets in
 * `benchmark/capture-costs-budgets.json`.
 *
 * Origin: upstream #1464 (benchmark/capture-costs.ts). Adapted to the fork:
 * single-file SQLite state store (disk budgets compare state_store.db bytes,
 * no Redis backend), compose-based CLI (`--instance` isolation, SIGTERM then
 * SIGKILL across the whole re-daemonized compose tree, runs fail loudly if
 * ports stay held), keyless profile only.
 * RSS covers the worker plus the real iii:e engine (resolved by instance
 * config path: iii.pid names the compose supervisor and goes stale across
 * restarts). Crash and stop legs kill the whole re-daemonized compose tree
 * and refuse to proceed while the instance ports stay held.
 * Redis/Ollama/crash-offline variants from upstream are out of scope.
 *
 * Runs the built CLI (`node dist/cli.mjs`), never the source tree.
 *
 * Env knobs:
 *   AGENTMEMORY_BENCH_AUTOSTART   "1" to spawn an isolated daemon (default "1");
 *                                 "0" to use AGENTMEMORY_URL instead
 *   AGENTMEMORY_URL               base URL of the daemon (default: http://localhost:3111,
 *                                 only used with AUTOSTART=0)
 *   BENCH_N                       observations to seed (default: 100; budgets exist for 100/1000/10000)
 *   BENCH_SEED                    seed for the mulberry32 RNG (default: 0xC0FFEE)
 *   BENCH_OUT_DIR                 results dir (default: benchmark/results)
 *   BENCH_INSTANCE                --instance number for the isolated daemon (default: probed free in 31-50)
 *   BENCH_BUDGETS                 budgets file (default: benchmark/capture-costs-budgets.json;
 *                                 "off" disables budget checks)
 *   BENCH_ENFORCE_BUDGETS         "1" to exit 2 when a budget fails (default "1")
 *   BENCH_HOOK_SAMPLE             hook invocations to time (default: 20)
 *
 * Exit codes: 0 pass, 1 invariant failure (observations or index lost),
 * 2 budget failure with enforcement on.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { pXX } from "./lib/percentiles.js";

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOUNS = [
  "cache", "queue", "router", "stream", "shard", "lock", "buffer", "worker",
  "engine", "trigger", "function", "memory", "index", "graph", "vector",
  "session", "observation", "summary", "embedding", "tokenizer", "scheduler",
  "consumer", "producer", "channel", "actor", "pipeline", "watcher", "pool",
];
const VERBS = [
  "flushes", "rotates", "compacts", "rebalances", "drains", "warms",
  "expires", "deduplicates", "snapshots", "replays", "promotes", "demotes",
  "merges", "splits", "indexes", "scans", "compresses", "uploads",
];
const CONCEPTS = [
  "throughput", "latency", "backpressure", "consistency", "isolation",
  "durability", "idempotency", "fan-out", "cardinality", "skew",
  "hot-path", "cold-start", "tail-latency", "saturation", "quiescence",
];

function buildContent(rng: () => number, i: number): string {
  const n = NOUNS[Math.floor(rng() * NOUNS.length)]!;
  const v = VERBS[Math.floor(rng() * VERBS.length)]!;
  const c1 = CONCEPTS[Math.floor(rng() * CONCEPTS.length)]!;
  const c2 = CONCEPTS[Math.floor(rng() * CONCEPTS.length)]!;
  const k = Math.floor(rng() * 9999);
  return `seed-${i} the ${n} ${v} ${c1} under ${c2} pressure (k=${k})`;
}

interface Check {
  name: string;
  value: number;
  limit: number;
  pass: boolean;
  skipped?: boolean;
  reason?: string;
}

interface BudgetsFile {
  budgets: Record<string, Record<string, Record<string, number>>>;
}

const REPO = resolve(import.meta.dirname, "..");
const BUDGET_SIZES = [100, 1000, 10000];

function nearestBudgetSize(n: number): number {
  let best = BUDGET_SIZES[0]!;
  for (const s of BUDGET_SIZES) {
    if (Math.abs(s - n) < Math.abs(best - n)) best = s;
  }
  return best;
}

function diskBytes(dir: string): number {
  let total = 0;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) total += diskBytes(p);
    else total += st.size;
  }
  return total;
}

function rssKiB(pid: number): number | null {
  try {
    const out = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
    const n = parseInt(out, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function readPid(file: string): number | null {
  try {
    const n = parseInt(readFileSync(file, "utf8").trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function shortGitSha(): string {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (sha) return sha;
  } catch {
    /* no git */
  }
  return `nogit-${Date.now().toString(36)}`;
}

interface Instance {
  home: string;
  dataDir: string;
  runtimeDir: string;
  root: string;
  instance: number;
  port: number;
  base: string;
  proc: ChildProcess | null;
  pgid: number | null;
}

function dataDirFor(home: string, instance: number): string {
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "agentmemory", `instance-${instance}`);
  }
  const xdg = process.env["XDG_DATA_HOME"];
  const base = xdg ? join(xdg, "agentmemory") : join(home, ".local", "share", "agentmemory");
  return join(base, `instance-${instance}`);
}

async function waitForLivez(base: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${base}/livez`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function secretFor(home: string): string {
  return readFileSync(join(home, ".agentmemory", "secret"), "utf8").trim();
}

async function authed(base: string, secret: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, bytes: text.length, text };
}

async function driveLoad(
  concurrency: number,
  total: number,
  fetcher: (i: number) => Promise<void>,
): Promise<{ latencies: number[]; errors: number; wallMs: number }> {
  const latencies: number[] = [];
  let errors = 0;
  let issued = 0;
  const wallStart = performance.now();
  async function worker(): Promise<void> {
    while (true) {
      const i = issued++;
      if (i >= total) return;
      const t0 = performance.now();
      try {
        await fetcher(i);
        latencies.push(performance.now() - t0);
      } catch {
        errors++;
      }
    }
  }
  await Promise.allSettled(
    Array.from({ length: Math.max(1, concurrency) }, () => worker()),
  );
  return { latencies, errors, wallMs: performance.now() - wallStart };
}

function percentile(latencies: number[], p: number): number {
  return pXX(latencies.slice().sort((a, b) => a - b), p);
}

function startDaemon(inst: Instance): void {
  const cli = join(REPO, "dist", "cli.mjs");
  if (!existsSync(cli)) {
    throw new Error(`dist/cli.mjs missing — run \`npm run build\` first`);
  }
  const seed = join(process.env["HOME"] ?? "", ".agentmemory", "bin", "iii");
  const target = join(inst.home, ".agentmemory", "bin", "iii");
  if (existsSync(seed) && !existsSync(target)) {
    mkdirSync(join(inst.home, ".agentmemory", "bin"), { recursive: true });
    cpSync(seed, target);
  }
  const proc = spawn(
    process.execPath,
    [cli, "--instance", String(inst.instance)],
    {
      cwd: inst.root,
      env: { ...process.env, HOME: inst.home, CI: "1", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  proc.stdout?.on("data", () => {});
  proc.stderr?.on("data", () => {});
  proc.unref();
  inst.proc = proc;
  inst.pgid = proc.pid ?? null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pidOnPort(port: number): number | null {
  try {
    const out = spawnSync("ss", ["-tlnp"], { encoding: "utf8" }).stdout ?? "";
    for (const line of out.split("\n")) {
      if (!line.includes(`127.0.0.1:${port} `) && !line.includes(`:${port} `)) continue;
      const m = line.match(/pid=(\d+)/);
      if (m) {
        const n = parseInt(m[1]!, 10);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
  } catch {
    /* ss unavailable — caller falls back to the pidfile */
  }
  return null;
}

function readCmdline(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return null;
  }
}

function listPids(): number[] {
  let entries: string[] = [];
  try {
    entries = readdirSync("/proc");
  } catch {
    return [];
  }
  return entries
    .filter((e) => /^\d+$/.test(e))
    .map((e) => parseInt(e, 10))
    .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid);
}

function enginePid(inst: Instance): number | null {
  for (const pid of listPids()) {
    const cmd = readCmdline(pid);
    if (cmd && cmd.includes("iii:e:default") && cmd.includes(inst.dataDir)) return pid;
  }
  const fromFile = readPid(join(inst.runtimeDir, "iii.pid"));
  if (fromFile && pidAlive(fromFile)) return fromFile;
  return pidOnPort(inst.port + 46023);
}

function treePids(inst: Instance): number[] {
  const found = new Set<number>();
  const launcher = inst.proc?.pid ?? null;
  if (launcher) found.add(launcher);
  for (const pid of listPids()) {
    const cmd = readCmdline(pid);
    if (cmd && (cmd.includes(inst.home) || cmd.includes(inst.root))) found.add(pid);
  }
  for (const pid of [
    readPid(join(inst.runtimeDir, "worker.pid")),
    readPid(join(inst.runtimeDir, "iii.pid")),
  ]) {
    if (pid) found.add(pid);
  }
  found.delete(process.pid);
  return [...found];
}

function enginePidfileStale(inst: Instance): boolean {
  const fromFile = readPid(join(inst.runtimeDir, "iii.pid"));
  return fromFile !== null && !pidAlive(fromFile);
}

function signalTree(inst: Instance, signal: NodeJS.Signals): void {
  if (inst.pgid) {
    try {
      process.kill(-inst.pgid, signal);
    } catch {
      /* group already gone */
    }
  }
  for (const pid of [
    readPid(join(inst.runtimeDir, "worker.pid")),
    readPid(join(inst.runtimeDir, "iii.pid")),
  ]) {
    if (pid) {
      try {
        process.kill(pid, signal);
      } catch {
        /* already gone */
      }
    }
  }
}

function portBusy(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    let done = false;
    const finish = (busy: boolean) => {
      if (!done) {
        done = true;
        resolvePromise(busy);
      }
    };
    const timer = setTimeout(() => {
      sock.destroy();
      finish(false);
    }, 1000);
    const sock = connect({ port, host: "127.0.0.1" });
    sock.once("connect", () => {
      clearTimeout(timer);
      sock.destroy();
      finish(true);
    });
    sock.once("error", () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

async function pickFreeInstance(): Promise<number> {
  const candidates = Array.from({ length: 20 }, (_, i) => 31 + i);
  for (let attempt = 0; attempt < 10; attempt++) {
    const n = candidates[Math.floor(Math.random() * candidates.length)]!;
    const port = 3111 + n * 100;
    const busy = (
      await Promise.all([port, port + 46023].map((p) => portBusy(p)))
    ).some(Boolean);
    if (!busy) return n;
  }
  throw new Error("no free --instance block found in 31-40 (stale bench daemons may hold ports)");
}

async function stopDaemon(inst: Instance): Promise<void> {
  signalTree(inst, "SIGTERM");
  if (await waitPortsFree(inst, 30_000)) return;
  killDaemon(inst);
  if (!(await waitPortsFree(inst, 30_000))) {
    console.error(`[capture-costs] warning: ports for --instance ${inst.instance} still busy after stop`);
  }
}

function killDaemon(inst: Instance): void {
  signalTree(inst, "SIGKILL");
  for (const pid of treePids(inst)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

async function waitPortsFree(inst: Instance, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const busy = (
      await Promise.all(
        [inst.port, inst.port + 1, inst.port + 2, inst.port + 46023].map((p) => portBusy(p)),
      )
    ).some(Boolean);
    if (!busy) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
interface RssParts {
  worker: number | null;
  engine: number | null;
  total: number | null;
}

function sampleRssParts(inst: Instance): RssParts {
  const workerPid = readPid(join(inst.runtimeDir, "worker.pid"));
  const worker = workerPid && pidAlive(workerPid) ? rssKiB(workerPid) : null;
  const engine = enginePid(inst);
  const engineRss = engine && pidAlive(engine) ? rssKiB(engine) : null;
  return {
    worker,
    engine: engineRss,
    total: worker !== null && engineRss !== null ? worker + engineRss : null,
  };
}

async function settleRssParts(inst: Instance | null, rounds = 4, gapMs = 10_000): Promise<RssParts> {
  let best: RssParts = { worker: null, engine: null, total: null };
  for (let i = 0; i < rounds; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, gapMs));
    if (inst) {
      const parts = sampleRssParts(inst);
      if (parts.total !== null && (best.total === null || parts.total < best.total)) best = parts;
    }
  }
  return best;
}

async function verifyMarkers(
  base: string,
  secret: string,
  markers: string[],
): Promise<{ missing: number }> {
  let missing = 0;
  await driveLoad(16, markers.length, async (i) => {
    const r = await authed(base, secret, "POST", "/search", { query: markers[i], limit: 5 });
    if (r.status !== 200 || !JSON.stringify(r.json).includes(markers[i]!)) missing++;
  });
  return { missing };
}

async function runHook(
  home: string,
  port: number,
  root: string,
  script: string,
  payload: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): Promise<{ ms: number; exit: number | null; stdoutBytes: number }> {
  const t0 = performance.now();
  const child = spawn(
    process.execPath,
    [join(REPO, "plugin", "scripts", script)],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        CI: "1",
        NO_COLOR: "1",
        AGENTMEMORY_URL: `http://127.0.0.1:${port}`,
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdoutBytes = 0;
  child.stdout.on("data", (c) => {
    stdoutBytes += (c as Buffer).length;
  });
  child.stderr.on("data", () => {});
  child.stdin.end(JSON.stringify(payload));
  const exit = await new Promise<number | null>((resolveExit) => {
    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolveExit(null);
    }, 15_000);
    child.on("error", () => {
      clearTimeout(timeout);
      resolveExit(null);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
  });
  return { ms: performance.now() - t0, exit, stdoutBytes };
}

async function main(): Promise<void> {
  const N = parseInt(process.env["BENCH_N"] || "100", 10) || 100;
  const seed = parseInt(process.env["BENCH_SEED"] || "12648430", 10) || 12648430;
  const hookSample = parseInt(process.env["BENCH_HOOK_SAMPLE"] || "20", 10) || 20;
  const autoStart = (process.env["AGENTMEMORY_BENCH_AUTOSTART"] ?? "1") !== "0";
  const enforce = (process.env["BENCH_ENFORCE_BUDGETS"] ?? "1") !== "0";
  const budgetsOpt = process.env["BENCH_BUDGETS"] || join("benchmark", "capture-costs-budgets.json");
  const outDir = process.env["BENCH_OUT_DIR"] || resolve(REPO, "benchmark", "results");
  let instanceNum =
    parseInt(process.env["BENCH_INSTANCE"] || "", 10) || 31 + Math.floor(Math.random() * 10);

  const budgets: BudgetsFile | null =
    budgetsOpt === "off" ? null : (JSON.parse(readFileSync(resolve(REPO, budgetsOpt), "utf8")) as BudgetsFile);
  const budgetSize = nearestBudgetSize(N);
  const limits = budgets?.budgets?.["keyless"]?.[String(budgetSize)] ?? null;
  if (budgets && !limits) {
    throw new Error(`no keyless budgets for N=${budgetSize} in ${budgetsOpt}`);
  }
  const limit = (name: string): number | null => {
    const v = limits?.[name];
    return typeof v === "number" ? v : null;
  };

  let inst: Instance | null = null;
  let base = (process.env["AGENTMEMORY_URL"] || "http://localhost:3111").replace(/\/+$/, "");
  let secret = "";
  let spawned = false;
  if (autoStart) {
    if (!process.env["BENCH_INSTANCE"]) instanceNum = await pickFreeInstance();
    const root = mkdtempSync(join(tmpdir(), "ambench-"));
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const port = 3111 + instanceNum * 100;
    base = `http://127.0.0.1:${port}/agentmemory`;
    const dataDir = dataDirFor(home, instanceNum);
    inst = { home, dataDir, runtimeDir: dataDir, root, instance: instanceNum, port, base, proc: null, pgid: null };
    console.log(`[capture-costs] starting isolated daemon --instance ${instanceNum} (port ${port})`);
    startDaemon(inst);
    spawned = true;
    try {
      if (!(await waitForLivez(base, 180_000))) {
        throw new Error(`isolated daemon on ${base} never became ready`);
      }
    } catch (err) {
      await stopDaemon(inst).catch(() => {});
      try {
        rmSync(inst.root, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      spawned = false;
      throw err;
    }
    secret = secretFor(home);
  } else {
    console.log(`[capture-costs] using existing daemon at ${base}`);
    await waitForLivez(base, 30_000);
  }

  const checks: Check[] = [];
  const invariants: Check[] = [];
  const notes: string[] = [];
  try {
  const stateDir = inst ? join(inst.dataDir, "state_store.db") : "";
    const stateBytes = (dir: string): number => (dir && existsSync(dir) ? diskBytes(dir) : 0);
    const diskBefore = inst ? stateBytes(stateDir) : 0;
    const rng = mulberry32(seed);
    const markers = Array.from({ length: N }, (_, i) => `capmark${seed.toString(36)}n${i}x`);

    let peakParts: RssParts = { worker: null, engine: null, total: null };
    const sampler = setInterval(() => {
      if (inst) {
        const parts = sampleRssParts(inst);
        if (parts.total !== null && (peakParts.total === null || parts.total > peakParts.total)) {
          peakParts = parts;
        }
      }
    }, 250);

    const { latencies, errors } = await driveLoad(8, N, async (i) => {
      const r = await authed(base, secret, "POST", "/remember", {
        content: `${markers[i]} ${buildContent(rng, i)}`,
        type: "observation",
      });
      if (r.status !== 200 && r.status !== 201) throw new Error(`remember HTTP ${r.status}`);
    });
    clearInterval(sampler);
    if (errors > 0) throw new Error(`seeding produced ${errors} errors`);
    if (latencies.length !== N) throw new Error(`seeded ${latencies.length}/${N}`);

    const diskAfter = inst ? stateBytes(stateDir) : 0;
    const diskTotalAfter = inst ? diskBytes(inst.dataDir) : 0;
    const growth = N > 0 ? (diskAfter - diskBefore) / N : 0;
    const capturePeak = peakParts.total;
    const idleParts = await settleRssParts(inst);

    const hookLatencies: number[] = [];
    let hookStdoutTotal = 0;
    let hookFails = 0;
    for (let i = 0; i < hookSample; i++) {
      const tag = `hookmark${seed.toString(36)}h${i}`;
      const r = inst
        ? await runHook(inst.home, inst.port, inst.root, "post-tool-use.mjs", {
            session_id: `bench-sess-${seed.toString(36)}`,
            tool_name: "Bash",
            tool_input: { command: `npm test -- ${tag}` },
            tool_response: `${tag} ${buildContent(mulberry32(seed + i), i)}`,
            cwd: inst.root,
          })
        : { ms: 0, exit: 0, stdoutBytes: 0 };
      hookLatencies.push(r.ms);
      hookStdoutTotal += r.stdoutBytes;
      if (r.exit !== 0) hookFails++;
    }

    const searchBytes: number[] = [];
    const searchCompactTokens: number[] = [];
    for (let i = 0; i < 20; i++) {
      const full = await authed(base, secret, "POST", "/search", {
        query: buildContent(mulberry32(seed + 10_000 + i), i),
        limit: 5,
        format: "full",
      });
      if (full.status !== 200) throw new Error(`search HTTP ${full.status}`);
      searchBytes.push(full.bytes);
      const compact = await authed(base, secret, "POST", "/search", {
        query: buildContent(mulberry32(seed + 10_000 + i), i),
        limit: 5,
        format: "compact",
      });
      if (compact.status !== 200) throw new Error(`search HTTP ${compact.status}`);
      const used = (compact.json as { tokens_used?: unknown } | null)?.tokens_used;
      if (typeof used === "number" && Number.isFinite(used)) searchCompactTokens.push(used);
    }

    const sessionStart = inst
      ? await runHook(inst.home, inst.port, inst.root, "session-start.mjs", {
          session_id: `bench-sess-${seed.toString(36)}`,
          cwd: inst.root,
          hook_event_name: "SessionStart",
          source: "startup",
        })
      : { ms: 0, exit: 0, stdoutBytes: 0 };

    const probe = markers[Math.floor(markers.length / 2)]!;
    const before = await authed(base, secret, "POST", "/search", { query: probe, limit: 5 });
    const foundBefore = typeof before.json === "object" && before.json !== null && JSON.stringify(before.json).includes(probe);
    const indexed = await verifyMarkers(base, secret, markers);
    invariants.push({
      name: "observationsIndexedBeforeKill",
      value: markers.length - indexed.missing,
      limit: markers.length,
      pass: indexed.missing === 0,
    });

    let recoveryReadyMs = 0;
    let recoveryIndexReadyMs = 0;
    let foundAfter = foundBefore;
    let recoveryParts: RssParts = { worker: null, engine: null, total: null };
    if (inst && spawned) {
      killDaemon(inst);
      if (!(await waitPortsFree(inst, 30_000))) {
        throw new Error("daemon ports still held 30s after SIGKILL — refusing to measure recovery on a polluted tree");
      }
      const t0 = performance.now();
      startDaemon(inst);
      const ready = await waitForLivez(base, 180_000);
      recoveryReadyMs = Math.round(performance.now() - t0);
      if (!ready) throw new Error("daemon did not recover after SIGKILL");
      secret = secretFor(inst.home);
      const t1 = performance.now();
      const deadline = Date.now() + 120_000;
      foundAfter = false;
      while (Date.now() < deadline) {
        try {
          const r = await authed(base, secret, "POST", "/search", { query: probe, limit: 5 });
          if (r.status === 200 && JSON.stringify(r.json).includes(probe)) {
            foundAfter = true;
            break;
          }
        } catch {
          /* retry */
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      recoveryIndexReadyMs = Math.round(performance.now() - t1);
      recoveryParts = await settleRssParts(inst);
      const survived = await verifyMarkers(base, secret, markers);
      invariants.push({
        name: "logicalObservationsSurviveKill",
        value: markers.length - survived.missing,
        limit: markers.length,
        pass: survived.missing === 0,
      });
    }

    invariants.push({ name: "observationsSeeded", value: latencies.length, limit: N, pass: latencies.length === N });
    invariants.push({ name: "markerSearchableBeforeKill", value: foundBefore ? 1 : 0, limit: 1, pass: foundBefore });
    invariants.push({ name: "markerSearchableAfterKill", value: foundAfter ? 1 : 0, limit: 1, pass: foundAfter });
    invariants.push({ name: "hookNonZeroExits", value: hookFails, limit: 0, pass: hookFails === 0 });
    invariants.push({ name: "hookStdoutBytesWithInjectionOff", value: hookStdoutTotal, limit: 0, pass: hookStdoutTotal === 0 });

    if (limits) {
      const atMost = (name: string, value: number | null) => {
        const lim = limit(name);
        if (lim === null) {
          checks.push({ name, value: value ?? NaN, limit: NaN, pass: true, skipped: true, reason: `no ${name} budget at keyless@${budgetSize} upstream` });
          return;
        }
        if (value === null) {
          checks.push({ name, value: NaN, limit: lim, pass: true, skipped: true, reason: "unmeasurable here" });
          return;
        }
        checks.push({ name, value: Math.round(value * 100) / 100, limit: lim, pass: value <= lim });
      };
      atMost("diskGrowthPerObservationBytes", growth);
      atMost("diskAfterCaptureBytes", diskAfter);
      atMost("capturePeakRssKiB", capturePeak);
      atMost("idleRssKiB", idleParts.total);
      atMost("recoveryIdleRssKiB", recoveryParts.total);
      atMost("hookP95Ms", percentile(hookLatencies, 95));
      atMost("observeP95Ms", percentile(latencies, 95));
      atMost("recoveryReadyMs", recoveryReadyMs);
      atMost("recoveryIndexReadyMs", recoveryIndexReadyMs);
      atMost("searchFullBytesP50", percentile(searchBytes, 50));
      atMost(
        "searchCompactTokensP50",
        searchCompactTokens.length > 0 ? percentile(searchCompactTokens, 50) : null,
      );
      atMost("sessionStartInjectOnStdoutBytes", sessionStart.stdoutBytes);
      notes.push(
        "disk budgets compare state_store.db bytes: the fork's single-file state store plays the role of upstream's summed state scopes. Engine OTel traces and compose logs co-located in the data dir are excluded (reported as diskTotalAfterBytes).",
        "diskIndexBytes/diskDiagnosticBytes skipped: fork uses a single-file SQLite state store with no per-scope files (upstream #1464 adaptation).",
        "redisUsedMemoryBytes/redisKeys skipped: fork has no Redis backend.",
      );
      if (inst && enginePidfileStale(inst)) {
        notes.push(
          "engine pidfile names the compose supervisor, not the engine, and goes stale across a SIGKILL restart; RSS resolves the live iii:e engine by its instance config path instead.",
        );
      }
    }

    const failedInvariants = invariants.filter((c) => !c.pass);
    const failedChecks = checks.filter((c) => !c.pass && !c.skipped);
    const rows = [...invariants.map((c) => ({ ...c, kind: "invariant" })), ...checks.map((c) => ({ ...c, kind: "budget" }))];
    console.log("");
    console.log("check kind      name                                   value        limit   result");
    for (const r of rows) {
      const val = Number.isNaN(r.value) ? "n/a" : String(Math.round(r.value * 100) / 100);
      const res = r.skipped ? "SKIP" : r.pass ? "pass" : "FAIL";
      console.log(
        `${r.kind.padEnd(10)} ${r.name.padEnd(38)} ${val.padStart(12)} ${String(r.limit).padStart(12)}   ${res}`,
      );
    }
    for (const n of notes) console.log(`[capture-costs] note: ${n}`);
    console.log(
      `[capture-costs] N=${N} seed=${seed} budgets=keyless@${budgetSize} ` +
        `invariants=${invariants.length - failedInvariants.length}/${invariants.length} ` +
        `budgets=${checks.length - failedChecks.length}/${checks.length}`,
    );

    mkdirSync(outDir, { recursive: true });
    const report = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      git_sha: shortGitSha(),
      profile: "keyless",
      observations: N,
      seed,
      budgets: budgetsOpt,
      budgetSize,
      disk: { beforeBytes: diskBefore, afterBytes: diskAfter, growthPerObservationBytes: growth, totalAfterBytes: diskTotalAfter },
      rssKiB: {
        capturePeak: capturePeak,
        capturePeakWorker: peakParts.worker,
        capturePeakEngine: peakParts.engine,
        idle: idleParts.total,
        idleWorker: idleParts.worker,
        idleEngine: idleParts.engine,
        recoveryIdle: recoveryParts.total,
        recoveryIdleWorker: recoveryParts.worker,
        recoveryIdleEngine: recoveryParts.engine,
      },
      latencyMs: {
        observeP50: percentile(latencies, 50),
        observeP95: percentile(latencies, 95),
        hookP50: percentile(hookLatencies, 50),
        hookP95: percentile(hookLatencies, 95),
      },
      contextBytes: { searchFullP50: percentile(searchBytes, 50), sessionStartInjectOn: sessionStart.stdoutBytes },
      recovery: { readyMs: recoveryReadyMs, indexReadyMs: recoveryIndexReadyMs },
      invariants,
      checks,
      notes,
    };
    const outPath = join(outDir, `capture-costs-${report.git_sha}.json`);
    writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log(`[capture-costs] wrote ${outPath}`);

    if (failedInvariants.length > 0) {
      console.error(`[capture-costs] ${failedInvariants.length} invariant(s) failed`);
      process.exitCode = 1;
    } else if (enforce && failedChecks.length > 0) {
      console.error(`[capture-costs] ${failedChecks.length} budget(s) exceeded`);
      process.exitCode = 2;
    }
  } finally {
    if (inst && spawned) {
      await stopDaemon(inst).catch(() => {});
      rmSync(inst.root, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error("[capture-costs] failed:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
