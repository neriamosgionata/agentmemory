import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { persistGraphDelta } from "../src/functions/graph.js";
import { withKeyedLock } from "../src/state/keyed-mutex.js";
import { KV } from "../src/state/schema.js";
import type { GraphNode } from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const setCalls = new Map<string, number>();
  return {
    store,
    setCalls,
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      setCalls.set(scope, (setCalls.get(scope) ?? 0) + 1);
      return data;
    },
    delete: async () => {},
    update: async () => {},
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
    setCallsFor(scope: string): number {
      return setCalls.get(scope) ?? 0;
    },
  };
}

function node(id: string): GraphNode {
  return {
    id,
    type: "concept",
    name: `concept-${id}`,
    properties: {},
    sourceObservationIds: ["obs_1"],
    createdAt: "2026-10-05T00:00:00Z",
  };
}

describe("persistGraphDelta snapshot safety (#1384, fork sync)", () => {
  it("serializes behind the graph:persist lock", async () => {
    const kv = mockKV();
    let release!: () => void;
    const held = withKeyedLock(
      "graph:persist",
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    let settled = false;
    const delta = persistGraphDelta(kv as never, [node("n1")], [], ["obs_1"]).then(
      () => {
        settled = true;
      },
    );

    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(settled).toBe(false);
    expect(kv.setCallsFor(KV.graphNodes)).toBe(0);

    release();
    await held;
    await delta;
    expect(settled).toBe(true);
    expect(kv.setCallsFor(KV.graphNodes)).toBe(1);
  });

  it("aborts without writing when the snapshot read keeps failing", async () => {
    const kv = mockKV();
    const originalGet = kv.get;
    kv.get = (async <T>(scope: string, key: string): Promise<T | null> => {
      if (scope === KV.graphSnapshot) throw new Error("engine unavailable");
      return originalGet<T>(scope, key);
    }) as typeof kv.get;

    await expect(
      persistGraphDelta(kv as never, [node("n1")], [], ["obs_1"]),
    ).rejects.toThrow("engine unavailable");
    expect(kv.setCallsFor(KV.graphNodes)).toBe(0);
    expect(kv.setCallsFor(KV.graphSnapshot)).toBe(0);
  });

  it("aborts on an unknown snapshot schema version instead of zeroing it", async () => {
    const kv = mockKV();
    storeSnapshot(kv, { version: 99, stats: { totalNodes: 5 } });

    await expect(
      persistGraphDelta(kv as never, [node("n1")], [], ["obs_1"]),
    ).rejects.toThrow(/unknown schema version/);
    expect(kv.setCallsFor(KV.graphNodes)).toBe(0);
    expect(kv.setCallsFor(KV.graphSnapshot)).toBe(0);
  });

  it("merges onto an existing snapshot and persists the delta", async () => {
    const kv = mockKV();
    const fresh = mockKV();
    await persistGraphDelta(fresh as never, [node("n0")], [], ["obs_0"]);
    const snapshot = fresh.store.get(KV.graphSnapshot)?.get("current");
    kv.store.set(KV.graphSnapshot, new Map([["current", snapshot]]));

    const result = await persistGraphDelta(
      kv as never,
      [node("n1")],
      [],
      ["obs_1"],
    );
    expect(result.newNodeCount).toBe(1);
    const saved = kv.store.get(KV.graphSnapshot)!.get("current") as {
      stats: { totalNodes: number };
    };
    expect(saved.stats.totalNodes).toBe(2);
  });
});

function storeSnapshot(kv: ReturnType<typeof mockKV>, value: unknown): void {
  kv.store.set(KV.graphSnapshot, new Map([["current", value]]));
}
