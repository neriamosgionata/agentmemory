import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";

const SECRET = "sessions-test-secret";

function mockKV(
  store = new Map<string, Map<string, unknown>>(),
  failScopes = new Set<string>(),
) {
  return {
    get: async () => null,
    set: async <T>(s: string, k: string, d: T) => {
      if (!store.has(s)) store.set(s, new Map());
      store.get(s)!.set(k, d);
      return d;
    },
    delete: async () => {},
    update: async () => {},
    list: async <T>(scope: string): Promise<T[]> => {
      if (failScopes.has(scope)) {
        throw new Error(`Invocation timeout after 10000ms: state::list ${scope}`);
      }
      return Array.from(store.get(scope)?.values() ?? []) as T[];
    },
    _store: store,
  };
}

function mockSdk() {
  const fns = new Map<string, Function>();
  return {
    registerFunction: (id: string, h: Function) => fns.set(id, h),
    registerTrigger: () => {},
    trigger: async (input: { function_id: string; payload?: unknown }) =>
      fns.get(input.function_id)?.(input.payload),
    _fns: fns,
  };
}

function session(id: string, agentId?: string) {
  return {
    id,
    project: "demo",
    ...(agentId !== undefined && { agentId }),
    startedAt: "2026-09-01T00:00:00Z",
  };
}

async function callSessions(
  sdk: ReturnType<typeof mockSdk>,
  query: Record<string, string> = {},
): Promise<{ status_code: number; body: Record<string, unknown> }> {
  const handler = sdk._fns.get("api::sessions")!;
  return handler({
    headers: { authorization: `Bearer ${SECRET}` },
    query_params: query,
  });
}

describe("api::sessions (#1326)", () => {
  it("returns sessions with summary and total", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "ses_1", session("ses_1"));
    await kv.set(KV.sessions, "ses_2", session("ses_2"));
    await kv.set(KV.summaries, "sum_1", {
      sessionId: "ses_1",
      narrative: "did things",
    });
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, kv as never, SECRET);

    const res = await callSessions(sdk);
    expect(res.status_code).toBe(200);
    expect((res.body["sessions"] as unknown[]).length).toBe(2);
    expect(res.body["total"]).toBe(2);
    const first = (res.body["sessions"] as Array<Record<string, unknown>>).find(
      (s) => s["id"] === "ses_1",
    );
    expect(first?.["summary"]).toEqual({
      sessionId: "ses_1",
      narrative: "did things",
    });
  });

  it("honours the limit param while reporting the unbounded total", async () => {
    const kv = mockKV();
    for (let i = 0; i < 5; i++) {
      await kv.set(KV.sessions, `ses_${i}`, session(`ses_${i}`));
    }
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, kv as never, SECRET);

    const res = await callSessions(sdk, { limit: "2" });
    expect(res.status_code).toBe(200);
    expect((res.body["sessions"] as unknown[]).length).toBe(2);
    expect(res.body["total"]).toBe(5);
  });

  it("rejects a malformed limit", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, kv as never, SECRET);

    const res = await callSessions(sdk, { limit: "abc" });
    expect(res.status_code).toBe(400);
  });

  it("returns a typed 503 instead of hanging when the sessions scope stalls", async () => {
    const kv = mockKV(new Map(), new Set([KV.sessions]));
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, kv as never, SECRET);

    const res = await callSessions(sdk);
    expect(res.status_code).toBe(503);
    expect(res.body["error"]).toBe("sessions_unavailable");
    expect(res.body["sessions"]).toEqual([]);
    expect(String(res.body["detail"])).toContain("state::list");
  });
});
