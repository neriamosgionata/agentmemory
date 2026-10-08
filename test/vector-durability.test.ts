import { describe, it, expect, afterEach, vi } from "vitest";
import { IndexPersistence } from "../src/state/index-persistence.js";
import { SearchIndex } from "../src/state/search-index.js";
import { VectorIndex } from "../src/state/vector-index.js";
import {
  backfillMissingVectors,
  collectMissingVectorJobs,
  getSearchIndex,
  setEmbeddingProvider,
  setIndexPersistence,
  setVectorIndex,
} from "../src/functions/search.js";
import type {
  CompressedObservation,
  EmbeddingProvider,
  Memory,
  Session,
} from "../src/types.js";

const PENDING_SCOPE = "mem:index:vec-pending";
const INDEX_SCOPE = "mem:index:bm25";
const VECTOR_BUCKET_SCOPE = "mem:index:bm25:vectors:v2";

function mockKV(options: { shuffle?: boolean } = {}) {
  const store = new Map<string, Map<string, unknown>>();
  const ops: Array<{ op: "set" | "delete" | "list"; scope: string; key?: string }> =
    [];
  return {
    store,
    ops,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      ops.push({ op: "set", scope, key });
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, JSON.parse(JSON.stringify(data)));
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      ops.push({ op: "delete", scope, key });
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      ops.push({ op: "list", scope });
      const rows = Array.from(store.get(scope)?.values() ?? []);
      if (options.shuffle) rows.reverse();
      return rows as T[];
    },
  };
}

type MockKV = ReturnType<typeof mockKV>;

function v(seed: number): Float32Array {
  return new Float32Array([seed, seed + 0.5, seed + 1]);
}

function pendingRows(kv: MockKV): Map<string, Record<string, unknown>> {
  return (kv.store.get(PENDING_SCOPE) ??
    new Map()) as Map<string, Record<string, unknown>>;
}

async function boot(
  kv: MockKV,
  dims = 3,
): Promise<{ vector: VectorIndex; persistence: IndexPersistence }> {
  const vector = new VectorIndex();
  const persistence = new IndexPersistence(
    kv as never,
    new SearchIndex(),
    vector,
  );
  const loaded = await persistence.load();
  if (loaded.vector && loaded.vector.size > 0)
    vector.restoreFrom(loaded.vector);
  await persistence.replayPendingLog(dims);
  return { vector, persistence };
}

function stopAll(...persistences: IndexPersistence[]): void {
  for (const p of persistences) {
    p.stop();
    void p.flushPendingLog().catch(() => {});
  }
}

