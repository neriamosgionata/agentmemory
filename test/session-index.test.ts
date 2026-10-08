import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerContextFunction } from "../src/functions/context.js";
import {
  addSessionToProjectIndex,
  removeSessionFromProjectIndex,
  getProjectSessionIndex,
  buildProjectSessionIndex,
  ensureProjectSessionIndex,
  rebuildAllProjectSessionIndexes,
  rebuildSessionIndexIfStale,
} from "../src/state/session-index.js";
import { KV } from "../src/state/schema.js";
import type { Session } from "../src/types.js";

function mockKV(listFailures: Set<string> = new Set()) {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
    get: vi.fn(async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    }),
    set: vi.fn(async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    }),
    delete: vi.fn(async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    }),
    list: vi.fn(async <T>(scope: string): Promise<T[]> => {
      if (listFailures.has(scope)) throw new Error(`list failed for ${scope}`);
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    }),
  };
}

type ContextHandler = (data: {
  sessionId: string;
  project: string;
  budget?: number;
}) => Promise<{ context: string; blocks: number; tokens: number }>;

function wireContext(kv: ReturnType<typeof mockKV>, budget = 4000) {
  let handler: ContextHandler | undefined;
  const sdk = {
    registerFunction: vi.fn((id: string, cb: ContextHandler) => {
      if (id === "mem::context") handler = cb;
    }),
    registerTrigger: vi.fn(),
    trigger: vi.fn(),
  };
  registerContextFunction(sdk as never, kv as never, budget);
  if (!handler) throw new Error("mem::context not registered");
  return handler;
}

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: over.id ?? `ses_${Math.random().toString(36).slice(2)}`,
    project: over.project ?? "/tmp/proj",
    cwd: over.cwd ?? "/tmp/proj",
    startedAt: over.startedAt ?? new Date().toISOString(),
    status: over.status ?? "completed",
    observationCount: over.observationCount ?? 0,
    ...(over.agentId ? { agentId: over.agentId } : {}),
  };
}

