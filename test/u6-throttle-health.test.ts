import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { IndexPersistence } from "../src/state/index-persistence.js";
import { SearchIndex } from "../src/state/search-index.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { getIndexSaveIntervalMs } from "../src/config.js";
import { __resetEnvFileCache } from "../src/config.js";
import type { CompressedObservation } from "../src/types.js";

const BM25_SCOPE = "mem:index:bm25";
const BM25_MANIFEST_KEY = "data:manifest";
const VECTOR_MANIFEST_KEY = "vectors:manifest";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const sets: Array<{ scope: string; key: string }> = [];
  return {
    sets,
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      sets.push({ scope, key });
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function obs(id: string, title: string): CompressedObservation {
  return {
    id,
    sessionId: "ses_1",
    timestamp: new Date().toISOString(),
    type: "file_edit",
    title,
    facts: [],
    narrative: `${title} narrative`,
    concepts: [],
    files: [],
    importance: 5,
  };
}

function manifestSaves(kv: ReturnType<typeof mockKV>): number {
  return kv.sets.filter((s) => s.scope === BM25_SCOPE && s.key === BM25_MANIFEST_KEY).length;
}

describe("U6 index save throttle knob", () => {
  const ENV_KEY = "AGENTMEMORY_INDEX_SAVE_INTERVAL_MS";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[ENV_KEY];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
    __resetEnvFileCache();
    vi.useRealTimers();
  });

  it("defaults to the current debounce and reads the env override", () => {
    delete process.env[ENV_KEY];
    __resetEnvFileCache();
    expect(getIndexSaveIntervalMs()).toBe(5000);
    process.env[ENV_KEY] = "60000";
    __resetEnvFileCache();
    expect(getIndexSaveIntervalMs()).toBe(60000);
    process.env[ENV_KEY] = "not-a-number";
    __resetEnvFileCache();
    expect(getIndexSaveIntervalMs()).toBe(5000);
  });
});

describe("U6 IndexPersistence save throttling", () => {
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    vi.useFakeTimers();
    kv = mockKV();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("saves at most once per interval however often changes are scheduled", async () => {
    const bm25 = new SearchIndex();
    bm25.add(obs("obs_1", "alpha"));
    const persistence = new IndexPersistence(kv as never, bm25, null, {
      saveIntervalMs: 60_000,
    });

    for (let i = 0; i < 50; i++) persistence.scheduleSave();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(manifestSaves(kv)).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.runAllTimersAsync();
    expect(manifestSaves(kv)).toBe(1);

    for (let i = 0; i < 50; i++) persistence.scheduleSave();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(manifestSaves(kv)).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.runAllTimersAsync();
    expect(manifestSaves(kv)).toBe(2);
  });

  it("an explicit save runs immediately and cancels the pending timer", async () => {
    const bm25 = new SearchIndex();
    bm25.add(obs("obs_1", "alpha"));
    const persistence = new IndexPersistence(kv as never, bm25, null, {
      saveIntervalMs: 60_000,
    });

    persistence.scheduleSave();
    await persistence.save();
    expect(manifestSaves(kv)).toBe(1);

    await vi.advanceTimersByTimeAsync(120_000);
    await vi.runAllTimersAsync();
    expect(manifestSaves(kv)).toBe(1);
  });

  it("never runs two saves at once and coalesces requests made during a save into one", async () => {
    let release: () => void = () => undefined;
    let inFlight = 0;
    let maxInFlight = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = true;
    const slowKv = {
      ...kv,
      set: async <T>(scope: string, key: string, data: T): Promise<T> => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          if (held) await gate;
          return await kv.set(scope, key, data);
        } finally {
          inFlight--;
        }
      },
    };
    const bm25 = new SearchIndex();
    bm25.add(obs("obs_1", "alpha"));
    const persistence = new IndexPersistence(slowKv as never, bm25, null, {
      saveIntervalMs: 60_000,
    });

    const first = persistence.save();
    const second = persistence.save();
    const third = persistence.save();
    expect(second).toBe(third);
    expect(persistence.status().saving).toBe(true);

    held = false;
    release();
    await Promise.all([first, second, third]);

    expect(maxInFlight).toBe(1);
    expect(manifestSaves(kv)).toBe(2);
    expect(persistence.status().saving).toBe(false);
  });

  it("a failing BM25 leg does not stop the vector leg from saving", async () => {
    const failingKv = {
      ...kv,
      set: async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (scope === BM25_SCOPE && key === BM25_MANIFEST_KEY) {
          throw new Error("bm25 manifest write failed");
        }
        return kv.set(scope, key, data);
      },
    };
    const bm25 = new SearchIndex();
    bm25.add(obs("obs_1", "alpha"));
    const vector = new VectorIndex();
    vector.add("obs_1", "ses_1", new Float32Array([0.1, 0.2, 0.3]));
    const persistence = new IndexPersistence(failingKv as never, bm25, vector, {
      saveIntervalMs: 60_000,
    });

    await persistence.save();

    const status = persistence.status();
    expect(status.bm25.lastError).toBe("bm25 manifest write failed");
    expect(status.bm25.pending).toBe(true);
    expect(status.vector?.lastError).toBeNull();
    expect(status.vector?.savedAt).not.toBeNull();
    expect(status.vector?.pending).toBe(false);

    const vectorManifest = await kv.get(BM25_SCOPE, VECTOR_MANIFEST_KEY);
    expect(vectorManifest).not.toBeNull();
  });

  it("each leg reports pending, saved-at and dropped counts after a burst", async () => {
    const bm25 = new SearchIndex();
    bm25.add(obs("obs_1", "alpha"));
    const vector = new VectorIndex();
    vector.add("obs_1", "ses_1", new Float32Array([0.1, 0.2, 0.3]));
    const persistence = new IndexPersistence(kv as never, bm25, vector, {
      saveIntervalMs: 60_000,
    });

    for (let i = 0; i < 10; i++) persistence.scheduleSave();
    const before = persistence.status();
    expect(before.bm25.pending).toBe(true);
    expect(before.vector?.pending).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.runAllTimersAsync();

    const after = persistence.status();
    expect(after.bm25.pending).toBe(false);
    expect(after.bm25.savedAt).not.toBeNull();
    expect(after.vector?.pending).toBe(false);
    expect(after.vector?.savedAt).not.toBeNull();
    expect(after.bm25.dropped).toBeGreaterThan(0);
    expect(after.saveIntervalMs).toBe(60_000);
  });
});

