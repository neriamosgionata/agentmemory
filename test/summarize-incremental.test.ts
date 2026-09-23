import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/state/schema.js", () => ({
  KV: {
    sessions: "sessions",
    summaries: "summaries",
    summaryPartials: "summary-partials",
    observations: (sessionId: string) => `obs:${sessionId}`,
    audit: "audit",
  },
}));

vi.mock("../src/eval/schemas.js", () => ({
  SummaryOutputSchema: {},
}));

vi.mock("../src/eval/validator.js", () => ({
  validateOutput: vi.fn(() => ({ valid: true, result: { errors: [] } })),
}));

vi.mock("../src/eval/quality.js", () => ({
  scoreSummary: () => 100,
}));

vi.mock("../src/functions/audit.js", () => ({
  safeAudit: vi.fn(),
}));

import { registerSummarizeFunction } from "../src/functions/summarize.js";
import type {
  CompressedObservation,
  Session,
  MemoryProvider,
} from "../src/types.js";

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
  const functions = new Map<string, Function>();
  return {
    functions,
    registerFunction: (id: string, handler: Function) => {
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async () => ({}),
  };
}

function makeObs(i: number, sessionId: string): CompressedObservation {
  return {
    id: `obs_${i}`,
    sessionId,
    timestamp: new Date().toISOString(),
    type: "conversation",
    title: `obs ${i}`,
    facts: [`fact ${i}`],
    narrative: `narrative for obs ${i}`,
    concepts: [],
    files: [`src/file_${i}.ts`],
    importance: 5,
  };
}

function summaryXml(opts: {
  title: string;
  narrative?: string;
  decisions?: string[];
  files?: string[];
  concepts?: string[];
}): string {
  const d = (opts.decisions ?? []).map((x) => `<decision>${x}</decision>`).join("");
  const f = (opts.files ?? []).map((x) => `<file>${x}</file>`).join("");
  const c = (opts.concepts ?? []).map((x) => `<concept>${x}</concept>`).join("");
  return `<summary>
<title>${opts.title}</title>
<narrative>${opts.narrative ?? "narrative"}</narrative>
<decisions>${d}</decisions>
<files>${f}</files>
<concepts>${c}</concepts>
</summary>`;
}

const REDUCE_MARKER = "merging multiple partial summaries";

function makeProvider(): {
  provider: MemoryProvider;
  calls: Array<{ system: string; user: string }>;
} {
  const calls: Array<{ system: string; user: string }> = [];
  const provider: MemoryProvider = {
    name: "test",
    compress: async () => "",
    summarize: async (system: string, user: string) => {
      calls.push({ system, user });
      if (system.includes(REDUCE_MARKER)) {
        return summaryXml({
          title: "Merged",
          narrative: "A merged narrative that is long enough for validation.",
        });
      }
      return summaryXml({
        title: `chunk-${calls.length}`,
        narrative: `Chunk narrative ${calls.length} is long enough.`,
      });
    },
  };
  return { provider, calls };
}

async function addObs(
  kv: ReturnType<typeof mockKV>,
  sessionId: string,
  i: number,
): Promise<void> {
  await kv.set(`obs:${sessionId}`, `obs_${i}`, makeObs(i, sessionId));
}

async function setupHandler(opts: {
  sessionId: string;
  obsCount: number;
  provider: MemoryProvider;
}) {
  const sdk = mockSdk();
  const kv = mockKV();
  const session: Session = {
    id: opts.sessionId,
    project: "test-project",
    cwd: "/tmp",
    startedAt: new Date().toISOString(),
    status: "completed",
    observationCount: opts.obsCount,
  };
  await kv.set("sessions", opts.sessionId, session);
  for (let i = 0; i < opts.obsCount; i++) await addObs(kv, opts.sessionId, i);
  registerSummarizeFunction(sdk as any, kv as any, opts.provider);
  const handler = sdk.functions.get("mem::summarize")!;
  return { handler, kv };
}

