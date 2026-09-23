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
  SessionSummary,
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

function summaryXml(opts: { title: string; narrative?: string }): string {
  return `<summary>
<title>${opts.title}</title>
<narrative>${opts.narrative ?? "A refresh narrative that is long enough for validation."}</narrative>
<decisions></decisions>
<files></files>
<concepts></concepts>
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
        return summaryXml({ title: "Merged" });
      }
      return summaryXml({ title: `call-${calls.length}` });
    },
  };
  return { provider, calls };
}

function existingSummary(
  sessionId: string,
  observationCount: number,
): SessionSummary {
  return {
    sessionId,
    project: "test-project",
    createdAt: "2026-09-01T00:00:00Z",
    title: "Existing summary",
    narrative: "An existing narrative that is long enough.",
    keyDecisions: [],
    filesModified: [],
    concepts: [],
    observationCount,
  };
}

async function setupHandler(opts: {
  sessionId: string;
  obsCount: number;
  provider: MemoryProvider;
  status?: Session["status"];
}) {
  const sdk = mockSdk();
  const kv = mockKV();
  const session: Session = {
    id: opts.sessionId,
    project: "test-project",
    cwd: "/tmp",
    startedAt: new Date().toISOString(),
    status: opts.status ?? "active",
    observationCount: opts.obsCount,
  };
  await kv.set("sessions", opts.sessionId, session);
  for (let i = 0; i < opts.obsCount; i++) {
    const o = makeObs(i, opts.sessionId);
    await kv.set(`obs:${opts.sessionId}`, o.id, o);
  }
  registerSummarizeFunction(sdk as any, kv as any, opts.provider);
  const handler = sdk.functions.get("mem::summarize")!;
  return { handler, kv };
}

async function addObs(
  kv: ReturnType<typeof mockKV>,
  sessionId: string,
  i: number,
): Promise<void> {
  await kv.set(`obs:${sessionId}`, `obs_${i}`, makeObs(i, sessionId));
}

describe("mem::summarize refresh floor", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.SUMMARIZE_CHUNK_SIZE = "100";
    process.env.SUMMARIZE_CHUNK_CONCURRENCY = "1";
    delete process.env.SUMMARIZE_MIN_NEW_OBSERVATIONS;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("tail below floor with existing summary makes no provider call and reports skipped", async () => {
    const { provider, calls } = makeProvider();
    const { handler, kv } = await setupHandler({
      sessionId: "ses_floor_skip",
      obsCount: 8,
      provider,
    });
    const existing = existingSummary("ses_floor_skip", 5);
    await kv.set("summaries", "ses_floor_skip", existing);

    const result: any = await handler({ sessionId: "ses_floor_skip" });

    expect(result.success).toBe(true);
    expect(result.skipped).toBe("below_refresh_floor");
    expect(result.summary).toEqual(existing);
    expect(calls).toHaveLength(0);
    // No partial cache is written on a floor skip.
    expect(await kv.get("summary-partials", "ses_floor_skip")).toBeNull();
  });

  it("tail below floor in a session at or below chunk size also makes no provider call", async () => {
    const { provider, calls } = makeProvider();
    const { handler, kv } = await setupHandler({
      sessionId: "ses_floor_small",
      obsCount: 3,
      provider,
    });
    await kv.set("summaries", "ses_floor_small", existingSummary("ses_floor_small", 1));

    const result: any = await handler({ sessionId: "ses_floor_small" });

    expect(result.success).toBe(true);
    expect(result.skipped).toBe("below_refresh_floor");
    expect(calls).toHaveLength(0);
  });

  it("tail at the floor refreshes and stores", async () => {
    const { provider, calls } = makeProvider();
    const { handler, kv } = await setupHandler({
      sessionId: "ses_floor_at",
      obsCount: 15,
      provider,
    });
    await kv.set("summaries", "ses_floor_at", existingSummary("ses_floor_at", 5));

    const result: any = await handler({ sessionId: "ses_floor_at" });

    expect(result.success).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(calls).toHaveLength(1);
    const stored: any = await kv.get("summaries", "ses_floor_at");
    expect(stored.title).toBe("call-1");
    expect(stored.observationCount).toBe(15);
  });

  it("force with tail below floor refreshes", async () => {
    const { provider, calls } = makeProvider();
    const { handler, kv } = await setupHandler({
      sessionId: "ses_floor_force",
      obsCount: 7,
      provider,
    });
    await kv.set("summaries", "ses_floor_force", existingSummary("ses_floor_force", 5));

    const result: any = await handler({ sessionId: "ses_floor_force", force: true });

    expect(result.success).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(calls).toHaveLength(1);
    const stored: any = await kv.get("summaries", "ses_floor_force");
    expect(stored.observationCount).toBe(7);
  });

  it("completed session with a below-floor tail still refreshes via a bounded tail call", async () => {
    const { provider, calls } = makeProvider();
    const { handler, kv } = await setupHandler({
      sessionId: "ses_floor_terminal",
      obsCount: 5,
      provider,
    });

    const first: any = await handler({ sessionId: "ses_floor_terminal" });
    expect(first.success).toBe(true);
    expect(calls).toHaveLength(1);

    calls.length = 0;
    for (let i = 5; i < 7; i++) await addObs(kv, "ses_floor_terminal", i);
    const session: any = await kv.get("sessions", "ses_floor_terminal");
    await kv.set("sessions", "ses_floor_terminal", {
      ...session,
      status: "completed",
      observationCount: 7,
    });

    const second: any = await handler({ sessionId: "ses_floor_terminal" });

    expect(second.success).toBe(true);
    expect(second.skipped).toBeUndefined();
    // Tail-only: 1 chunk call for obs 6-7 + 1 reduce fold with the prior summary.
    expect(calls).toHaveLength(2);
    expect(calls[0].user).toContain("Session observations (2 total)");
    expect(calls[1].user).toContain("Partial summaries (2 chunks");
    const stored: any = await kv.get("summaries", "ses_floor_terminal");
    expect(stored.observationCount).toBe(7);
  });

  it("floor 0 with no new observations still honors the already-covered skip", async () => {
    process.env.SUMMARIZE_MIN_NEW_OBSERVATIONS = "0";
    const { provider, calls } = makeProvider();
    const { handler, kv } = await setupHandler({
      sessionId: "ses_floor_zero_covered",
      obsCount: 5,
      provider,
    });
    await kv.set("summaries", "ses_floor_zero_covered", existingSummary("ses_floor_zero_covered", 5));

    const result: any = await handler({ sessionId: "ses_floor_zero_covered" });

    expect(result.success).toBe(true);
    expect(result.skipped).toBe("already_summarized");
    expect(calls).toHaveLength(0);
  });

  it("missing summary always refreshes regardless of floor", async () => {
    const { provider, calls } = makeProvider();
    const { handler, kv } = await setupHandler({
      sessionId: "ses_floor_missing",
      obsCount: 3,
      provider,
    });

    const result: any = await handler({ sessionId: "ses_floor_missing" });

    expect(result.success).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(calls).toHaveLength(1);
    const stored: any = await kv.get("summaries", "ses_floor_missing");
    expect(stored.observationCount).toBe(3);
  });

  it("invalid override falls back to the default floor", async () => {
    process.env.SUMMARIZE_MIN_NEW_OBSERVATIONS = "not-a-number";
    const { provider, calls } = makeProvider();
    const { handler, kv } = await setupHandler({
      sessionId: "ses_floor_invalid",
      obsCount: 8,
      provider,
    });
    await kv.set("summaries", "ses_floor_invalid", existingSummary("ses_floor_invalid", 5));

    const result: any = await handler({ sessionId: "ses_floor_invalid" });

    expect(result.success).toBe(true);
    expect(result.skipped).toBe("below_refresh_floor");
    expect(calls).toHaveLength(0);
  });

  it("'0' is honored as a valid floor (refresh every turn)", async () => {
    process.env.SUMMARIZE_MIN_NEW_OBSERVATIONS = "0";
    const { provider, calls } = makeProvider();
    const { handler, kv } = await setupHandler({
      sessionId: "ses_floor_zero",
      obsCount: 8,
      provider,
    });
    await kv.set("summaries", "ses_floor_zero", existingSummary("ses_floor_zero", 5));

    const result: any = await handler({ sessionId: "ses_floor_zero" });

    expect(result.success).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(calls).toHaveLength(1);
    const stored: any = await kv.get("summaries", "ses_floor_zero");
    expect(stored.observationCount).toBe(8);
  });
});
