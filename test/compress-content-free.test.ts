import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerCompressFunction } from "../src/functions/compress.js";
import { KV } from "../src/state/schema.js";
import type { MemoryProvider, RawObservation } from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
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
    _store: store,
  };
}

function contentFreeRaw(): RawObservation {
  return {
    id: "obs_empty",
    sessionId: "ses_1",
    timestamp: "2026-09-01T00:00:00Z",
    hookType: "post_tool_use",
    raw: {},
  };
}

async function run(raw: RawObservation) {
  const kv = mockKV();
  const provider: MemoryProvider = {
    name: "test",
    compress: vi.fn().mockResolvedValue("<title>should not be used</title>"),
    summarize: vi.fn().mockResolvedValue(""),
  };
  let handler: Function | null = null;
  const sdk = {
    registerFunction: (id: string, h: Function) => {
      if (id === "mem::compress") handler = h;
    },
    registerTrigger: () => {},
    trigger: vi.fn().mockResolvedValue(undefined),
  };
  registerCompressFunction(sdk as never, kv as never, provider as never);

  const result = await handler!({
    observationId: raw.id,
    sessionId: raw.sessionId,
    raw,
  });
  return { result, provider, kv };
}

describe("mem::compress content-free payloads (#1270)", () => {
  it("does not call the LLM when the observation has no content", async () => {
    const { result, provider, kv } = await run(contentFreeRaw());

    expect(provider.compress).not.toHaveBeenCalled();
    expect(provider.summarize).not.toHaveBeenCalled();
    expect((result as { success: boolean }).success).toBe(true);
    const stored = await kv.get<{ title: string }>(KV.observations("ses_1"), "obs_empty");
    expect(stored?.title).toBe("post_tool_use");
  });

  it("still calls the LLM when there is content", async () => {
    const raw = { ...contentFreeRaw(), toolOutput: "wrote 12 lines to src/a.ts" };
    const { provider } = await run(raw);
    expect(provider.compress).toHaveBeenCalled();
  });
});
