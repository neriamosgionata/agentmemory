import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, { stdout: "abc1234\n", stderr: "" });
    },
  ),
}));

vi.mock("node:util", async () => {
  const actual = (await vi.importActual("node:util")) as Record<
    string,
    unknown
  >;
  return {
    ...actual,
    promisify: () => async () => ({ stdout: "abc1234\n", stderr: "" }),
  };
});

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi
    .fn()
    .mockReturnValue('{"version":"0.9.29","sessions":[],"memories":[]}'),
}));

import { readFileSync } from "node:fs";
import { registerEvictFunction } from "../src/functions/evict.js";
import { registerRememberFunction } from "../src/functions/remember.js";
import { registerGovernanceFunction } from "../src/functions/governance.js";
import { registerSnapshotFunction } from "../src/functions/snapshot.js";
import { registerExportImportFunction } from "../src/functions/export-import.js";
import { KV } from "../src/state/schema.js";
import { getSearchIndex, setVectorIndex } from "../src/functions/search.js";
import { VERSION } from "../src/version.js";
import type {
  CompressedObservation,
  ExportData,
  GraphExtractionWatermark,
  Session,
  SummaryPartialCache,
} from "../src/types.js";

type Store = Map<string, Map<string, unknown>>;
type Handler = (payload: unknown) => unknown | Promise<unknown>;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function mockKV(store: Store) {
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    registerFunction: (
      idOrOpts: string | { id: string },
      handler: Handler,
    ) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      handlers.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id =
        typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload =
        typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = handlers.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

function makeSession(
  id: string,
  overrides: Partial<Session> = {},
): Session {
  return {
    id,
    project: "agentmemory",
    cwd: "/repo/agentmemory",
    startedAt: daysAgo(31),
    status: "active",
    observationCount: 1,
    ...overrides,
  };
}

function makeObservation(
  sessionId: string,
  overrides: Partial<CompressedObservation> = {},
): CompressedObservation {
  return {
    id: "obs_1",
    sessionId,
    timestamp: daysAgo(31),
    type: "decision",
    title: "Chose sqlite storage",
    facts: ["Use sqlite for local state"],
    narrative: "The session chose sqlite for local state.",
    concepts: ["sqlite"],
    files: ["src/state/kv.ts"],
    importance: 8,
    ...overrides,
  };
}

function seedDerivedState(store: Store, sessionId: string): void {
  const partials: SummaryPartialCache = {
    sessionId,
    chunkSize: 10,
    coveredCount: 1,
    chunks: [],
    updatedAt: new Date().toISOString(),
  };
  const watermark: GraphExtractionWatermark = {
    sessionId,
    extractedCount: 1,
    boundaryObservationId: "obs_1",
    updatedAt: new Date().toISOString(),
  };
  if (!store.has(KV.summaryPartials)) store.set(KV.summaryPartials, new Map());
  if (!store.has(KV.graphExtractionWatermarks)) {
    store.set(KV.graphExtractionWatermarks, new Map());
  }
  store.get(KV.summaryPartials)!.set(sessionId, partials);
  store.get(KV.graphExtractionWatermarks)!.set(sessionId, watermark);
}

async function assertDerivedCleared(
  kv: ReturnType<typeof mockKV>,
  sessionId: string,
): Promise<void> {
  expect(await kv.get(KV.summaryPartials, sessionId)).toBeNull();
  expect(await kv.get(KV.graphExtractionWatermarks, sessionId)).toBeNull();
}

describe("derived-state cleanup", () => {
  beforeEach(() => {
    getSearchIndex().clear();
    setVectorIndex(null);
    vi.clearAllMocks();
    vi.mocked(readFileSync).mockReturnValue(
      '{"version":"0.9.29","sessions":[],"memories":[]}',
    );
  });

  it("evicting a stale session removes its partials and watermark", async () => {
    const sessionId = "ses_stale";
    const store: Store = new Map([
      [KV.sessions, new Map([[sessionId, makeSession(sessionId)]])],
      [KV.summaries, new Map()],
      [
        KV.observations(sessionId),
        new Map([["obs_1", makeObservation(sessionId)]]),
      ],
    ]);
    seedDerivedState(store, sessionId);

    const kv = mockKV(store);
    const sdk = mockSdk();
    registerEvictFunction(sdk as never, kv as never);
    sdk.registerFunction("event::session::stopped", () => ({ success: true }));
    sdk.registerFunction("mem::consolidate-pipeline", () => ({
      success: true,
    }));
    sdk.registerFunction("mem::auto-crystallize", () => ({ success: true }));

    const result = (await sdk.trigger("mem::evict", {})) as {
      staleSessions: number;
    };

    expect(result.staleSessions).toBe(1);
    await assertDerivedCleared(kv as never, sessionId);
  });

  it("evicting no-derived-state sessions does not fail", async () => {
    const sessionId = "ses_no_derived";
    const store: Store = new Map([
      [KV.sessions, new Map([[sessionId, makeSession(sessionId)]])],
      [KV.summaries, new Map()],
      [
        KV.observations(sessionId),
        new Map([["obs_1", makeObservation(sessionId)]]),
      ],
    ]);

    const kv = mockKV(store);
    const sdk = mockSdk();
    registerEvictFunction(sdk as never, kv as never);
    sdk.registerFunction("event::session::stopped", () => ({ success: true }));
    sdk.registerFunction("mem::consolidate-pipeline", () => ({
      success: true,
    }));
    sdk.registerFunction("mem::auto-crystallize", () => ({ success: true }));

    const result = (await sdk.trigger("mem::evict", {})) as {
      staleSessions: number;
    };

    expect(result.staleSessions).toBe(1);
    expect(await kv.get(KV.sessions, sessionId)).toBeNull();
    await assertDerivedCleared(kv as never, sessionId);
  });

  it("evicting individual observations invalidates the session caches", async () => {
    const sessionId = "ses_low";
    const session = makeSession(sessionId, {
      startedAt: daysAgo(1),
      observationCount: 1,
    });
    const observation = makeObservation(sessionId, {
      timestamp: daysAgo(120),
      importance: 1,
    });
    const store: Store = new Map([
      [KV.sessions, new Map([[sessionId, session]])],
      [KV.summaries, new Map()],
      [KV.observations(sessionId), new Map([[observation.id, observation]])],
    ]);
    seedDerivedState(store, sessionId);

    const kv = mockKV(store);
    const sdk = mockSdk();
    registerEvictFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::evict", {})) as {
      lowImportanceObs: number;
    };

    expect(result.lowImportanceObs).toBe(1);
    expect(await kv.get(KV.observations(sessionId), observation.id)).toBeNull();
    await assertDerivedCleared(kv as never, sessionId);
  });

  it("forgetting a session removes its partials and watermark", async () => {
    const sessionId = "ses_forget";
    const store: Store = new Map([
      [KV.sessions, new Map([[sessionId, makeSession(sessionId)]])],
      [KV.summaries, new Map()],
      [
        KV.observations(sessionId),
        new Map([["obs_1", makeObservation(sessionId)]]),
      ],
    ]);
    seedDerivedState(store, sessionId);

    const kv = mockKV(store);
    const sdk = mockSdk();
    registerRememberFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::forget", { sessionId })) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(await kv.get(KV.sessions, sessionId)).toBeNull();
    await assertDerivedCleared(kv as never, sessionId);
  });

  it("forgetting individual observations invalidates the session caches", async () => {
    const sessionId = "ses_forget_one";
    const store: Store = new Map([
      [KV.sessions, new Map([[sessionId, makeSession(sessionId)]])],
      [KV.summaries, new Map()],
      [
        KV.observations(sessionId),
        new Map([["obs_1", makeObservation(sessionId)]]),
      ],
    ]);
    seedDerivedState(store, sessionId);

    const kv = mockKV(store);
    const sdk = mockSdk();
    registerRememberFunction(sdk as never, kv as never);

    await sdk.trigger("mem::forget", {
      sessionId,
      observationIds: ["obs_1"],
    });

    expect(await kv.get(KV.observations(sessionId), "obs_1")).toBeNull();
    expect(await kv.get(KV.sessions, sessionId)).toMatchObject({
      id: sessionId,
    });
    await assertDerivedCleared(kv as never, sessionId);
  });

  it("governance-deleting an observation invalidates the session caches", async () => {
    const sessionId = "ses_gov";
    const store: Store = new Map([
      [KV.sessions, new Map([[sessionId, makeSession(sessionId)]])],
      [KV.summaries, new Map()],
      [
        KV.observations(sessionId),
        new Map([["obs_1", makeObservation(sessionId)]]),
      ],
    ]);
    seedDerivedState(store, sessionId);

    const kv = mockKV(store);
    const sdk = mockSdk();
    registerGovernanceFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::governance-delete", {
      memoryIds: ["obs_1"],
      sessionId,
    })) as { success: boolean; deletedObservations: number };

    expect(result.success).toBe(true);
    expect(result.deletedObservations).toBe(1);
    await assertDerivedCleared(kv as never, sessionId);
  });

  it("snapshot restore removes derived state for the replaced sessions", async () => {
    const sessionId = "ses_snap";
    const store: Store = new Map([
      [KV.sessions, new Map([[sessionId, makeSession(sessionId)]])],
      [KV.memories, new Map()],
      [
        KV.observations(sessionId),
        new Map([["obs_1", makeObservation(sessionId)]]),
      ],
    ]);
    seedDerivedState(store, sessionId);

    const kv = mockKV(store);
    const sdk = mockSdk();
    registerSnapshotFunction(sdk as never, kv as never, "/tmp/derived-snap");

    vi.mocked(readFileSync).mockReturnValueOnce(
      JSON.stringify({
        version: VERSION,
        sessions: [],
        memories: [],
        graphNodes: [],
        observations: {},
        accessLogs: [],
        summaries: [],
      }),
    );

    const result = (await sdk.trigger("mem::snapshot-restore", {
      commitHash: "abc1234",
    })) as { success: boolean };

    expect(result.success).toBe(true);
    await assertDerivedCleared(kv as never, sessionId);
  });

  it("import with strategy replace leaves no derived state for replaced sessions", async () => {
    const sessionId = "ses_replace";
    const store: Store = new Map([
      [KV.sessions, new Map([[sessionId, makeSession(sessionId)]])],
      [KV.summaries, new Map()],
      [
        KV.observations(sessionId),
        new Map([["obs_1", makeObservation(sessionId)]]),
      ],
    ]);
    seedDerivedState(store, sessionId);

    const kv = mockKV(store);
    const sdk = mockSdk();
    registerExportImportFunction(sdk as never, kv as never);

    const exportData: ExportData = {
      version: VERSION,
      exportedAt: new Date().toISOString(),
      sessions: [],
      observations: {},
      memories: [],
      summaries: [],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "replace",
    })) as { success: boolean };

    expect(result.success).toBe(true);
    await assertDerivedCleared(kv as never, sessionId);
  });

  it("export payload contains no derived-scope entries", async () => {
    const sessionId = "ses_export";
    const store: Store = new Map([
      [KV.sessions, new Map([[sessionId, makeSession(sessionId)]])],
      [KV.summaries, new Map()],
      [
        KV.observations(sessionId),
        new Map([["obs_1", makeObservation(sessionId)]]),
      ],
    ]);
    seedDerivedState(store, sessionId);

    const kv = mockKV(store);
    const sdk = mockSdk();
    registerExportImportFunction(sdk as never, kv as never);

    const payload = (await sdk.trigger("mem::export", {})) as ExportData;

    expect(Object.keys(payload)).not.toContain("summaryPartials");
    expect(Object.keys(payload)).not.toContain("graphExtractionWatermarks");
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("mem:summary-partials");
    expect(serialized).not.toContain("mem:graph:extraction-watermarks");
  });

  it("import of a full payload leaves derived scopes empty", async () => {
    const sessionId = "ses_full";
    const store: Store = new Map([
      [KV.sessions, new Map([[sessionId, makeSession(sessionId)]])],
      [KV.summaries, new Map()],
      [
        KV.observations(sessionId),
        new Map([["obs_1", makeObservation(sessionId)]]),
      ],
    ]);
    seedDerivedState(store, sessionId);
    seedDerivedState(store, "ses_orphan");

    const kv = mockKV(store);
    const sdk = mockSdk();
    registerExportImportFunction(sdk as never, kv as never);

    const payload = (await sdk.trigger("mem::export", {})) as ExportData;

    const importResult = (await sdk.trigger("mem::import", {
      exportData: payload,
      strategy: "replace",
    })) as { success: boolean };

    expect(importResult.success).toBe(true);
    expect(await kv.list(KV.summaryPartials)).toEqual([]);
    expect(await kv.list(KV.graphExtractionWatermarks)).toEqual([]);
  });
});
