import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";

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

function mockSdk() {
  const handlers = new Map<string, Function>();
  const extractCalls: Array<{ observations: unknown[] }> = [];
  return {
    handlers,
    extractCalls,
    sdk: {
      registerFunction: (id: string, h: Function) => handlers.set(id, h),
      registerTrigger: () => {},
      trigger: async (input: { function_id: string; payload?: unknown }) => {
        if (input.function_id === "mem::graph-extract") {
          extractCalls.push(input.payload as { observations: unknown[] });
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
});
