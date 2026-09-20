import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerPatternsFunction } from "../src/functions/patterns.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation, Session } from "../src/types.js";

function mockKV(store = new Map<string, Map<string, unknown>>()) {
  return {
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async () => {},
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function mockSdk() {
  const handlers = new Map<string, Function>();
  return {
    handlers,
    sdk: {
      registerFunction: (id: string, handler: Function) =>
        handlers.set(id, handler),
      registerTrigger: () => {},
      trigger: async () => ({}),
    },
  };
}

function session(id: string, startedAt: string, project = "demo"): Session {
  return {
    id,
    project,
    cwd: "/repo",
    startedAt,
    status: "completed",
    observationCount: 1,
  };
}

function obs(id: string, sessionId: string, files: string[]): CompressedObservation {
  return {
    id,
    sessionId,
    timestamp: "2026-09-01T00:00:00Z",
    type: "file_edit",
    title: `edit ${id}`,
    facts: [],
    narrative: "edited files",
    concepts: [],
    files,
    importance: 5,
  };
}

async function seed(
  sessions: Session[],
  perSession: (s: Session) => CompressedObservation[],
) {
  const store = new Map<string, Map<string, unknown>>();
  const sessionMap = new Map<string, unknown>();
  for (const s of sessions) {
    sessionMap.set(s.id, s);
    const observationMap = new Map<string, unknown>();
    for (const o of perSession(s)) observationMap.set(o.id, o);
    store.set(KV.observations(s.id), observationMap);
  }
  store.set(KV.sessions, sessionMap);
  return store;
}

async function run(
  store: Map<string, Map<string, unknown>>,
  payload: { project?: string; maxSessions?: number; sinceDays?: number },
) {
  const kv = mockKV(store);
  const { sdk, handlers } = mockSdk();
  registerPatternsFunction(sdk as never, kv as never);
  return handlers.get("mem::patterns")!(payload) as Promise<{
    patterns: Array<{ type: string; files: string[]; frequency: number }>;
    scannedSessions: number;
    totalSessions: number;
    truncated: {
      sessions: boolean;
      pairs: boolean;
      errors: boolean;
      files: boolean;
    };
  }>;
}

describe("mem::patterns bounds (#1226)", () => {
  it("still detects co-change patterns on a small corpus", async () => {
    const sessions = Array.from({ length: 3 }, (_, i) =>
      session(`ses_${i}`, `2026-09-0${i + 1}T00:00:00Z`),
    );
    const store = await seed(sessions, (s) => [
      obs(`o_${s.id}`, s.id, ["a.ts", "b.ts"]),
    ]);

    const result = await run(store, {});

    const coChange = result.patterns.find((p) => p.type === "co_change");
    expect(coChange).toBeDefined();
    expect(coChange!.frequency).toBe(3);
    expect(coChange!.files.sort()).toEqual(["a.ts", "b.ts"]);
    expect(result.scannedSessions).toBe(3);
    expect(result.truncated.sessions).toBe(false);
  });

  it("caps the session window at maxSessions, newest first", async () => {
    const sessions = Array.from({ length: 5 }, (_, i) =>
      session(`ses_${i}`, `2026-09-0${i + 1}T00:00:00Z`),
    );
    const store = await seed(sessions, (s) => [
      obs(`o_${s.id}`, s.id, ["a.ts", "b.ts"]),
    ]);

    const result = await run(store, { maxSessions: 2 });

    expect(result.scannedSessions).toBe(2);
    expect(result.totalSessions).toBe(5);
    expect(result.truncated.sessions).toBe(true);
  });

  it("bounds per-session files and file pairs instead of enumerating O(files^2)", async () => {
    const s = session("ses_wide", "2026-09-01T00:00:00Z");
    const files = Array.from({ length: 400 }, (_, i) => `src/f${i}.ts`);
    const store = await seed([s], () => [obs("o_wide", s.id, files)]);

    const result = await run(store, {});

    expect(result.truncated.files).toBe(true);
    expect(result.truncated.pairs).toBe(true);
    expect(result.patterns.length).toBeLessThanOrEqual(20);
  });

  it("filters sessions by sinceDays", async () => {
    const fresh = session("ses_fresh", new Date().toISOString());
    const old = session("ses_old", "2020-01-01T00:00:00Z");
    const store = await seed([fresh, old], (s) => [
      obs(`o_${s.id}`, s.id, ["a.ts", "b.ts"]),
    ]);

    const result = await run(store, { sinceDays: 7 });

    expect(result.scannedSessions).toBe(1);
    expect(result.totalSessions).toBe(1);
  });
});
