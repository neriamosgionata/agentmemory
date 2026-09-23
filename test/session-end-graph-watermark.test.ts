import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/config.js", () => ({
  getAgentId: vi.fn(() => undefined),
  getEnvVar: vi.fn(() => undefined),
  isConsolidationEnabled: vi.fn(() => false),
  getConsolidationCooldownMs: vi.fn(() => 0),
  isGraphExtractionEnabled: vi.fn(() => true),
  getGraphBatchSize: vi.fn(() => 10),
  getGraphMaxSourceIds: vi.fn(() => 10),
}));

vi.mock("../src/functions/slots.js", () => ({
  isReflectEnabled: vi.fn(() => false),
}));

import { registerEventTriggers } from "../src/triggers/events.js";
import { registerGraphFunction } from "../src/functions/graph.js";
import { KV } from "../src/state/schema.js";
import { getGraphBatchSize } from "../src/config.js";
import type {
  CompressedObservation,
  GraphExtractionWatermark,
  MemoryProvider,
} from "../src/types.js";

type ExtractResult = {
  success?: boolean;
  llmFailed?: boolean;
  nodesAdded?: number;
  edgesAdded?: number;
  error?: string;
};

type ExtractPayload = { observations: CompressedObservation[] };

function obs(id: string, extra?: Partial<CompressedObservation>): CompressedObservation {
  return {
    id,
    sessionId: "ses_1",
    timestamp: "2026-02-01T10:00:00Z",
    type: "file_edit",
    title: `Observation ${id}`,
    facts: [],
    narrative: `narrative ${id}`,
    concepts: [],
    files: [],
    importance: 5,
    ...extra,
  };
}

function createKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
    get: vi.fn(async (scope: string, key: string) => {
      return store.get(scope)?.get(key) ?? null;
    }),
    set: vi.fn(async (scope: string, key: string, data: unknown) => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    }),
    delete: vi.fn(async (scope: string, key: string) => {
      store.get(scope)?.delete(key);
    }),
    update: vi.fn(async () => {}),
    list: vi.fn(async (scope: string) => {
      return [...(store.get(scope)?.values() ?? [])];
    }),
  };
}

type KV = ReturnType<typeof createKV>;

async function seedObservations(
  kv: KV,
  sessionId: string,
  observations: CompressedObservation[],
): Promise<void> {
  for (const o of observations) {
    await kv.set(KV.observations(sessionId), o.id, o);
  }
}

async function insertObservationBefore(
  kv: KV,
  sessionId: string,
  beforeId: string,
  observation: CompressedObservation,
): Promise<void> {
  const scope = kv.store.get(KV.observations(sessionId))!;
  const entries = [...scope.entries()];
  scope.clear();
  for (const [key, value] of entries) {
    if (key === beforeId) scope.set(observation.id, observation);
    scope.set(key, value);
  }
}

async function readWatermark(
  kv: KV,
  sessionId: string,
): Promise<GraphExtractionWatermark | null> {
  return (await kv.get(
    KV.graphExtractionWatermarks,
    sessionId,
  )) as GraphExtractionWatermark | null;
}

function createEventsHarness(
  extract: (payload: ExtractPayload) => Promise<ExtractResult>,
) {
  const kv = createKV();
  type Handler = (data: { sessionId: string; skipConsolidation?: boolean }) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const trigger = vi.fn(
    async (input: { function_id: string; payload?: unknown; action?: unknown }) => {
      if (input.function_id === "mem::summarize") {
        return { summary: "session summary" };
      }
      if (input.function_id === "mem::graph-extract") {
        return extract(input.payload as ExtractPayload);
      }
      return { ok: true };
    },
  );
  const sdk = {
    registerFunction: (id: string, handler: Handler) => handlers.set(id, handler),
    registerTrigger: () => {},
    trigger,
  };
  registerEventTriggers(sdk as never, kv as never);
  const stopped = handlers.get("event::session::stopped")!;
  const extractCalls = () =>
    trigger.mock.calls
      .filter((c) => (c[0] as { function_id: string }).function_id === "mem::graph-extract")
      .map((c) => (c[0] as { payload: ExtractPayload }).payload);
  return { kv, handlers, trigger, stopped, extractCalls };
}