describe("mem::summarize incremental chunk partial cache", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.SUMMARIZE_CHUNK_SIZE = "100";
    process.env.SUMMARIZE_CHUNK_CONCURRENCY = "1";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("growing session: second summarize sends only the appended chunk plus a bounded reduce", async () => {
    const { provider, calls } = makeProvider();
    const { handler, kv } = await setupHandler({
      sessionId: "ses_grow_partial",
      obsCount: 250,
      provider,
    });

    const first: any = await handler({ sessionId: "ses_grow_partial" });
    expect(first.success).toBe(true);
    expect(calls).toHaveLength(4); // 3 chunk calls + 1 reduce
    expect(calls[3].user).toContain("Partial summaries (3 chunks");

    calls.length = 0;
    for (let i = 250; i < 350; i++) await addObs(kv, "ses_grow_partial", i);

    const second: any = await handler({ sessionId: "ses_grow_partial" });
    expect(second.success).toBe(true);
    expect(calls).toHaveLength(2); // appended chunk + reduce only
    expect(calls[0].system).toContain("session summarizer");
    expect(calls[0].user).toContain("Session observations (100 total)");
    expect(calls[0].user).toContain("obs 250");
    expect(calls[0].user).toContain("obs 349");
    expect(calls[0].user).not.toContain("obs 249");
    expect(calls[1].system).toContain(REDUCE_MARKER);
    // Reduce input bounded to the prior summary + the appended chunk, not
    // all four chunk partials.
    expect(calls[1].user).toContain("Partial summaries (2 chunks");
    expect(calls[1].user).toContain("obs 1-250");
    expect(calls[1].user).toContain("obs 251-350");

    const stored: any = await kv.get("summaries", "ses_grow_partial");
    expect(stored.title).toBe("Merged");
    expect(stored.observationCount).toBe(350);
    expect(Object.keys(stored).sort()).toEqual(
      [
        "sessionId",
        "project",
        "createdAt",
        "title",
        "narrative",
        "keyDecisions",
        "filesModified",
        "concepts",
        "observationCount",
      ].sort(),
    );

    const cache: any = await kv.get("summary-partials", "ses_grow_partial");
    expect(cache.sessionId).toBe("ses_grow_partial");
    expect(cache.chunkSize).toBe(100);
    expect(cache.coveredCount).toBe(350);
    expect(typeof cache.updatedAt).toBe("string");
    expect(
      cache.chunks.map((c: any) => [c.rangeStart, c.rangeEnd]),
    ).toEqual([
      [1, 100],
      [101, 200],
      [201, 250],
      [251, 350],
    ]);
    expect(cache.chunks[0].boundaryObservationId).toBe("obs_99");
    expect(cache.chunks[3].boundaryObservationId).toBe("obs_349");
    expect(cache.chunks[0].partial.title).toBeTruthy();
  });

  it("session at or below chunk size: second refresh reuses its stored partial and sends only the appended tail", async () => {
    const { provider, calls } = makeProvider();
    const { handler, kv } = await setupHandler({
      sessionId: "ses_small_tail",
      obsCount: 5,
      provider,
    });

    const first: any = await handler({ sessionId: "ses_small_tail" });
    expect(first.success).toBe(true);
    expect(calls).toHaveLength(1); // whole session in one call

    calls.length = 0;
    for (let i = 5; i < 8; i++) await addObs(kv, "ses_small_tail", i);

    const second: any = await handler({ sessionId: "ses_small_tail" });
    expect(second.success).toBe(true);
    expect(calls).toHaveLength(2); // appended tail + fold
    expect(calls[0].user).toContain("Session observations (3 total)");
    expect(calls[0].user).toContain("obs 5");
    expect(calls[0].user).toContain("obs 7");
    expect(calls[0].user).not.toContain("obs 4");
    expect(calls[1].user).toContain("Partial summaries (2 chunks");
    expect(calls[1].user).toContain("obs 1-5");
    expect(calls[1].user).toContain("obs 6-8");

    const cache: any = await kv.get("summary-partials", "ses_small_tail");
    expect(cache.coveredCount).toBe(8);
    expect(
      cache.chunks.map((c: any) => [c.rangeStart, c.rangeEnd]),
    ).toEqual([
      [1, 5],
      [6, 8],
    ]);
  });

  // U1 adaptation: the refresh floor (U2) does not exist yet, so this exercises
  // the same cache path with appended observations that cross a chunk boundary.
  // The cached partial stays valid; only the uncovered tail is summarized.
  it("appending into an incomplete tail chunk reuses covered chunks and summarizes only the uncovered tail", async () => {
    const { provider, calls } = makeProvider();
    const { handler, kv } = await setupHandler({
      sessionId: "ses_tail_chunk",
      obsCount: 100,
      provider,
    });

    const first: any = await handler({ sessionId: "ses_tail_chunk" });
    expect(first.success).toBe(true);
    expect(calls).toHaveLength(1); // 100 obs == chunk size, single call

    calls.length = 0;
    // Crosses the chunk boundary at obs 100: new observations land in the
    // previously untouched, incomplete grid chunk [101..].
    for (let i = 100; i < 130; i++) await addObs(kv, "ses_tail_chunk", i);
    const second: any = await handler({ sessionId: "ses_tail_chunk" });
    expect(second.success).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].user).toContain("Session observations (30 total)");
    expect(calls[1].user).toContain("obs 101-130");

    calls.length = 0;
    // Grows inside the same incomplete chunk; the cached 101-130 partial is
    // reused and only the appended 131-170 tail reaches the LLM.
    for (let i = 130; i < 170; i++) await addObs(kv, "ses_tail_chunk", i);
    const third: any = await handler({ sessionId: "ses_tail_chunk" });
    expect(third.success).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].user).toContain("Session observations (40 total)");
    expect(calls[0].user).toContain("obs 130");
    expect(calls[0].user).toContain("obs 169");
    expect(calls[0].user).not.toContain("obs 129");
    expect(calls[1].user).toContain("obs 1-130");
    expect(calls[1].user).toContain("obs 131-170");

    const cache: any = await kv.get("summary-partials", "ses_tail_chunk");
    expect(cache.coveredCount).toBe(170);
    expect(
      cache.chunks.map((c: any) => [c.rangeStart, c.rangeEnd]),
    ).toEqual([
      [1, 100],
      [101, 130],
      [131, 170],
    ]);
  });

  it("chunk-size change invalidates the cache and triggers a full recompute", async () => {
    const { provider, calls } = makeProvider();
    const { handler, kv } = await setupHandler({
      sessionId: "ses_chunksize",
      obsCount: 150,
      provider,
    });

    const first: any = await handler({ sessionId: "ses_chunksize" });
    expect(first.success).toBe(true);
    expect(calls).toHaveLength(3); // 2 chunks + reduce

    calls.length = 0;
    process.env.SUMMARIZE_CHUNK_SIZE = "50";
    for (let i = 150; i < 160; i++) await addObs(kv, "ses_chunksize", i);

    const second: any = await handler({ sessionId: "ses_chunksize" });
    expect(second.success).toBe(true);
    // 160 obs at chunkSize 50 -> 4 chunks re-summarized + reduce.
    expect(calls).toHaveLength(5);
    expect(calls[4].user).toContain("Partial summaries (4 chunks");
    expect(calls[0].user).toContain("Session observations (50 total)");

    const cache: any = await kv.get("summary-partials", "ses_chunksize");
    expect(cache.chunkSize).toBe(50);
    expect(cache.coveredCount).toBe(160);
    expect(cache.chunks).toHaveLength(4);
  });

  it("boundary mismatch from a deleted observation discards the cache", async () => {
    const { provider, calls } = makeProvider();
    const { handler, kv } = await setupHandler({
      sessionId: "ses_boundary",
      obsCount: 250,
      provider,
    });

    const first: any = await handler({ sessionId: "ses_boundary" });
    expect(first.success).toBe(true);
    expect(calls).toHaveLength(4); // 3 chunks + reduce

    calls.length = 0;
    kv.store.get("obs:ses_boundary")!.delete("obs_50");
    for (let i = 250; i < 310; i++) await addObs(kv, "ses_boundary", i);

    const second: any = await handler({ sessionId: "ses_boundary" });
    expect(second.success).toBe(true);
    // 309 obs after deletion + append: full recompute, not a tail fold.
    expect(calls).toHaveLength(5); // 4 chunks + reduce
    expect(calls[4].user).toContain("Partial summaries (4 chunks");
    expect(calls[0].user).toContain("obs 0");

    const cache: any = await kv.get("summary-partials", "ses_boundary");
    expect(cache.coveredCount).toBe(309);
    expect(cache.chunks).toHaveLength(4);
  });

  it("failed summarize leaves the stored summary and partial cache untouched", async () => {
    const calls: Array<{ system: string; user: string }> = [];
    let failReduce = false;
    const provider: MemoryProvider = {
      name: "test",
      compress: async () => "",
      summarize: async (system: string, user: string) => {
        calls.push({ system, user });
        if (system.includes(REDUCE_MARKER)) {
          return failReduce ? "no xml here" : summaryXml({ title: "Merged" });
        }
        return summaryXml({ title: "chunk" });
      },
    };
    const { handler, kv } = await setupHandler({
      sessionId: "ses_fail_keep",
      obsCount: 150,
      provider,
    });

    const first: any = await handler({ sessionId: "ses_fail_keep" });
    expect(first.success).toBe(true);
    const summaryBefore: any = await kv.get("summaries", "ses_fail_keep");
    const cacheBefore: any = await kv.get("summary-partials", "ses_fail_keep");
    expect(cacheBefore.coveredCount).toBe(150);
    const callsBefore = calls.length;

    failReduce = true;
    for (let i = 150; i < 200; i++) await addObs(kv, "ses_fail_keep", i);

    const second: any = await handler({ sessionId: "ses_fail_keep" });
    expect(second.success).toBe(false);
    expect(second.error).toBe("parse_failed");
    expect(
      calls.slice(callsBefore).filter((c) => c.system.includes(REDUCE_MARKER)),
    ).toHaveLength(2); // reduce retried once per produce attempt

    const summaryAfter: any = await kv.get("summaries", "ses_fail_keep");
    const cacheAfter: any = await kv.get("summary-partials", "ses_fail_keep");
    expect(summaryAfter).toEqual(summaryBefore);
    expect(cacheAfter).toEqual(cacheBefore);
  });

  it("duplicate concurrent summarize calls serialize into one provider run", async () => {
    const calls: Array<{ system: string; user: string }> = [];
    const provider: MemoryProvider = {
      name: "test",
      compress: async () => "",
      summarize: async (system: string, user: string) => {
        calls.push({ system, user });
        await new Promise((r) => setTimeout(r, 25));
        return summaryXml({ title: "solo" });
      },
    };
    const { handler } = await setupHandler({
      sessionId: "ses_concurrent",
      obsCount: 5,
      provider,
    });

    const [r1, r2]: any[] = await Promise.all([
      handler({ sessionId: "ses_concurrent" }),
      handler({ sessionId: "ses_concurrent" }),
    ]);

    expect(calls).toHaveLength(1);
    expect([r1, r2].filter((r) => r.success)).toHaveLength(2);
    expect(
      [r1, r2].filter((r) => r.skipped === "already_summarized"),
    ).toHaveLength(1);
  });

  it("session below chunk size with no prior summary makes exactly one provider call", async () => {
    const { provider, calls } = makeProvider();
    const { handler, kv } = await setupHandler({
      sessionId: "ses_first",
      obsCount: 5,
      provider,
    });

    const result: any = await handler({ sessionId: "ses_first" });

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    const cache: any = await kv.get("summary-partials", "ses_first");
    expect(cache.chunks).toHaveLength(1);
    expect(cache.chunks[0].rangeStart).toBe(1);
    expect(cache.chunks[0].rangeEnd).toBe(5);
    expect(cache.chunks[0].boundaryObservationId).toBe("obs_4");
    expect(cache.chunks[0].partial.title).toBeTruthy();
    expect(typeof cache.updatedAt).toBe("string");
  });
});