describe("vector durability: kill-and-restart against fork buckets", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("loses nothing committed after the last snapshot once replayed", async () => {
    const kv = mockKV();
    const first = await boot(kv);
    first.vector.add("obs_1", "ses_1", v(1));
    first.vector.add("obs_2", "ses_1", v(2));
    await first.persistence.save();
    expect(pendingRows(kv).size).toBe(0);

    first.vector.add("obs_3", "ses_1", v(3));
    first.vector.add("obs_4", "ses_1", v(4));
    first.vector.remove("obs_1");
    await first.persistence.flushPendingLog();
    first.persistence.stop();

    const second = await boot(kv);
    expect([...second.vector.entries()].map(([id]) => id).sort()).toEqual([
      "obs_2",
      "obs_3",
      "obs_4",
    ]);
    expect(
      Array.from(second.vector.get("obs_3")!.embedding),
    ).toEqual(Array.from(v(3)));

    await second.persistence.save();
    expect(pendingRows(kv).size).toBe(0);
    const third = await boot(kv);
    expect([...third.vector.entries()].map(([id]) => id).sort()).toEqual([
      "obs_2",
      "obs_3",
      "obs_4",
    ]);
    stopAll(first.persistence, second.persistence, third.persistence);
  });

  it("writes a compact entry per add and a tombstone per removal", async () => {
    const kv = mockKV();
    const vector = new VectorIndex();
    const persistence = new IndexPersistence(
      kv as never,
      new SearchIndex(),
      vector,
    );
    vector.add("obs_a", "ses_1", v(1));
    vector.add("mem_b", "ses_2", v(2));
    vector.remove("obs_a");
    await persistence.flushPendingLog();

    const rows = pendingRows(kv);
    expect(rows.size).toBe(2);
    expect(rows.get("obs_a")).toMatchObject({ id: "obs_a", t: 1 });
    expect(rows.get("mem_b")).toMatchObject({
      id: "mem_b",
      s: "ses_2",
    });
    expect(typeof rows.get("mem_b")!.e).toBe("string");
    expect(rows.get("obs_a")!.q as number).toBeGreaterThan(
      rows.get("mem_b")!.q as number,
    );
    expect(persistence.pendingLogSize()).toBe(2);
    stopAll(persistence);
  });

  it("does nothing when there is no vector index", async () => {
    const kv = mockKV();
    const persistence = new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    );
    const standalone = new VectorIndex();
    standalone.add("obs_a", "ses_1", v(1));
    await persistence.save();
    const replay = await persistence.replayPendingLog(3);

    expect(kv.store.get(PENDING_SCOPE)).toBeUndefined();
    expect(kv.ops.filter((o) => o.scope === PENDING_SCOPE)).toEqual([]);
    expect(replay.entries).toBe(0);
    expect(persistence.pendingLogSize()).toBe(0);
    stopAll(persistence);
  });

  it("skips logged vectors whose dimension mismatches the active provider", async () => {
    const kv = mockKV();
    const first = await boot(kv);
    first.vector.add("obs_ok", "ses_1", v(1));
    first.vector.add("obs_wide", "ses_1", new Float32Array([1, 2, 3, 4]));
    await first.persistence.flushPendingLog();
    first.persistence.stop();

    const second = await boot(kv);
    expect(second.vector.has("obs_wide")).toBe(false);
    expect(second.vector.has("obs_ok")).toBe(true);
    stopAll(first.persistence, second.persistence);
  });

  it("replays by sequence, not list order, including a full clear", async () => {
    const kv = mockKV({ shuffle: true });
    const first = await boot(kv);
    first.vector.add("obs_old", "ses_1", v(1));
    await first.persistence.save();
    first.vector.add("obs_gone", "ses_1", v(2));
    first.vector.clear();
    first.vector.add("obs_new", "ses_1", v(3));
    first.vector.add("obs_flip", "ses_1", v(4));
    first.vector.remove("obs_flip");
    first.vector.add("obs_flip", "ses_1", v(5));
    await first.persistence.flushPendingLog();
    first.persistence.stop();

    const second = await boot(kv);
    expect([...second.vector.entries()].map(([id]) => id).sort()).toEqual([
      "obs_flip",
      "obs_new",
    ]);
    expect(Array.from(second.vector.get("obs_flip")!.embedding)).toEqual(
      Array.from(v(5)),
    );

    await second.persistence.save();
    expect(pendingRows(kv).size).toBe(0);
    const third = await boot(kv);
    expect([...third.vector.entries()].map(([id]) => id).sort()).toEqual([
      "obs_flip",
      "obs_new",
    ]);
    stopAll(first.persistence, second.persistence, third.persistence);
  });

  it("keeps only entries written during a snapshot, not the ones it covered", async () => {
    const kv = mockKV();
    let release: () => void = () => undefined;
    let gate: Promise<void> | null = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = {
      ...kv,
      set: async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (scope === VECTOR_BUCKET_SCOPE && gate) await gate;
        return kv.set(scope, key, data);
      },
    };
    const vector = new VectorIndex();
    const persistence = new IndexPersistence(
      slow as never,
      new SearchIndex(),
      vector,
    );
    vector.add("obs_before", "ses_1", v(1));
    await persistence.flushPendingLog();

    const saving = persistence.save();
    await Promise.resolve();
    vector.add("obs_during", "ses_1", v(2));
    await persistence.flushPendingLog();
    gate = null;
    release();
    await saving;

    expect([...pendingRows(kv).keys()]).toEqual(["obs_during"]);
    expect(persistence.pendingLogSize()).toBe(1);
    stopAll(persistence);
  });

  it("keeps every entry when the snapshot write fails", async () => {
    const kv = mockKV();
    const failing = {
      ...kv,
      set: async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (scope === INDEX_SCOPE) throw new Error("state write refused");
        return kv.set(scope, key, data);
      },
    };
    const vector = new VectorIndex();
    const persistence = new IndexPersistence(
      failing as never,
      new SearchIndex(),
      vector,
    );
    vector.add("obs_1", "ses_1", v(1));
    vector.add("obs_2", "ses_1", v(2));
    await persistence.flushPendingLog();
    await persistence.save();

    expect(pendingRows(kv).size).toBe(2);
    expect(
      kv.ops.filter((o) => o.op === "delete" && o.scope === PENDING_SCOPE),
    ).toEqual([]);
    stopAll(persistence);
  });

  it("surfaces a pending-log write failure without failing the save", async () => {
    const kv = mockKV();
    const failing = {
      ...kv,
      set: async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (scope === PENDING_SCOPE) throw new Error("log backend down");
        return kv.set(scope, key, data);
      },
    };
    const vector = new VectorIndex();
    const persistence = new IndexPersistence(
      failing as never,
      new SearchIndex(),
      vector,
    );
    vector.add("obs_1", "ses_1", v(1));
    await persistence.flushPendingLog().catch(() => {});
    await vi.waitFor(() => {
      expect(persistence.pendingLogWriteError()).toContain("log backend down");
    });

    await persistence.save();
    const loaded = await new IndexPersistence(
      kv as never,
      new SearchIndex(),
      null,
    ).load();
    expect(loaded.vector!.size).toBe(1);
    stopAll(persistence);
  });

  it("returns identical reads with the durability layer on and off", async () => {
    const kv = mockKV();
    const first = await boot(kv);
    const seeds: Array<[string, number]> = [
      ["obs_a", 1],
      ["obs_b", 2],
      ["obs_c", 3],
    ];
    for (const [id, seed] of seeds) first.vector.add(id, "ses_1", v(seed));
    const query = new Float32Array([1, 1.5, 2]);
    const before = first.vector.search(query, 10).map((r) => r.obsId);
    await first.persistence.flushPendingLog();
    first.persistence.stop();

    const second = await boot(kv);
    const after = second.vector.search(query, 10).map((r) => r.obsId);
    expect(after).toEqual(before);
    stopAll(first.persistence, second.persistence);
  });

  it("triggers an early snapshot once the log grows past its bound", async () => {
    vi.useFakeTimers();
    try {
      const kv = mockKV();
      const vector = new VectorIndex();
      const persistence = new IndexPersistence(
        kv as never,
        new SearchIndex(),
        vector,
      );
      await vi.advanceTimersByTimeAsync(6_000);
      const metaSet = () =>
        kv.ops.some(
          (o) =>
            o.op === "set" &&
            o.scope === INDEX_SCOPE &&
            o.key === "vectors:manifest",
        );
      for (let i = 0; i < 520; i++) vector.add(`obs_${i}`, "ses_1", v(i));
      expect(metaSet()).toBe(false);
      await vi.advanceTimersByTimeAsync(10);
      await persistence.save();
      await persistence.flushPendingLog();
      expect(metaSet()).toBe(true);
      expect(pendingRows(kv).size).toBe(0);
      stopAll(persistence);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("vector durability: durable backlog", () => {
  afterEach(() => {
    getSearchIndex().clear();
    setVectorIndex(null);
    setEmbeddingProvider(null);
    setIndexPersistence(null);
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  function seed(kv: MockKV, count: number, timestamp: string): void {
    const sessionId = "ses_0";
    kv.store.set(
      "mem:sessions",
      new Map([
        [
          sessionId,
          {
            id: sessionId,
            project: "p",
            cwd: "/tmp",
            startedAt: timestamp,
            status: "completed",
            observationCount: count,
          } as Session,
        ],
      ]),
    );
    const scope = new Map<string, unknown>();
    for (let i = 0; i < count; i++) {
      const id = `obs_${String(i).padStart(3, "0")}`;
      scope.set(id, {
        id,
        sessionId,
        timestamp,
        type: "file_edit",
        title: `change ${i}`,
        facts: [],
        narrative: `narrative for change ${i}`,
        concepts: [],
        files: [],
        importance: 5,
      } satisfies CompressedObservation);
    }
    kv.store.set(`mem:obs:${sessionId}`, scope);
    kv.store.set(
      "mem:memories",
      new Map([
        [
          "mem_orphan",
          {
            id: "mem_orphan",
            title: "orphan memory",
            content: "content worth embedding",
            isLatest: true,
            sessionIds: ["ses_0"],
          } as Memory,
        ],
      ]),
    );
  }

  function provider(
    down: boolean,
    calls: { n: number; texts: string[] },
  ): EmbeddingProvider {
    return {
      name: "stub",
      dimensions: 3,
      embed: async () => new Float32Array([0.1, 0.2, 0.3]),
      embedBatch: async (texts: string[]) => {
        calls.n++;
        calls.texts.push(...texts);
        if (down) throw new Error("provider down");
        return texts.map(() => new Float32Array([0.1, 0.2, 0.3]));
      },
    } as EmbeddingProvider;
  }

  function wire(
    kv: MockKV,
    vector: VectorIndex,
    ep: EmbeddingProvider,
  ): IndexPersistence {
    const persistence = new IndexPersistence(
      kv as never,
      new SearchIndex(),
      vector,
    );
    setVectorIndex(vector);
    setEmbeddingProvider(ep);
    setIndexPersistence(persistence as never);
    return persistence;
  }

  it("re-embeds only what is missing and reports completion", async () => {
    vi.stubEnv("REBUILD_EMBED_BATCH_SIZE", "5");
    const kv = mockKV();
    seed(kv, 12, "2026-09-02T00:00:00.000Z");
    const vector = new VectorIndex();
    vector.add("obs_000", "ses_0", new Float32Array([0.1, 0.2, 0.3]));
    vector.add("mem_orphan", "ses_0", new Float32Array([0.1, 0.2, 0.3]));
    const calls = { n: 0, texts: [] as string[] };
    const persistence = wire(kv, vector, provider(false, calls));

    const jobs = await collectMissingVectorJobs(kv as never);
    expect(jobs.map((j) => j.id).sort()).toEqual(
      Array.from({ length: 11 }, (_, i) => `obs_${String(i + 1).padStart(3, "0")}`),
    );
    const result = await backfillMissingVectors(kv as never);
    expect(result).toMatchObject({ added: 11, failed: 0, complete: true });
    expect(vector.size).toBe(13);
    expect(calls.texts).toHaveLength(11);
    expect(
      calls.texts.some((t) => t.includes("change 0 ")),
    ).toBe(false);
    stopAll(persistence);
  });

  it("keeps the backfill marker until the backlog is done", async () => {
    const kv = mockKV();
    seed(kv, 3, "2026-09-02T00:00:00.000Z");
    const vector = new VectorIndex();
    const persistence = new IndexPersistence(
      kv as never,
      new SearchIndex(),
      vector,
    );
    expect(await persistence.readBackfillMarker()).toBeNull();
    await persistence.markBackfillSince("2026-09-01T00:00:00.000Z");
    expect(await persistence.readBackfillMarker()).toBe(
      "2026-09-01T00:00:00.000Z",
    );
    await persistence.markBackfillSince("2026-09-03T00:00:00.000Z");
    expect(await persistence.readBackfillMarker()).toBe(
      "2026-09-01T00:00:00.000Z",
    );
    await persistence.markBackfillSince("not-a-date");
    expect(await persistence.readBackfillMarker()).toBe(
      "2026-09-01T00:00:00.000Z",
    );

    const calls = { n: 0, texts: [] as string[] };
    wire(kv, vector, provider(false, calls));
    const result = await backfillMissingVectors(kv as never);
    expect(result.complete).toBe(true);
    await persistence.clearBackfillMarker();
    expect(await persistence.readBackfillMarker()).toBeNull();
    stopAll(persistence);
  });

  it("pauses instead of completing when the provider is down", async () => {
    const kv = mockKV();
    seed(kv, 4, "2026-09-02T00:00:00.000Z");
    const vector = new VectorIndex();
    const calls = { n: 0, texts: [] as string[] };
    const persistence = wire(kv, vector, provider(true, calls));
    await persistence.markBackfillSince("2026-09-01T00:00:00.000Z");

    const result = await backfillMissingVectors(kv as never);
    expect(result.complete).toBe(false);
    expect(result.remaining).toBeGreaterThan(0);
    expect(vector.size).toBe(0);
    expect(await persistence.readBackfillMarker()).toBe(
      "2026-09-01T00:00:00.000Z",
    );
    stopAll(persistence);
  });

  it("finds nothing missing on a healthy store", async () => {
    const kv = mockKV();
    seed(kv, 2, "2026-09-02T00:00:00.000Z");
    const vector = new VectorIndex();
    for (const id of ["obs_000", "obs_001", "mem_orphan"])
      vector.add(id, "ses_0", new Float32Array([0.1, 0.2, 0.3]));
    const calls = { n: 0, texts: [] as string[] };
    const persistence = wire(kv, vector, provider(false, calls));

    const result = await backfillMissingVectors(kv as never);
    expect(result).toEqual({ added: 0, failed: 0, remaining: 0, complete: true });
    expect(calls.n).toBe(0);
    stopAll(persistence);
  });
});