function createGraphHarness(providerOverride?: MemoryProvider) {
  const kv = createKV();
  const handlers = new Map<string, (data: unknown) => Promise<unknown>>();
  const sdk = {
    registerFunction: (id: string, handler: (data: unknown) => Promise<unknown>) =>
      handlers.set(id, handler),
    registerTrigger: () => {},
    trigger: async (input: { function_id: string; payload?: unknown }) =>
      handlers.get(input.function_id)!(input.payload),
  };
  const provider =
    providerOverride ??
    ({
      name: "test",
      compress: vi.fn(async () => ""),
      summarize: vi.fn(),
    } as unknown as MemoryProvider);
  registerGraphFunction(sdk as never, kv as never, provider);
  return { kv, handlers };
}

beforeEach(() => {
  vi.mocked(getGraphBatchSize).mockReturnValue(10);
});

describe("session-stop graph-extraction watermark (R4/R5)", () => {
  it("first stop extracts all observations and records the watermark", async () => {
    const h = createEventsHarness(async () => ({ success: true }));
    await seedObservations(h.kv, "ses_1", [obs("o1"), obs("o2"), obs("o3")]);

    await h.stopped({ sessionId: "ses_1" });

    const batches = h.extractCalls();
    expect(batches).toHaveLength(1);
    expect(batches[0].observations.map((o) => o.id)).toEqual(["o1", "o2", "o3"]);

    const watermark = await readWatermark(h.kv, "ses_1");
    expect(watermark).toMatchObject({
      sessionId: "ses_1",
      extractedCount: 3,
      boundaryObservationId: "o3",
    });
    expect(typeof watermark?.updatedAt).toBe("string");
  });

  it("a session with no watermark extracts the whole range once and records it", async () => {
    vi.mocked(getGraphBatchSize).mockReturnValue(1);
    const h = createEventsHarness(async () => ({ success: true }));
    await seedObservations(h.kv, "ses_1", [obs("o1"), obs("o2")]);

    await h.stopped({ sessionId: "ses_1" });
    await h.stopped({ sessionId: "ses_1" });

    const batches = h.extractCalls();
    expect(batches).toHaveLength(2);
    expect(batches.flatMap((b) => b.observations.map((o) => o.id))).toEqual(["o1", "o2"]);
    const watermark = await readWatermark(h.kv, "ses_1");
    expect(watermark?.extractedCount).toBe(2);
  });

  it("second stop with no new observations makes no extraction call", async () => {
    const h = createEventsHarness(async () => ({ success: true }));
    await seedObservations(h.kv, "ses_1", [obs("o1"), obs("o2")]);

    await h.stopped({ sessionId: "ses_1" });
    expect(h.extractCalls()).toHaveLength(1);

    await h.stopped({ sessionId: "ses_1" });
    expect(h.extractCalls()).toHaveLength(1);
  });

  it("second stop with new observations extracts only the tail", async () => {
    const h = createEventsHarness(async () => ({ success: true }));
    await seedObservations(h.kv, "ses_1", [obs("o1"), obs("o2")]);
    await h.stopped({ sessionId: "ses_1" });

    await seedObservations(h.kv, "ses_1", [obs("o3")]);
    await h.stopped({ sessionId: "ses_1" });

    const batches = h.extractCalls();
    expect(batches).toHaveLength(2);
    expect(batches[1].observations.map((o) => o.id)).toEqual(["o3"]);
    const watermark = await readWatermark(h.kv, "ses_1");
    expect(watermark?.extractedCount).toBe(3);
    expect(watermark?.boundaryObservationId).toBe("o3");
  });

  it("a boundary that moved later restarts extraction from 0 and re-covers the inserted observation", async () => {
    const h = createEventsHarness(async () => ({ success: true }));
    await seedObservations(h.kv, "ses_1", [obs("o1"), obs("o2"), obs("o3")]);
    await h.stopped({ sessionId: "ses_1" });
    expect(h.extractCalls()).toHaveLength(1);
    expect((await readWatermark(h.kv, "ses_1"))?.boundaryObservationId).toBe("o3");

    // A newly compressed observation lands BEFORE the recorded boundary, so
    // the boundary id moves from index 2 to index 3. The recorded position no
    // longer matches: extraction must restart at 0 rather than skip o0.
    await insertObservationBefore(h.kv, "ses_1", "o1", obs("o0"));
    await h.stopped({ sessionId: "ses_1" });

    const batches = h.extractCalls();
    expect(batches).toHaveLength(2);
    expect(batches[1].observations.map((o) => o.id)).toEqual([
      "o0",
      "o1",
      "o2",
      "o3",
    ]);
    const watermark = await readWatermark(h.kv, "ses_1");
    expect(watermark?.extractedCount).toBe(4);
    expect(watermark?.boundaryObservationId).toBe("o3");
  });

  it("re-anchors a boundary that moved earlier without re-extracting the covered prefix", async () => {
    vi.mocked(getGraphBatchSize).mockReturnValue(2);
    let failSecondBatch = true;
    const h = createEventsHarness(async (payload) => {
      if (failSecondBatch && payload.observations[0]?.id === "o3") {
        return { success: false, error: "llm exploded" };
      }
      return { success: true };
    });
    await seedObservations(h.kv, "ses_1", [
      obs("o1"),
      obs("o2"),
      obs("o3"),
      obs("o4"),
      obs("o5"),
    ]);

    await h.stopped({ sessionId: "ses_1" });
    const parked = await readWatermark(h.kv, "ses_1");
    expect(parked?.extractedCount).toBe(2);
    expect(parked?.boundaryObservationId).toBe("o2");

    // o1 is deleted before the boundary: the boundary id now sits at an index
    // EARLIER than the recorded position. That is the trusted re-anchor case —
    // extraction resumes just after the boundary (o3), not from 0, so the
    // already covered o2 is not re-extracted.
    h.kv.store.get(KV.observations("ses_1"))!.delete("o1");
    failSecondBatch = false;
    const callsBefore = h.extractCalls().length;
    await h.stopped({ sessionId: "ses_1" });

    const resumed = h
      .extractCalls()
      .slice(callsBefore)
      .map((b) => b.observations.map((o) => o.id));
    expect(resumed).toEqual([
      ["o3", "o4"],
      ["o5"],
    ]);
    expect(resumed.flat()).not.toContain("o2");
  });

  it("restarts from 0 when the recorded boundary observation no longer exists", async () => {
    const h = createEventsHarness(async () => ({ success: true }));
    await seedObservations(h.kv, "ses_1", [obs("o1"), obs("o2"), obs("o3")]);
    await h.stopped({ sessionId: "ses_1" });
    expect((await readWatermark(h.kv, "ses_1"))?.boundaryObservationId).toBe("o3");

    // The boundary row is gone, so the recorded count cannot be trusted:
    // extraction must re-cover the surviving rows instead of resuming past
    // them at the recorded offset.
    h.kv.store.get(KV.observations("ses_1"))!.delete("o3");
    await seedObservations(h.kv, "ses_1", [obs("o4")]);
    await h.stopped({ sessionId: "ses_1" });

    const batches = h.extractCalls();
    expect(batches).toHaveLength(2);
    expect(batches[1].observations.map((o) => o.id)).toEqual(["o1", "o2", "o4"]);
    const watermark = await readWatermark(h.kv, "ses_1");
    expect(watermark?.extractedCount).toBe(3);
    expect(watermark?.boundaryObservationId).toBe("o4");
  });

  it("an LLM-leg failure leaves the watermark unchanged and retries on the next stop", async () => {
    let llmDown = true;
    const h = createEventsHarness(async () => {
      if (llmDown) {
        return {
          success: true,
          llmFailed: true,
          error: "llm down",
          nodesAdded: 1,
          edgesAdded: 0,
        };
      }
      return { success: true, nodesAdded: 1, edgesAdded: 0 };
    });
    await seedObservations(h.kv, "ses_1", [obs("o1"), obs("o2")]);

    await h.stopped({ sessionId: "ses_1" });
    expect(await readWatermark(h.kv, "ses_1")).toBeNull();

    llmDown = false;
    await h.stopped({ sessionId: "ses_1" });

    const watermark = await readWatermark(h.kv, "ses_1");
    expect(watermark?.extractedCount).toBe(2);
    expect(watermark?.boundaryObservationId).toBe("o2");
    const lastBatch = h.extractCalls().at(-1)!;
    expect(lastBatch.observations.map((o) => o.id)).toEqual(["o1", "o2"]);
  });

  it("splits a tail larger than the batch size and advances the watermark per batch", async () => {
    vi.mocked(getGraphBatchSize).mockReturnValue(2);
    const h = createEventsHarness(async () => ({ success: true }));
    await seedObservations(h.kv, "ses_1", [
      obs("o1"),
      obs("o2"),
      obs("o3"),
      obs("o4"),
      obs("o5"),
    ]);

    await h.stopped({ sessionId: "ses_1" });

    expect(h.extractCalls().map((b) => b.observations.map((o) => o.id))).toEqual([
      ["o1", "o2"],
      ["o3", "o4"],
      ["o5"],
    ]);
    const watermark = await readWatermark(h.kv, "ses_1");
    expect(watermark?.extractedCount).toBe(5);
    expect(watermark?.boundaryObservationId).toBe("o5");
  });

  it("clamps the batch size to at least 1", async () => {
    vi.mocked(getGraphBatchSize).mockReturnValue(0);
    const h = createEventsHarness(async () => ({ success: true }));
    await seedObservations(h.kv, "ses_1", [obs("o1"), obs("o2")]);

    await h.stopped({ sessionId: "ses_1" });

    expect(h.extractCalls().map((b) => b.observations.map((o) => o.id))).toEqual([
      ["o1"],
      ["o2"],
    ]);
  });

  it("a batch failure stops the loop and the next stop resumes from the last completed batch", async () => {
    vi.mocked(getGraphBatchSize).mockReturnValue(2);
    let failSecondBatch = true;
    const h = createEventsHarness(async (payload) => {
      if (failSecondBatch && payload.observations[0]?.id === "o3") {
        return { success: false, error: "llm exploded" };
      }
      return { success: true };
    });
    await seedObservations(h.kv, "ses_1", [
      obs("o1"),
      obs("o2"),
      obs("o3"),
      obs("o4"),
      obs("o5"),
    ]);

    await h.stopped({ sessionId: "ses_1" });

    const firstStop = h.extractCalls().map((b) => b.observations.map((o) => o.id));
    expect(firstStop[0]).toEqual(["o1", "o2"]);
    expect(firstStop.some((ids) => ids[0] === "o3")).toBe(true);
    expect(firstStop.every((ids) => ids[0] !== "o5")).toBe(true);

    const watermarkAfterFailure = await readWatermark(h.kv, "ses_1");
    expect(watermarkAfterFailure?.extractedCount).toBe(2);
    expect(watermarkAfterFailure?.boundaryObservationId).toBe("o2");

    failSecondBatch = false;
    const callsBefore = h.extractCalls().length;
    await h.stopped({ sessionId: "ses_1" });

    const secondStop = h
      .extractCalls()
      .slice(callsBefore)
      .map((b) => b.observations.map((o) => o.id));
    expect(secondStop).toEqual([
      ["o3", "o4"],
      ["o5"],
    ]);
    const finalWatermark = await readWatermark(h.kv, "ses_1");
    expect(finalWatermark?.extractedCount).toBe(5);
    expect(finalWatermark?.boundaryObservationId).toBe("o5");
  });

  it("retries a throwing batch exactly 3 times in one stop and resumes from it next stop", async () => {
    vi.mocked(getGraphBatchSize).mockReturnValue(2);
    let throwOnFirstBatch = true;
    const h = createEventsHarness(async (payload) => {
      if (throwOnFirstBatch && payload.observations[0]?.id === "o1") {
        throw new Error("graph-extract unreachable");
      }
      return { success: true };
    });
    await seedObservations(h.kv, "ses_1", [obs("o1"), obs("o2"), obs("o3"), obs("o4")]);

    await h.stopped({ sessionId: "ses_1" });

    // Invocation errors retry per batch, capped at GRAPH_EXTRACT_MAX_FAILURES.
    expect(h.extractCalls()).toHaveLength(3);
    expect(h.extractCalls().every((b) => b.observations[0]?.id === "o1")).toBe(
      true,
    );
    expect(await readWatermark(h.kv, "ses_1")).toBeNull();

    throwOnFirstBatch = false;
    await h.stopped({ sessionId: "ses_1" });

    const batches = h.extractCalls();
    expect(batches).toHaveLength(5);
    expect(batches[3].observations.map((o) => o.id)).toEqual(["o1", "o2"]);
    expect(batches[4].observations.map((o) => o.id)).toEqual(["o3", "o4"]);
    const watermark = await readWatermark(h.kv, "ses_1");
    expect(watermark?.extractedCount).toBe(4);
    expect(watermark?.boundaryObservationId).toBe("o4");
  });

  it("counts failures per batch so a recovered batch does not spend the next batch's budget", async () => {
    vi.mocked(getGraphBatchSize).mockReturnValue(2);
    let firstBatchAttempts = 0;
    let throwSecondBatch = true;
    const h = createEventsHarness(async (payload) => {
      const head = payload.observations[0]?.id;
      if (head === "o1") {
        firstBatchAttempts += 1;
        if (firstBatchAttempts <= 2) {
          return { success: false, error: "transient" };
        }
        return { success: true };
      }
      if (throwSecondBatch && head === "o3") {
        throw new Error("graph-extract unreachable");
      }
      return { success: true };
    });
    await seedObservations(h.kv, "ses_1", [
      obs("o1"),
      obs("o2"),
      obs("o3"),
      obs("o4"),
      obs("o5"),
      obs("o6"),
    ]);

    await h.stopped({ sessionId: "ses_1" });

    const firstStop = h
      .extractCalls()
      .map((b) => b.observations.map((o) => o.id));
    expect(firstStop).toEqual([
      ["o1", "o2"],
      ["o1", "o2"],
      ["o1", "o2"],
      ["o3", "o4"],
      ["o3", "o4"],
      ["o3", "o4"],
    ]);
    expect(await readWatermark(h.kv, "ses_1")).toMatchObject({
      extractedCount: 2,
      boundaryObservationId: "o2",
    });

    throwSecondBatch = false;
    await h.stopped({ sessionId: "ses_1" });

    const secondStop = h
      .extractCalls()
      .slice(firstStop.length)
      .map((b) => b.observations.map((o) => o.id));
    expect(secondStop).toEqual([
      ["o3", "o4"],
      ["o5", "o6"],
    ]);
    const watermark = await readWatermark(h.kv, "ses_1");
    expect(watermark?.extractedCount).toBe(6);
    expect(watermark?.boundaryObservationId).toBe("o6");
  });

  it("skipConsolidation skips graph extraction entirely", async () => {
    const h = createEventsHarness(async () => ({ success: true }));
    await seedObservations(h.kv, "ses_1", [obs("o1"), obs("o2")]);

    await h.stopped({ sessionId: "ses_1", skipConsolidation: true });

    expect(h.extractCalls()).toHaveLength(0);
    expect(await readWatermark(h.kv, "ses_1")).toBeNull();
  });

  it("parks without advancing the watermark when the graph snapshot resets mid-run", async () => {
    vi.mocked(getGraphBatchSize).mockReturnValue(1);
    let h!: ReturnType<typeof createEventsHarness>;
    h = createEventsHarness(async () => {
      await h.kv.set(KV.graphSnapshot, "current", {
        version: 1,
        topNodes: [],
        topEdges: [],
        topDegrees: {},
        stats: {
          totalNodes: 0,
          totalEdges: 0,
          nodesByType: {},
          edgesByType: {},
        },
        updatedAt: "2026-02-01T10:00:00.000Z",
        dirty: false,
        resetAt: "2026-02-01T10:00:00.000Z",
      });
      return { success: true };
    });
    await seedObservations(h.kv, "ses_1", [obs("o1"), obs("o2")]);

    await h.stopped({ sessionId: "ses_1" });

    // The reset landed between the snapshot read at start and the batch
    // completion check; the run parks before recording coverage.
    expect(h.extractCalls()).toHaveLength(1);
    expect(await readWatermark(h.kv, "ses_1")).toBeNull();
  });

  it("duplicate concurrent stops for one session serialize through the keyed lock", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = createEventsHarness(async () => {
      await gate;
      return { success: true };
    });
    await seedObservations(h.kv, "ses_1", [obs("o1"), obs("o2")]);

    const first = h.stopped({ sessionId: "ses_1" });
    const second = h.stopped({ sessionId: "ses_1" });
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await Promise.all([first, second]);

    expect(h.extractCalls()).toHaveLength(1);
    const watermark = await readWatermark(h.kv, "ses_1");
    expect(watermark?.extractedCount).toBe(2);
  });
});

