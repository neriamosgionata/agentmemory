import type { ISdk } from "../iii.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  SnapshotMeta,
  Session,
  Memory,
  GraphNode,
  AccessLogExport,
  SessionSummary,
  Lesson,
  Insight,
  SemanticMemory,
  ProceduralMemory,
  Crystal,
} from "../types.js";
import { KV, generateId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { recordAudit } from "./audit.js";
import { clearSessionDerivedState } from "./observation-lifecycle.js";
import { flushIndexSave, rebuildIndex } from "./search.js";
import { invalidateGraphCache } from "../state/graph-cache.js";
import { resetLessonIndex } from "./lessons.js";
import { VERSION } from "../version.js";
import { logger } from "../logger.js";

const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/i;

const execFileAsync = promisify(execFile);

async function gitExec(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: dir });
  return stdout.trim();
}

async function ensureGitRepo(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(join(dir, ".git"))) {
    await gitExec(dir, ["init"]);
    await gitExec(dir, ["config", "user.email", "agentmemory@local"]);
    await gitExec(dir, ["config", "user.name", "agentmemory"]);
  }
}

export function registerSnapshotFunction(
  sdk: ISdk,
  kv: StateKV,
  snapshotDir: string,
): void {
  // Serialize snapshots: the periodic timer, REST (api::snapshot-create), and
  // MCP can all trigger this concurrently. Two runs writing state.json and
  // committing in the same git repo at once race on the index lock. An
  // overlapping call is a no-op success; the winner captures current state.
  let snapshotInFlight = false;

  sdk.registerFunction("mem::snapshot-create",
    async (data?: { message?: string }) => {
      if (snapshotInFlight) {
        return { success: true, message: "Snapshot already in progress" };
      }
      snapshotInFlight = true;

      try {
        await ensureGitRepo(snapshotDir);
        const ts = new Date().toISOString();

        const sessions = await kv.list<Session>(KV.sessions);
        const memories = await kv.list<Memory>(KV.memories);
        const graphNodes = await kv.list<GraphNode>(KV.graphNodes);
        const accessLogs = await kv
          .list<AccessLogExport>(KV.accessLog)
          .catch(() => [] as AccessLogExport[]);

        const observations: Record<string, unknown[]> = {};
        for (const session of sessions) {
          const obs = await kv
            .list(KV.observations(session.id))
            .catch(() => []);
          if (obs.length > 0) {
            observations[session.id] = obs;
          }
        }

        // Durable stores. Without these, a restore silently dropped every
        // lesson/insight/semantic/procedural/crystal/summary written after
        // the snapshot even though the snapshot was advertised as full
        // state. #1190
        const [
          summaries,
          lessons,
          insights,
          semantic,
          procedural,
          crystals,
        ] = await Promise.all([
          kv.list<SessionSummary>(KV.summaries).catch(() => []),
          kv.list<Lesson>(KV.lessons).catch(() => []),
          kv.list<Insight>(KV.insights).catch(() => []),
          kv.list<SemanticMemory>(KV.semantic).catch(() => []),
          kv.list<ProceduralMemory>(KV.procedural).catch(() => []),
          kv.list<Crystal>(KV.crystals).catch(() => []),
        ]);

        const state = {
          version: VERSION,
          timestamp: ts,
          sessions,
          memories,
          graphNodes,
          observations,
          accessLogs,
          summaries,
          lessons,
          insights,
          semantic,
          procedural,
          crystals,
        };

        writeFileSync(
          join(snapshotDir, "state.json"),
          JSON.stringify(state, null, 2),
          "utf-8",
        );

        await gitExec(snapshotDir, ["add", "."]);

        const message = data?.message || `Snapshot ${ts}`;
        try {
          await gitExec(snapshotDir, ["commit", "-m", message]);
        } catch (commitErr) {
          const errMsg =
            commitErr instanceof Error ? commitErr.message : String(commitErr);
          if (errMsg.includes("nothing to commit")) {
            return { success: true, message: "No changes to snapshot" };
          }
          throw commitErr;
        }

        const commitHash = await gitExec(snapshotDir, ["rev-parse", "HEAD"]);

        const meta: SnapshotMeta = {
          id: generateId("snap"),
          commitHash,
          createdAt: ts,
          message,
          stats: {
            sessions: sessions.length,
            observations: Object.values(observations).reduce(
              (sum, arr) => sum + arr.length,
              0,
            ),
            memories: memories.length,
            graphNodes: graphNodes.length,
          },
        };

        await recordAudit(kv, "export", "mem::snapshot-create", [meta.id], {
          commitHash,
          stats: meta.stats,
        });

        logger.info("Snapshot created", { commitHash });
        return { success: true, snapshot: meta };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Snapshot failed", { error: msg });
        return { success: false, error: msg };
      } finally {
        snapshotInFlight = false;
      }
    },
  );

  sdk.registerFunction("mem::snapshot-list",  async () => {
    try {
      if (!existsSync(join(snapshotDir, ".git"))) {
        return { snapshots: [] };
      }
      const log = await gitExec(snapshotDir, [
        "log",
        "--format=%H|%aI|%s",
        "-20",
      ]);
      const snapshots = log
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const parts = line.split("|");
          const [hash, date] = parts;
          const msg = parts.slice(2).join("|");
          return { commitHash: hash, createdAt: date, message: msg };
        });
      return { snapshots };
    } catch {
      return { snapshots: [] };
    }
  });

  sdk.registerFunction("mem::snapshot-restore", 
    async (data: { commitHash: string } | undefined) => {
      if (!data || typeof data.commitHash !== "string" || !data.commitHash.trim()) {
        return { success: false, error: "commitHash is required" };
      }
      if (!COMMIT_HASH_RE.test(data.commitHash)) {
        return { success: false, error: "Invalid commitHash format" };
      }

      try {
        await gitExec(snapshotDir, [
          "checkout",
          data.commitHash,
          "--",
          "state.json",
        ]);
        const content = readFileSync(join(snapshotDir, "state.json"), "utf-8");
        const state = JSON.parse(content) as {
          sessions?: Array<{ id: string } & Record<string, unknown>>;
          memories?: Array<{ id: string } & Record<string, unknown>>;
          graphNodes?: Array<{ id: string } & Record<string, unknown>>;
          observations?: Record<
            string,
            Array<{ id: string } & Record<string, unknown>>
          >;
          accessLogs?: AccessLogExport[];
          summaries?: Array<{ sessionId: string } & Record<string, unknown>>;
          lessons?: Array<{ id: string } & Record<string, unknown>>;
          insights?: Array<{ id: string } & Record<string, unknown>>;
          semantic?: Array<{ id: string } & Record<string, unknown>>;
          procedural?: Array<{ id: string } & Record<string, unknown>>;
          crystals?: Array<{ id: string } & Record<string, unknown>>;
        };

        // A restore must reproduce the snapshot, not merge into the current
        // store: every scope the snapshot carries is cleared first so rows
        // written after the snapshot cannot survive it. #1190
        const replaceScope = async (
          scope: string,
          rows: Array<Record<string, unknown>>,
          keyOf: (row: Record<string, unknown>) => string,
        ): Promise<void> => {
          const existing = await kv
            .list<Record<string, unknown>>(scope)
            .catch(() => [] as Array<Record<string, unknown>>);
          for (const row of existing) {
            await kv.delete(scope, keyOf(row));
          }
          for (const row of rows) {
            await kv.set(scope, keyOf(row), row);
          }
        };

        const existingSessions = await kv
          .list<Session>(KV.sessions)
          .catch(() => [] as Session[]);
        for (const session of existingSessions) {
          const obs = await kv
            .list<{ id: string }>(KV.observations(session.id))
            .catch(() => [] as Array<{ id: string }>);
          for (const o of obs) {
            await kv.delete(KV.observations(session.id), o.id);
          }
          await clearSessionDerivedState(kv, session.id);
        }

        if (state.sessions) {
          await replaceScope(KV.sessions, state.sessions, (r) => String(r["id"]));
        }
        if (state.memories) {
          await replaceScope(KV.memories, state.memories, (r) => String(r["id"]));
        }
        if (state.graphNodes) {
          await replaceScope(KV.graphNodes, state.graphNodes, (r) =>
            String(r["id"]),
          );
        }
        if (state.observations) {
          for (const [sessionId, obs] of Object.entries(state.observations)) {
            for (const o of obs) {
              await kv.set(KV.observations(sessionId), o.id, o);
            }
          }
        }
        if (state.accessLogs) {
          await replaceScope(
            KV.accessLog,
            state.accessLogs as unknown as Array<Record<string, unknown>>,
            (r) => String(r["memoryId"]),
          );
        }
        if (state.summaries) {
          await replaceScope(KV.summaries, state.summaries, (r) =>
            String(r["sessionId"]),
          );
        }
        if (state.lessons) {
          await replaceScope(KV.lessons, state.lessons, (r) => String(r["id"]));
        }
        if (state.insights) {
          await replaceScope(KV.insights, state.insights, (r) => String(r["id"]));
        }
        if (state.semantic) {
          await replaceScope(KV.semantic, state.semantic, (r) => String(r["id"]));
        }
        if (state.procedural) {
          await replaceScope(KV.procedural, state.procedural, (r) =>
            String(r["id"]),
          );
        }
        if (state.crystals) {
          await replaceScope(KV.crystals, state.crystals, (r) => String(r["id"]));
        }

        // The search index and graph cache still describe the pre-restore
        // store. Rebuild the index from the restored KV and drop the cached
        // graph so search/graph reads cannot serve replaced-away rows.
        resetLessonIndex();
        try {
          await rebuildIndex(kv);
          await flushIndexSave();
        } catch (err) {
          logger.warn("Snapshot restore index rebuild failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        invalidateGraphCache(kv as unknown as object);

        await gitExec(snapshotDir, ["checkout", "HEAD", "--", "state.json"]);

        await recordAudit(kv, "import", "mem::snapshot-restore", [], {
          commitHash: data.commitHash,
          sessions: state.sessions?.length || 0,
          memories: state.memories?.length || 0,
          graphNodes: state.graphNodes?.length || 0,
        });

        logger.info("Snapshot restored", {
          commitHash: data.commitHash,
        });
        return { success: true, commitHash: data.commitHash };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Snapshot restore failed", { error: msg });
        return { success: false, error: msg };
      }
    },
  );
}
