import type { ISdk } from "../iii.js";
import type { CompressedObservation, Session } from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { logger } from "../logger.js";

interface Pattern {
  type: "co_change" | "error_repeat" | "workflow";
  description: string;
  files: string[];
  frequency: number;
  sessions: string[];
}

// #1226: mem::patterns used to walk every observation in the store and
// enumerate O(files²) pairs per session with no cap, so memory_patterns
// 500'd "Invocation stopped" and dropped the worker on moderate stores.
// Every accumulation now has a ceiling and the session window is bounded.
const DEFAULT_MAX_SESSIONS = 100;
const MAX_SESSIONS = 500;
const MAX_FILES_PER_SESSION = 200;
const MAX_PAIRS_PER_SESSION = 2_000;
const MAX_PAIR_ENTRIES = 50_000;
const MAX_ERROR_KEYS = 5_000;

function clampInt(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const whole = Math.floor(value);
  if (whole < 1) return fallback;
  return Math.min(whole, max);
}

export function registerPatternsFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::patterns", 
    async (data: { project?: string; maxSessions?: number; sinceDays?: number }) => {
      const patterns: Pattern[] = [];

      const sessions = await kv.list<Session>(KV.sessions);
      let filtered = data.project
        ? sessions.filter((s) => s.project === data.project)
        : sessions;

      const sinceDays =
        typeof data.sinceDays === "number" && Number.isFinite(data.sinceDays)
          ? Math.floor(data.sinceDays)
          : undefined;
      if (sinceDays !== undefined && sinceDays > 0) {
        const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
        filtered = filtered.filter(
          (s) => s.startedAt && new Date(s.startedAt).getTime() >= cutoff,
        );
      }

      // Newest first, then bound: a corpus with thousands of sessions must
      // not fan out one kv.list per session.
      filtered.sort((a, b) =>
        (b.startedAt ?? "").localeCompare(a.startedAt ?? ""),
      );
      const maxSessions = clampInt(
        data.maxSessions,
        DEFAULT_MAX_SESSIONS,
        MAX_SESSIONS,
      );
      const sessionsTruncated = filtered.length > maxSessions;
      const selected = filtered.slice(0, maxSessions);

      const fileCoOccurrences = new Map<string, number>();
      const fileSessionMap = new Map<string, Set<string>>();
      const errorPatterns = new Map<
        string,
        { count: number; sessions: Set<string> }
      >();

      let pairsTruncated = false;
      let errorsTruncated = false;
      let filesTruncated = false;

      // Bounded fan-out: load observations for up to 10 sessions in
      // parallel per batch (like consolidate), then fold each session's
      // observations into the shared maps serially so the accumulation
      // stays race-free. Parallelizing the kv.list I/O without exceeding
      // the invocation pool cuts wall time versus the old serial loop.
      for (let batch = 0; batch < selected.length; batch += 10) {
        const chunk = selected.slice(batch, batch + 10);
        const loaded = await Promise.all(
          chunk.map(async (session) => ({
            session,
            observations: await kv.list<CompressedObservation>(
              KV.observations(session.id),
            ),
          })),
        );

        for (const { session, observations } of loaded) {
          if (!observations.length) continue;

          const sessionFiles = new Set<string>();
          for (const obs of observations) {
            if (!obs.files) continue;
            for (const f of obs.files) {
              sessionFiles.add(f);
              if (!fileSessionMap.has(f)) fileSessionMap.set(f, new Set());
              fileSessionMap.get(f)!.add(session.id);
            }

            if (obs.type === "error" && obs.title) {
              const key = obs.title.toLowerCase();
              if (!errorPatterns.has(key)) {
                if (errorPatterns.size >= MAX_ERROR_KEYS) {
                  errorsTruncated = true;
                  continue;
                }
                errorPatterns.set(key, { count: 0, sessions: new Set() });
              }
              const ep = errorPatterns.get(key)!;
              ep.count++;
              ep.sessions.add(session.id);
            }
          }

          const allFiles = [...sessionFiles].sort();
          const fileList =
            allFiles.length > MAX_FILES_PER_SESSION
              ? allFiles.slice(0, MAX_FILES_PER_SESSION)
              : allFiles;
          if (allFiles.length > MAX_FILES_PER_SESSION) filesTruncated = true;

          let sessionPairs = 0;
          pairLoop: for (let i = 0; i < fileList.length; i++) {
            for (let j = i + 1; j < fileList.length; j++) {
              if (sessionPairs >= MAX_PAIRS_PER_SESSION) {
                pairsTruncated = true;
                break pairLoop;
              }
              const pair = `${fileList[i]}::${fileList[j]}`;
              if (
                !fileCoOccurrences.has(pair) &&
                fileCoOccurrences.size >= MAX_PAIR_ENTRIES
              ) {
                pairsTruncated = true;
                break pairLoop;
              }
              fileCoOccurrences.set(
                pair,
                (fileCoOccurrences.get(pair) || 0) + 1,
              );
              sessionPairs++;
            }
          }
        }
      }

      for (const [pair, count] of fileCoOccurrences) {
        if (count < 3) continue;
        const [fileA, fileB] = pair.split("::");
        const sessionsA = fileSessionMap.get(fileA) || new Set();
        const sessionsB = fileSessionMap.get(fileB) || new Set();
        const commonSessions = [...sessionsA].filter((s) => sessionsB.has(s));

        patterns.push({
          type: "co_change",
          description: `${fileA} and ${fileB} are frequently modified together`,
          files: [fileA, fileB],
          frequency: count,
          sessions: commonSessions,
        });
      }

      for (const [
        errorKey,
        { count, sessions: errorSessions },
      ] of errorPatterns) {
        if (count < 2) continue;
        patterns.push({
          type: "error_repeat",
          description: `Recurring error: ${errorKey}`,
          files: [],
          frequency: count,
          sessions: [...errorSessions],
        });
      }

      patterns.sort((a, b) => b.frequency - a.frequency);

      logger.info("Pattern detection complete", {
        patterns: patterns.length,
        sessions: selected.length,
        totalSessions: filtered.length,
        truncated:
          sessionsTruncated || pairsTruncated || errorsTruncated || filesTruncated,
      });

      return {
        patterns: patterns.slice(0, 20),
        scannedSessions: selected.length,
        totalSessions: filtered.length,
        truncated: {
          sessions: sessionsTruncated,
          pairs: pairsTruncated,
          errors: errorsTruncated,
          files: filesTruncated,
        },
      };
    },
  );

  sdk.registerFunction("mem::generate-rules", 
    async (data: { project?: string; maxSessions?: number; sinceDays?: number }) => {
      const result = await sdk.trigger<
        { project?: string; maxSessions?: number; sinceDays?: number },
        { patterns: Pattern[] }
      >({ function_id: "mem::patterns", payload: data });

      const rules: string[] = [];

      for (const pattern of result.patterns) {
        if (pattern.type === "co_change" && pattern.frequency >= 4) {
          rules.push(
            `When modifying ${pattern.files[0]}, also check ${pattern.files[1]} (co-changed ${pattern.frequency} times).`,
          );
        }
        if (pattern.type === "error_repeat" && pattern.frequency >= 3) {
          rules.push(
            `Watch for: ${pattern.description} (occurred ${pattern.frequency} times across ${pattern.sessions.length} sessions).`,
          );
        }
      }

      logger.info("Rules generated", { count: rules.length });
      return { rules };
    },
  );
}
