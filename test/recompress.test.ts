import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/functions/audit.js", () => ({
  recordAudit: vi.fn().mockResolvedValue(undefined),
}));

import { registerRecompressFunction } from "../src/functions/recompress.js";
import { KV } from "../src/state/schema.js";
import type { RawObservation, Session } from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
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

function mockSdk(compressResult: { success: boolean } = { success: true }) {
  const calls: Array<{ function_id: string; payload: unknown }> = [];
  const handlers = new Map<string, Function>();
  return {
    calls,
    handlers,
    sdk: {
      registerFunction: (id: string, handler: Function) => {
        handlers.set(id, handler);
      },
      trigger: async (input: { function_id: string; payload: unknown }) => {
        calls.push(input);
        if (input.function_id === "mem::compress") return compressResult;
        return {};
      },
    },
  };
}

function session(id: string): Session {
  return {
    id,
    project: "demo",
    cwd: "/repo",
    startedAt: "2026-09-01T00:00:00Z",
    status: "completed",
    observationCount: 1,
  };
}

function rawObs(id: string, sessionId: string): RawObservation {
  return {
    id,
    sessionId,
    timestamp: "2026-09-01T00:00:00Z",
    hookType: "post_tool_use",
    toolName: "Edit",
    raw: {},
  };
}

function compressedObs(id: string, sessionId: string) {
  return {
    id,
    sessionId,
    timestamp: "2026-09-01T00:00:00Z",
    type: "file_edit" as const,
    title: "Already compressed",
    facts: [],
    narrative: "Nothing to do.",
    concepts: [],
    files: [],
    importance: 5,
  };
}

async function registerAndRun(
  kv: ReturnType<typeof mockKV>,
  sdk: ReturnType<typeof mockSdk>["sdk"],
  handlers: Map<string, Function>,
  payload?: { sessionId?: string; limit?: number },
) {
  registerRecompressFunction(sdk as never, kv as never);
  return handlers.get("mem::recompress")!(payload);
}

describe("mem::recompress (#1228)", () => {
  it("re-runs compression only for raw observations", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "ses_1", session("ses_1"));
    await kv.set(KV.observations("ses_1"), "obs_raw", rawObs("obs_raw", "ses_1"));
    await kv.set(
      KV.observations("ses_1"),
      "obs_done",
      compressedObs("obs_done", "ses_1"),
    );
    const { sdk, calls, handlers } = mockSdk();

    const result = (await registerAndRun(kv, sdk, handlers)) as {
      attempted: number;
      recovered: number;
      failed: number;
    };

    expect(result.attempted).toBe(1);
    expect(result.recovered).toBe(1);
    expect(result.failed).toBe(0);
    expect(calls.map((c) => c.function_id)).toEqual(["mem::compress"]);
    expect((calls[0].payload as { observationId: string }).observationId).toBe(
      "obs_raw",
    );
  });

  it("counts a failed compress instead of claiming recovery", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "ses_1", session("ses_1"));
    await kv.set(KV.observations("ses_1"), "obs_raw", rawObs("obs_raw", "ses_1"));
    const { sdk, handlers } = mockSdk({ success: false });

    const result = (await registerAndRun(kv, sdk, handlers)) as {
      attempted: number;
      recovered: number;
      failed: number;
    };

    expect(result.attempted).toBe(1);
    expect(result.recovered).toBe(0);
    expect(result.failed).toBe(1);
  });

  it("honours the limit and reports that more work remains", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "ses_1", session("ses_1"));
    for (let i = 0; i < 5; i++) {
      await kv.set(
        KV.observations("ses_1"),
        `obs_${i}`,
        rawObs(`obs_${i}`, "ses_1"),
      );
    }
    const { sdk, calls, handlers } = mockSdk();

    const result = (await registerAndRun(kv, sdk, handlers, { limit: 2 })) as {
      attempted: number;
      limitReached: boolean;
      hint?: string;
    };

    expect(result.attempted).toBe(2);
    expect(result.limitReached).toBe(true);
    expect(result.hint).toContain("call again");
    expect(calls).toHaveLength(2);
  });

  it("scopes to one session when sessionId is given", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "ses_a", session("ses_a"));
    await kv.set(KV.sessions, "ses_b", session("ses_b"));
    await kv.set(KV.observations("ses_a"), "obs_a", rawObs("obs_a", "ses_a"));
    await kv.set(KV.observations("ses_b"), "obs_b", rawObs("obs_b", "ses_b"));
    const { sdk, calls, handlers } = mockSdk();

    const result = (await registerAndRun(kv, sdk, handlers, { sessionId: "ses_b" })) as {
      sessionsScanned: number;
      attempted: number;
    };

    expect(result.sessionsScanned).toBe(1);
    expect(result.attempted).toBe(1);
    expect((calls[0].payload as { observationId: string }).observationId).toBe(
      "obs_b",
    );
  });
});