describe("U6 per-leg save state on the health surface", () => {
  it("health snapshots carry the index persistence legs", async () => {
    const { registerHealthMonitor, getLatestHealth, setIndexPersistenceStatusProvider } =
      await import("../src/health/monitor.js");
    const { mockKV, mockSdk } = await import("./helpers/mocks.js");
    const kv = mockKV();
    const sdk = mockSdk();
    const monitor = registerHealthMonitor(sdk as never, kv as never);
    try {
      expect(typeof setIndexPersistenceStatusProvider).toBe("function");
      setIndexPersistenceStatusProvider(() => ({
        saveIntervalMs: 60_000,
        saving: false,
        bm25: { pending: true, savedAt: null, dropped: 3, lastError: null },
        vector: { pending: false, savedAt: "2026-10-07T00:00:00.000Z", dropped: 0, lastError: null },
      }));
      for (let i = 0; i < 20; i++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        const latest = await getLatestHealth(kv as never);
        if (latest?.indexPersistence) {
          expect(latest.indexPersistence.bm25.pending).toBe(true);
          expect(latest.indexPersistence.bm25.dropped).toBe(3);
          expect(latest.indexPersistence.vector?.savedAt).toBe("2026-10-07T00:00:00.000Z");
          return;
        }
      }
      throw new Error("health snapshot never carried indexPersistence");
    } finally {
      monitor.stop();
      setIndexPersistenceStatusProvider(null);
    }
  });

  it("a failing leg degrades health and stale pending legs are noted", async () => {
    const { evaluateHealth } = await import("../src/health/thresholds.js");
    const base = {
      connectionState: "connected",
      workers: [],
      memory: { heapUsed: 100, heapTotal: 1000, heapLimit: 2000, rss: 100, external: 0 },
      cpu: { userMicros: 1, systemMicros: 1, percent: 1, cores: 4 },
      eventLoopLagMs: 1,
      uptimeSeconds: 10,
      status: "healthy" as const,
      alerts: [],
    };
    const failing = evaluateHealth({
      ...base,
      indexPersistence: {
        saveIntervalMs: 60_000,
        saving: false,
        bm25: { pending: true, savedAt: null, dropped: 0, lastError: "boom" },
        vector: null,
      },
    });
    expect(failing.status).toBe("degraded");
    expect(failing.alerts.some((a) => a.includes("index_save_failing_bm25"))).toBe(true);

    const clean = evaluateHealth({
      ...base,
      indexPersistence: {
        saveIntervalMs: 60_000,
        saving: false,
        bm25: { pending: false, savedAt: new Date().toISOString(), dropped: 0, lastError: null },
        vector: null,
      },
    });
    expect(clean.status).toBe("healthy");
    expect(clean.alerts).toEqual([]);
  });
});