describe("project session index — maintenance", () => {
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    kv = mockKV();
  });

  it("addSessionToProjectIndex creates the index for a new project", async () => {
    await addSessionToProjectIndex(kv as never, "proj-a", {
      id: "ses_1",
      startedAt: "2026-01-01T00:00:00Z",
    });

    const index = await getProjectSessionIndex(kv as never, "proj-a");
    expect(index).toEqual([{ id: "ses_1", startedAt: "2026-01-01T00:00:00Z" }]);
  });

  it("merges entries newest-first and seeds from stored sessions on cold start", async () => {
    const stored = makeSession({
      id: "ses_old",
      project: "proj-a",
      startedAt: "2026-01-01T00:00:00Z",
    });
    await kv.set(KV.sessions, stored.id, stored);

    await addSessionToProjectIndex(kv as never, "proj-a", {
      id: "ses_new",
      startedAt: "2026-02-01T00:00:00Z",
    });

    const index = await getProjectSessionIndex(kv as never, "proj-a");
    expect(index?.map((e) => e.id)).toEqual(["ses_new", "ses_old"]);
  });

  it("drops the project index when an add cannot be written, so the next read rebuilds it", async () => {
    await addSessionToProjectIndex(kv as never, "proj-a", {
      id: "ses_1",
      startedAt: "2026-01-01T00:00:00Z",
    });
    kv.set.mockRejectedValueOnce(new Error("write failed"));

    await expect(
      addSessionToProjectIndex(kv as never, "proj-a", {
        id: "ses_2",
        startedAt: "2026-02-01T00:00:00Z",
      }),
    ).rejects.toThrow("write failed");
    expect(await getProjectSessionIndex(kv as never, "proj-a")).toBeNull();
  });

  it("removeSessionFromProjectIndex drops the entry without rescanning sessions", async () => {
    await addSessionToProjectIndex(kv as never, "proj-a", {
      id: "ses_1",
      startedAt: "2026-01-01T00:00:00Z",
    });
    kv.list.mockClear();

    await removeSessionFromProjectIndex(kv as never, "proj-a", "ses_1");

    expect(await getProjectSessionIndex(kv as never, "proj-a")).toEqual([]);
    expect(
      kv.list.mock.calls.some(([scope]) => scope === KV.sessions),
    ).toBe(false);
  });

  it("caps at 50 entries while reserving slots per agent", async () => {
    const entries = [
      ...Array.from({ length: 50 }, (_, i) => ({
        id: `ses_a_${i}`,
        startedAt: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
        agentId: "agent-a",
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `ses_b_${i}`,
        startedAt: `2026-03-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
        agentId: "agent-b",
      })),
    ];
    const capped = buildProjectSessionIndex(entries);
    expect(capped.length).toBe(50);
    expect(capped.filter((e) => e.agentId === "agent-b").length).toBe(10);
  });

  it("ensureProjectSessionIndex returns the existing index without writing", async () => {
    await addSessionToProjectIndex(kv as never, "proj-a", {
      id: "ses_1",
      startedAt: "2026-01-01T00:00:00Z",
    });
    kv.set.mockClear();

    const ensured = await ensureProjectSessionIndex(kv as never, "proj-a", []);
    expect(ensured.map((e) => e.id)).toEqual(["ses_1"]);
    expect(kv.set).not.toHaveBeenCalled();
  });
});

describe("mem::context — reads the project session index", () => {
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    kv = mockKV();
  });

  it("serves project sessions from the index without listing all sessions", async () => {
    const target = makeSession({ id: "ses_target", project: "proj-a" });
    const other = makeSession({ id: "ses_other", project: "proj-b" });
    await kv.set(KV.sessions, target.id, target);
    await kv.set(KV.sessions, other.id, other);
    await kv.set(KV.summaries, target.id, {
      sessionId: target.id,
      title: "Target work",
      narrative: "Did target things",
      keyDecisions: [],
      filesModified: [],
      createdAt: new Date().toISOString(),
    });
    await kv.set(KV.summaries, other.id, {
      sessionId: other.id,
      title: "Other work",
      narrative: "Did other things",
      keyDecisions: [],
      filesModified: [],
      createdAt: new Date().toISOString(),
    });
    await addSessionToProjectIndex(kv as never, "proj-a", {
      id: target.id,
      startedAt: target.startedAt,
    });
    kv.list.mockClear();

    const handler = wireContext(kv);
    const result = await handler({ sessionId: "ses_self", project: "proj-a" });

    expect(result.context).toContain("Target work");
    expect(result.context).not.toContain("Other work");
    expect(
      kv.list.mock.calls.some(([scope]) => scope === KV.sessions),
    ).toBe(false);
  });

  it("falls back to a full scan when the index is missing, then writes it", async () => {
    const target = makeSession({ id: "ses_target", project: "proj-a" });
    await kv.set(KV.sessions, target.id, target);
    await kv.set(KV.summaries, target.id, {
      sessionId: target.id,
      title: "Target work",
      narrative: "Did target things",
      keyDecisions: [],
      filesModified: [],
      createdAt: new Date().toISOString(),
    });

    const handler = wireContext(kv);
    const result = await handler({ sessionId: "ses_self", project: "proj-a" });

    expect(result.context).toContain("Target work");
    const index = await getProjectSessionIndex(kv as never, "proj-a");
    expect(index?.map((e) => e.id)).toContain("ses_target");
  });
});

describe("project session index — rebuild and self-heal", () => {
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    kv = mockKV();
  });

  it("rebuildAllProjectSessionIndexes groups sessions by project", async () => {
    await kv.set(KV.sessions, "s1", makeSession({ id: "s1", project: "p1" }));
    await kv.set(KV.sessions, "s2", makeSession({ id: "s2", project: "p1" }));
    await kv.set(KV.sessions, "s3", makeSession({ id: "s3", project: "p2" }));

    const result = await rebuildAllProjectSessionIndexes(kv as never);

    expect(result).toEqual({ projects: 2, sessions: 3 });
    expect(
      (await getProjectSessionIndex(kv as never, "p1"))?.map((e) => e.id).sort(),
    ).toEqual(["s1", "s2"]);
    expect(
      (await getProjectSessionIndex(kv as never, "p2"))?.map((e) => e.id),
    ).toEqual(["s3"]);
  });

  it("rebuild restores a dropped index", async () => {
    const target = makeSession({ id: "ses_target", project: "proj-a" });
    await kv.set(KV.sessions, target.id, target);
    await rebuildAllProjectSessionIndexes(kv as never);
    await kv.delete(KV.projectSessionsIndex, "proj-a");
    expect(await getProjectSessionIndex(kv as never, "proj-a")).toBeNull();

    await rebuildAllProjectSessionIndexes(kv as never);

    expect(
      (await getProjectSessionIndex(kv as never, "proj-a"))?.map((e) => e.id),
    ).toEqual(["ses_target"]);
  });

  it("rebuildSessionIndexIfStale runs once behind the generation marker", async () => {
    await kv.set(KV.sessions, "s1", makeSession({ id: "s1", project: "p1" }));

    const first = await rebuildSessionIndexIfStale(kv as never);
    expect(first).toEqual({ projects: 1, sessions: 1 });

    const second = await rebuildSessionIndexIfStale(kv as never);
    expect(second).toBeNull();
  });
});
