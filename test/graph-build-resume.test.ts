import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";
import {
  enableLlmActivityGateFor,
  trackLlmCall,
  __resetLlmActivity,
} from "../src/providers/llm-activity.js";

const SECRET = "graph-build-secret";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
    get: async () => null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async () => {},
    update: async () => {},
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function mockSdk(options: { failures?: number; mode?: "throw" | "success-false" } = {}) {
  const handlers = new Map<string, Function>();
  const extractCalls: Array<{ observations: unknown[] }> = [];
  let failuresLeft = options.failures ?? 0;
  return {
    handlers,
    extractCalls,
    sdk: {
      registerFunction: (id: string, h: Function) => handlers.set(id, h),
      registerTrigger: () => {},
      trigger: async (input: { function_id: string; payload?: unknown }) => {
        if (input.function_id === "mem::graph-extract") {
          extractCalls.push(input.payload as { observations: unknown[] });
          if (failuresLeft > 0) {
            failuresLeft--;
            if (options.mode === "throw") throw new Error("invocation timed out after 180000ms");
            return { success: false, error: "LLM graph extraction failed" };
          }
          return { success: true, nodesAdded: 1, edgesAdded: 0 };
        }
        return {};
      },
    },
  };
}

function observation(id: string, sessionId: string) {
  return {
    id,
    sessionId,
    timestamp: "2026-09-20T00:00:00Z",
    type: "file_edit",
    title: `edit ${id}`,
    facts: [],
    narrative: "edited a file",
    concepts: [],
    files: ["src/a.ts"],
    importance: 5,
  };
}

async function seed(kv: ReturnType<typeof mockKV>, sessionCount: number, obsPerSession: number) {
  for (let s = 0; s < sessionCount; s++) {
    const sid = `ses_${s}`;
    await kv.set(KV.sessions, sid, {
      id: sid,
      project: "demo",
      cwd: "/repo",
      startedAt: "2026-09-20T00:00:00Z",
      status: "completed",
      observationCount: obsPerSession,
    });
    for (let o = 0; o < obsPerSession; o++) {
      await kv.set(KV.observations(sid), `o_${s}_${o}`, observation(`o_${s}_${o}`, sid));
    }
  }
}

async function callBuild(
  handlers: Map<string, Function>,
  body: Record<string, unknown>,
) {
  const handler = handlers.get("api::graph-build")!;
  return handler({
    headers: { authorization: `Bearer ${SECRET}` },
    body,
  }) as Promise<{ status_code: number; body: Record<string, unknown> }>;
}

