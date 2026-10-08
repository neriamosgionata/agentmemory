// Origin: upstream #1463 (scripts/release-gate/run.mjs). Adapted to the fork:
// single-package packed layout (dist/cli.mjs + dist/hooks), compose-style
// --instance isolation, generated-secret auth. Covers the install/capture/
// offline slice as a fast unit-suite smoke; the full matrix lives in
// benchmark/capture-costs.ts.
import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");
const DIST_CLI = join(REPO, "dist", "cli.mjs");
const PACKED_HOOK = join(REPO, "dist", "hooks", "post-tool-use.mjs");
const SHARED_CAPTURE = join(REPO, "plugin", "scripts", "_capture.mjs");

function runCli(args: string[]): { exit: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [DIST_CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return { exit: r.status, stdout: r.stdout as string, stderr: r.stderr as string };
}

function runPackedHook(
  stdin: string,
  env: Record<string, string>,
): Promise<{ exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PACKED_HOOK], {
      env: { PATH: process.env["PATH"] ?? "", HOME: tmpdir(), ...env },
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode }));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

function toolPayload(marker: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "ses_release_gate",
    cwd: "/work/gate-proj",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: `echo ${marker}` },
    tool_response: { stdout: marker },
    ...extra,
  });
}

function spoolRecords(dir: string, port: number): Array<Record<string, unknown>> {
  const file = join(dir, `local-${port}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

describe("release gate (packed artifact)", () => {
  it("ships the packed CLI and the bundled capture hooks", () => {
    for (const f of [DIST_CLI, PACKED_HOOK, SHARED_CAPTURE]) {
      expect(existsSync(f), `packed file missing: ${f}`).toBe(true);
    }
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
      bin: Record<string, string>;
      files: string[];
    };
    expect(pkg.bin["agentmemory"]).toBe("dist/cli.mjs");
    expect(pkg.files).toContain("dist/");
    expect(pkg.files).toContain("plugin/");
  });

  it("packed CLI reports identity and the capture surface", () => {
    const help = runCli(["--help"]);
    expect(help.exit).toBe(0);
    expect(help.stdout).toContain("agentmemory");
    expect(help.stdout).toContain("capture");
    expect(help.stdout).toContain("--instance");
    expect(help.stdout).toContain("mcp");
  });

  it("packed CLI answers capture health without a daemon", () => {
    const r = runCli(["capture", "--json"]);
    expect(r.exit).toBe(0);
    const body = JSON.parse(r.stdout) as { spool: { enabled: boolean } };
    expect(body.spool.enabled).toBe(true);
  });

  it("packed hook captures offline and recovers the spool on restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "am-gate-spool-"));
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
    const addr = probe.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const env = {
      AGENTMEMORY_URL: `http://127.0.0.1:${port}`,
      AGENTMEMORY_CAPTURE_SPOOL_DIR: dir,
    };
    const marker = `gatecapture${Date.now().toString(36)}`;
    expect((await runPackedHook(toolPayload(marker), env)).exitCode).toBe(0);
    const spooled = spoolRecords(dir, port);
    expect(spooled).toHaveLength(1);
    expect(JSON.stringify(spooled[0])).toContain(marker);
    const spooledEvent = spooled[0]!["eventId"];

    const received: Array<Record<string, unknown>> = [];
    let server: Server | undefined = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          received.push(JSON.parse(body));
        } catch {}
        res.writeHead(201, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => server!.listen(port, "127.0.0.1", () => resolve()));
    try {
      expect((await runPackedHook(toolPayload(`gatebackonline${Date.now().toString(36)}`), env)).exitCode).toBe(0);
      expect(await waitFor(() => received.some((r) => r["eventId"] === spooledEvent), 8000)).toBe(true);
      expect(await waitFor(() => spoolRecords(dir, port).length === 0, 3000)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  }, 60_000);
});
