import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerObserveFunction } from "../src/functions/observe.js";
import { registerEvictFunction } from "../src/functions/evict.js";
import { registerRememberFunction } from "../src/functions/remember.js";
import {
  getProjectSessionIndex,
  rebuildAllProjectSessionIndexes,
} from "../src/state/session-index.js";
import { lookupObservationSession } from "../src/state/obs-index.js";
import { KV } from "../src/state/schema.js";
import type { Session } from "../src/types.js";

function mockKV() {
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
    update: vi.fn(
      async (
        scope: string,
        key: string,
        updates: Array<{ path: string; value: unknown }>,
      ) => {
        const entries = store.get(scope);
        if (!entries) return;
        const value = (entries.get(key) as Record<string, unknown>) ?? {};
        for (const u of updates) value[u.path] = u.value;
        entries.set(key, value);
      },
    ),
    delete: vi.fn(async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    }),
    list: vi.fn(async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    }),
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (
      idOrOpts: string | { id: string },
      handler: Function,
    ) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id =
        typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (fn) return fn(payload);
      return null;
    },
  };
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function makeStaleSession(id: string, project: string): Session {
  return {
    id,
    project,
    cwd: `/repo/${project}`,
    startedAt: daysAgo(31),
    status: "active",
    observationCount: 0,
  };
}

describe("observe — populates the session and observation indexes", () => {
  it("stores a retrievable session-to-observation mapping", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::observe", {
      sessionId: "ses_idx_1",
      project: "proj-idx",
      cwd: "/repo/proj-idx",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: { tool_name: "Edit", tool_input: { file: "a.ts" } },
    })) as { observationId: string };

    expect(result.observationId).toBeTruthy();
    expect(
      await lookupObservationSession(kv as never, result.observationId),
    ).toBe("ses_idx_1");
    expect(
      (await getProjectSessionIndex(kv as never, "proj-idx"))?.map(
        (e) => e.id,
      ),
    ).toContain("ses_idx_1");
  });
});

describe("mem::forget — cleans the session and observation indexes", () => {
  it("removes the forgotten session and its observations without orphans", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);
    registerRememberFunction(sdk as never, kv as never);

    const observed = (await sdk.trigger("mem::observe", {
      sessionId: "ses_forget",
      project: "proj-forget",
      cwd: "/repo/proj-forget",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: { tool_name: "Edit", tool_input: { file: "a.ts" } },
    })) as { observationId: string };
    expect(
      await lookupObservationSession(kv as never, observed.observationId),
    ).toBe("ses_forget");

    await sdk.trigger({
      function_id: "mem::forget",
      payload: { sessionId: "ses_forget" },
    });

    expect(
      await lookupObservationSession(kv as never, observed.observationId),
    ).toBeNull();
    expect(await getProjectSessionIndex(kv as never, "proj-forget")).toEqual(
      [],
    );
    expect(await kv.get(KV.sessions, "ses_forget")).toBeNull();
  });
});

describe("mem::evict — bulk removal without orphans or rescans", () => {
  it("removes 100 stale sessions from one project with at most one sessions listing", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerEvictFunction(sdk as never, kv as never);

    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      const id = `ses_bulk_${i}`;
      ids.push(id);
      await kv.set(KV.sessions, id, makeStaleSession(id, "proj-bulk"));
    }
    await rebuildAllProjectSessionIndexes(kv as never);
    expect(
      (await getProjectSessionIndex(kv as never, "proj-bulk"))?.length,
    ).toBe(50);

    kv.list.mockClear();
    kv.get.mockClear();
    kv.set.mockClear();
    kv.delete.mockClear();

    const result = (await sdk.trigger({
      function_id: "mem::evict",
      payload: {},
    })) as { staleSessions: number };

    expect(result.staleSessions).toBe(100);
    expect(
      kv.list.mock.calls.filter((c) => c[0] === KV.sessions),
    ).toHaveLength(1);
    expect(await getProjectSessionIndex(kv as never, "proj-bulk")).toEqual([]);
    for (const id of ids) {
      expect(await kv.get(KV.sessions, id)).toBeNull();
    }
  });
});