describe("api::graph-build resumable windows (#1339)", () => {
  it("processes only maxSessions and reports the continuation offset", async () => {
    const kv = mockKV();
    await seed(kv, 5, 1);
    const { sdk, handlers, extractCalls } = mockSdk();
    registerApiTriggers(sdk as never, kv as never, SECRET);

    const first = await callBuild(handlers, { maxSessions: 2 });
    expect(first.status_code).toBe(200);
    expect(first.body["processedSessions"]).toBe(2);
    expect(first.body["nextOffset"]).toBe(2);
    expect(first.body["hasMore"]).toBe(true);
    expect(String(first.body["hint"])).toContain("offset=2");
    expect(extractCalls).toHaveLength(2);

    const second = await callBuild(handlers, { maxSessions: 2, offset: 2 });
    expect(second.body["processedSessions"]).toBe(2);
    expect(second.body["nextOffset"]).toBe(4);
    expect(second.body["hasMore"]).toBe(true);

    const third = await callBuild(handlers, { maxSessions: 2, offset: 4 });
    expect(third.body["processedSessions"]).toBe(1);
    expect(third.body["hasMore"]).toBe(false);
    expect(third.body["hint"]).toBeUndefined();
    expect(extractCalls).toHaveLength(5);
  });

  it("still batches observations per session", async () => {
    const kv = mockKV();
    await seed(kv, 1, 5);
    const { sdk, handlers, extractCalls } = mockSdk();
    registerApiTriggers(sdk as never, kv as never, SECRET);

    const res = await callBuild(handlers, { batchSize: 2, maxSessions: 1 });

    expect(res.body["batches"]).toBe(3);
    expect(extractCalls.map((c) => c.observations.length)).toEqual([2, 2, 1]);
  });

  it("resumes a partially processed session via batchOffset", async () => {
    const kv = mockKV();
    await seed(kv, 1, 5);
    const { sdk, handlers, extractCalls } = mockSdk();
    registerApiTriggers(sdk as never, kv as never, SECRET);

    const resume = await callBuild(handlers, {
      batchSize: 2,
      maxSessions: 1,
      offset: 0,
      batchOffset: 2,
    });

    expect(resume.body["batches"]).toBe(2);
    expect(resume.body["nextOffset"]).toBe(1);
    expect(resume.body["nextBatchOffset"]).toBe(0);
    expect(resume.body["hasMore"]).toBe(false);
    expect(extractCalls.map((c) => c.observations.length)).toEqual([2, 1]);
  });

  it("returns a mid-session resume point when the budget is exhausted", async () => {
    const kv = mockKV();
    await seed(kv, 1, 4);
    const { sdk, handlers } = mockSdk();
    registerApiTriggers(sdk as never, kv as never, SECRET);

    const realNow = Date.now;
    let calls = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => {
      calls++;
      return calls <= 3 ? realNow() : realNow() + 120_000;
    });
    const res = await callBuild(handlers, {
      batchSize: 1,
      maxSessions: 1,
      offset: 0,
    });
    spy.mockRestore();

    expect(res.body["budgetExceeded"]).toBe(true);
    expect(res.body["nextOffset"]).toBe(0);
    expect(res.body["nextBatchOffset"]).toBe(1);
    expect(res.body["hasMore"]).toBe(true);
    expect(String(res.body["hint"])).toContain("batchOffset=1");
  });

  it("keeps the cursor on a failed batch so the next call retries it", async () => {
    const kv = mockKV();
    await seed(kv, 1, 4);
    const { sdk, handlers, extractCalls } = mockSdk({ failures: 1 });
    registerApiTriggers(sdk as never, kv as never, SECRET);

    const first = await callBuild(handlers, { batchSize: 2, maxSessions: 1 });
    expect(first.body["nextOffset"]).toBe(0);
    expect(first.body["nextBatchOffset"]).toBe(0);
    expect(first.body["hasMore"]).toBe(true);
    expect(first.body["skippedBatches"]).toBe(0);
    expect(extractCalls).toHaveLength(1);

    const second = await callBuild(handlers, {
      batchSize: 2,
      maxSessions: 1,
      offset: 0,
      batchOffset: 0,
    });
    expect(second.body["nextOffset"]).toBe(1);
    expect(second.body["nextBatchOffset"]).toBe(0);
    expect(second.body["hasMore"]).toBe(false);
    expect(second.body["skippedBatches"]).toBe(0);
    expect(extractCalls).toHaveLength(3);
  });

  it("skips a batch only after three consecutive failed attempts", async () => {
    const kv = mockKV();
    await seed(kv, 1, 2);
    const { sdk, handlers, extractCalls } = mockSdk({ failures: 3, mode: "throw" });
    registerApiTriggers(sdk as never, kv as never, SECRET);

    const first = await callBuild(handlers, { batchSize: 1, maxSessions: 1 });
    expect(first.body["nextBatchOffset"]).toBe(0);
    expect(first.body["hasMore"]).toBe(true);

    const second = await callBuild(handlers, { batchSize: 1, maxSessions: 1 });
    expect(second.body["nextBatchOffset"]).toBe(0);
    expect(second.body["hasMore"]).toBe(true);
    expect(second.body["skippedBatches"]).toBe(0);

    const third = await callBuild(handlers, { batchSize: 1, maxSessions: 1 });
    expect(third.body["skippedBatches"]).toBe(1);
    expect(third.body["nextOffset"]).toBe(1);
    expect(third.body["hasMore"]).toBe(false);
    expect(extractCalls).toHaveLength(4);
  });

  it("parks the drain with an unchanged cursor while interactive LLM work keeps the endpoint busy", async () => {
    const kv = mockKV();
    await seed(kv, 1, 2);
    const { sdk, handlers, extractCalls } = mockSdk();
    registerApiTriggers(sdk as never, kv as never, SECRET);
    process.env["AGENTMEMORY_LLM_IDLE_GAP_MS"] = "5000";
    process.env["AGENTMEMORY_LLM_IDLE_MAX_WAIT_MS"] = "120";
    enableLlmActivityGateFor("http://127.0.0.1:11434/v1");
    let release!: () => void;
    const inFlight = trackLlmCall(
      () => new Promise<void>((r) => { release = r; }),
    );
    try {
      const res = await callBuild(handlers, { batchSize: 1, maxSessions: 1 });

      expect(res.body["batches"]).toBe(0);
      expect(res.body["budgetExceeded"]).toBe(false);
      expect(res.body["pausedForLlmIdle"]).toBe(true);
      expect(res.body["hasMore"]).toBe(true);
      expect(res.body["nextOffset"]).toBe(0);
      expect(res.body["nextBatchOffset"]).toBe(0);
      expect(extractCalls).toHaveLength(0);
    } finally {
      release();
      await inFlight;
      delete process.env["AGENTMEMORY_LLM_IDLE_GAP_MS"];
      delete process.env["AGENTMEMORY_LLM_IDLE_MAX_WAIT_MS"];
      __resetLlmActivity();
    }
  });

  it("resumes the drain once the endpoint is idle again", async () => {
    const kv = mockKV();
    await seed(kv, 1, 2);
    const { sdk, handlers, extractCalls } = mockSdk();
    registerApiTriggers(sdk as never, kv as never, SECRET);
    process.env["AGENTMEMORY_LLM_IDLE_GAP_MS"] = "0";
    process.env["AGENTMEMORY_LLM_IDLE_MAX_WAIT_MS"] = "120";
    enableLlmActivityGateFor("http://127.0.0.1:11434/v1");
    try {
      const res = await callBuild(handlers, { batchSize: 1, maxSessions: 1 });

      expect(res.body["batches"]).toBe(2);
      expect(res.body["hasMore"]).toBe(false);
      expect(extractCalls).toHaveLength(2);
    } finally {
      delete process.env["AGENTMEMORY_LLM_IDLE_GAP_MS"];
      delete process.env["AGENTMEMORY_LLM_IDLE_MAX_WAIT_MS"];
      __resetLlmActivity();
    }
  });

  it("returns a 500 error body instead of a completion-looking one when the build throws", async () => {
    const kv = mockKV();
    await seed(kv, 1, 1);
    const broken = {
      ...kv,
      list: async () => {
        throw new Error("state worker unavailable");
      },
    };
    const { sdk, handlers } = mockSdk();
    registerApiTriggers(sdk as never, broken as never, SECRET);

    const res = await callBuild(handlers, { maxSessions: 1 });

    expect(res.status_code).toBe(500);
    expect(res.body["success"]).toBe(false);
    expect(res.body["hasMore"]).toBeUndefined();
    expect(res.body["nextOffset"]).toBeUndefined();
  });
});