describe("mem::graph-extract LLM-leg outcome", () => {
  it("surfaces llmFailed without changing heuristic success", async () => {
    const provider = {
      name: "test",
      compress: vi.fn(async () => {
        throw new Error("llm down");
      }),
      summarize: vi.fn(),
    } as unknown as MemoryProvider;
    const { handlers } = createGraphHarness(provider);
    const extract = handlers.get("mem::graph-extract")!;

    const withHeuristics = (await extract({
      observations: [obs("o1", { files: ["src/a.ts"], concepts: ["auth"] })],
    })) as ExtractResult;
    expect(withHeuristics.success).toBe(true);
    expect(withHeuristics.llmFailed).toBe(true);
    expect(withHeuristics.error).toBe("llm down");

    const noHeuristics = (await extract({ observations: [obs("o2")] })) as ExtractResult;
    expect(noHeuristics.success).toBe(false);
    expect(noHeuristics.llmFailed).toBe(true);
    expect(noHeuristics.error).toBe("llm down");
  });
});

describe("mem::graph-reset clears extraction watermarks", () => {
  async function seedWatermarks(kv: KV) {
    const stamp = "2026-02-01T10:00:00.000Z";
    await kv.set(KV.graphExtractionWatermarks, "ses_1", {
      sessionId: "ses_1",
      extractedCount: 2,
      boundaryObservationId: "o2",
      updatedAt: stamp,
    });
    await kv.set(KV.graphExtractionWatermarks, "ses_2", {
      sessionId: "ses_2",
      extractedCount: 1,
      boundaryObservationId: "a1",
      updatedAt: stamp,
    });
  }

  it("clears every watermark through the snapshot-only branch", async () => {
    const { kv, handlers } = createGraphHarness();
    await seedWatermarks(kv);

    const result = (await handlers.get("mem::graph-reset")!({})) as {
      success: boolean;
      snapshotOnly: boolean;
    };
    expect(result.success).toBe(true);
    expect(result.snapshotOnly).toBe(true);
    expect(await readWatermark(kv, "ses_1")).toBeNull();
    expect(await readWatermark(kv, "ses_2")).toBeNull();
  });

  it("clears every watermark through the confirm path", async () => {
    const { kv, handlers } = createGraphHarness();
    await seedWatermarks(kv);

    const result = (await handlers.get("mem::graph-reset")!({ confirm: true })) as {
      success: boolean;
    };
    expect(result.success).toBe(true);
    expect(await readWatermark(kv, "ses_1")).toBeNull();
    expect(await readWatermark(kv, "ses_2")).toBeNull();
  });

  it("a refused reset (graph_too_large) leaves every watermark intact", async () => {
    const { kv, handlers } = createGraphHarness();
    await seedWatermarks(kv);
    await kv.set(KV.graphNodes, "n1", { id: "n1" });
    await kv.set(KV.graphNodes, "n2", { id: "n2" });

    const result = (await handlers.get("mem::graph-reset")!({
      confirm: true,
      maxRecords: 1,
    })) as {
      success: boolean;
      error?: string;
      totalRecords?: number;
      ceiling?: number;
    };

    expect(result.success).toBe(false);
    expect(result.error).toBe("graph_too_large");
    expect(result.totalRecords).toBe(2);
    expect(result.ceiling).toBe(1);
    // The refusal is non-destructive: the graph rows survive alongside the
    // watermarks, so a later successful reset is still the only thing that
    // invalidates coverage.
    expect(await kv.get(KV.graphNodes, "n1")).toMatchObject({ id: "n1" });
    expect(await kv.get(KV.graphNodes, "n2")).toMatchObject({ id: "n2" });
    expect(await readWatermark(kv, "ses_1")).toMatchObject({
      extractedCount: 2,
      boundaryObservationId: "o2",
    });
    expect(await readWatermark(kv, "ses_2")).toMatchObject({
      extractedCount: 1,
      boundaryObservationId: "a1",
    });
  });
});
