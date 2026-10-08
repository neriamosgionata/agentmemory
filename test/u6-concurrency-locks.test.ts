import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { mockKV, mockSdk } from "./helpers/mocks.js";
import { withKeyedLock } from "../src/state/keyed-mutex.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { registerEventTriggers } from "../src/triggers/events.js";
import { registerCascadeFunction } from "../src/functions/cascade.js";
import { registerMeshFunction } from "../src/functions/mesh.js";
import { registerTemporalGraphFunctions } from "../src/functions/temporal-graph.js";
import { registerGraphFunction } from "../src/functions/graph.js";
import { KV } from "../src/state/schema.js";
import type { GraphNode, Memory, Session } from "../src/types.js";

const SECRET = "u6-lock-test-secret";

function apiSdk(kv: ReturnType<typeof mockKV>) {
  const sdk = mockSdk();
  registerApiTriggers(sdk as never, kv as never, SECRET);
  const fns = (sdk as unknown as { fns: Map<string, (d: unknown) => Promise<unknown>> }).fns;
  fns.set(
    "mem::context",
    (async () => ({ context: "ctx" })) as (d: unknown) => Promise<unknown>,
  );
  fns.set(
    "event::session::stopped",
    (async () => ({ success: true })) as (d: unknown) => Promise<unknown>,
  );
  return { sdk, fns };
}

function eventSdk(kv: ReturnType<typeof mockKV>) {
  const sdk = mockSdk();
  registerEventTriggers(sdk as never, kv as never);
  const fns = (sdk as unknown as { fns: Map<string, (d: unknown) => Promise<unknown>> }).fns;
  fns.set(
    "mem::context",
    (async () => ({ context: "ctx" })) as (d: unknown) => Promise<unknown>,
  );
  return { sdk, fns };
}

async function flushMacrotasks(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function seedSession(kv: ReturnType<typeof mockKV>, session: Session): Promise<Session> {
  return kv.set(KV.sessions, session.id, session);
}

describe("U6 session write paths share the obs: lock namespace", () => {
  it("api::session::start merges onto an observe-created row instead of resetting it", async () => {
    const kv = mockKV();
    const { fns } = apiSdk(kv);
    await seedSession(kv, {
      id: "s1",
      project: "demo",
      cwd: "/tmp/demo",
      startedAt: "2026-10-01T00:00:00.000Z",
      status: "active",
      observationCount: 5,
      firstPrompt: "original prompt",
      commitShas: ["abc1234"],
    });
    const handler = fns.get("api::session::start")!;
    const res = (await handler({
      body: { sessionId: "s1", project: "demo", cwd: "/tmp/demo" },
    })) as { status_code: number; body: { session: Session } };
    expect(res.status_code).toBe(200);
    const row = await kv.get<Session>(KV.sessions, "s1");
    expect(row?.observationCount).toBe(5);
    expect(row?.commitShas).toEqual(["abc1234"]);
    expect(row?.firstPrompt).toBe("original prompt");
    expect(row?.status).toBe("active");
  });

  it("event::session::started merges onto an existing row instead of resetting it", async () => {
    const kv = mockKV();
    const { fns } = eventSdk(kv);
    await seedSession(kv, {
      id: "s2",
      project: "demo",
      cwd: "/tmp/demo",
      startedAt: "2026-10-01T00:00:00.000Z",
      status: "active",
      observationCount: 3,
      commitShas: ["def5678"],
    });
    const handler = fns.get("event::session::started")!;
    await handler({ sessionId: "s2", project: "demo", cwd: "/tmp/demo" });
    const row = await kv.get<Session>(KV.sessions, "s2");
    expect(row?.observationCount).toBe(3);
    expect(row?.commitShas).toEqual(["def5678"]);
  });

  it("api::session::commit links the session under the obs: lock, not session:", async () => {
    const kv = mockKV();
    const { fns } = apiSdk(kv);
    await seedSession(kv, {
      id: "s3b",
      project: "demo",
      cwd: "/tmp/demo",
      startedAt: "2026-10-01T00:00:00.000Z",
      status: "active",
      observationCount: 2,
    });
    let release!: () => void;
    const held = withKeyedLock(
      "obs:s3b",
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const commit = fns.get("api::session::commit")!;
    const pending = commit({ body: { sha: "abc1234", sessionId: "s3b" } });
    await flushMacrotasks();
    const during = await kv.get<Session>(KV.sessions, "s3b");
    expect(during?.commitShas ?? []).not.toContain("abc1234");
    release();
    await held;
    await pending;
    const after = await kv.get<Session>(KV.sessions, "s3b");
    expect(after?.commitShas).toContain("abc1234");
  });

  it("concurrent api::session::commit and api::session::end lose neither the sha nor the end", async () => {
    const kv = mockKV();
    const { fns } = apiSdk(kv);
    await seedSession(kv, {
      id: "s3",
      project: "demo",
      cwd: "/tmp/demo",
      startedAt: "2026-10-01T00:00:00.000Z",
      status: "active",
      observationCount: 2,
    });
    const commit = fns.get("api::session::commit")!;
    const end = fns.get("api::session::end")!;
    await Promise.all([
      commit({ body: { sha: "abc1234", sessionId: "s3" } }),
      end({ body: { sessionId: "s3" } }),
    ]);
    const row = await kv.get<Session>(KV.sessions, "s3");
    expect(row?.status).toBe("completed");
    expect(row?.endedAt).toBeTruthy();
    expect(row?.commitShas).toContain("abc1234");
  });

  it("event::session::ended waits for the obs: lock instead of racing the commit linker", async () => {
    const kv = mockKV();
    const { fns } = eventSdk(kv);
    await seedSession(kv, {
      id: "s4",
      project: "demo",
      cwd: "/tmp/demo",
      startedAt: "2026-10-01T00:00:00.000Z",
      status: "active",
      observationCount: 1,
    });
    let release!: () => void;
    const held = withKeyedLock(
      "obs:s4",
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const ended = fns.get("event::session::ended")!;
    const pending = ended({ sessionId: "s4" });
    await flushMacrotasks();
    const during = await kv.get<Session>(KV.sessions, "s4");
    expect(during?.status).toBe("active");
    release();
    await held;
    await pending;
    const after = await kv.get<Session>(KV.sessions, "s4");
    expect(after?.status).toBe("completed");
  });
});

describe("U6 graph write paths share the graph:persist lock", () => {
  function graphNode(id: string): GraphNode {
    return {
      id,
      type: "concept",
      name: `concept-${id}`,
      properties: {},
      sourceObservationIds: ["obs_1"],
      createdAt: "2026-10-05T00:00:00.000Z",
    };
  }

  it("temporal-graph-extract lists inside graph:persist", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    registerTemporalGraphFunctions(sdk as never, kv as never, {
      name: "stub",
      compress: async () =>
        `<entity type="concept" name="E"><property key="k">v</property></entity>`,
      summarize: async () => "",
    } as never);
    const listed: string[] = [];
    const rawList = kv.list;
    kv.list = (async <T>(scope: string): Promise<T[]> => {
      listed.push(scope);
      return rawList<T>(scope);
    }) as typeof kv.list;

    let release!: () => void;
    const held = withKeyedLock(
      "graph:persist",
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const op = sdk.trigger("mem::temporal-graph-extract", {
      observations: [
        {
          id: "obs_1",
          sessionId: "s1",
          type: "conversation",
          timestamp: "2026-10-05T00:00:00.000Z",
          title: "t",
          narrative: "n",
          concepts: [],
          files: [],
        },
      ],
    });
    await flushMacrotasks(5);
    expect(listed).not.toContain(KV.graphNodes);
    release();
    await held;
    await op;
  });

  it("mesh graph-node merge waits for graph:persist", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    registerMeshFunction(sdk as never, kv as never);
    const written: string[] = [];
    const rawSet = kv.set;
    kv.set = (async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (scope === KV.graphNodes) written.push(key);
      return rawSet<T>(scope, key, data);
    }) as typeof kv.set;

    let release!: () => void;
    const held = withKeyedLock(
      "graph:persist",
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const op = sdk.trigger("mem::mesh-receive", {
      graphNodes: [graphNode("gn1")],
    });
    await flushMacrotasks();
    expect(written).toEqual([]);
    release();
    await held;
    await op;
    expect(written).toEqual(["gn1"]);
  });

  it("mesh pull merges graph edges under graph:persist, not a per-item key", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    registerMeshFunction(sdk as never, kv as never, "u6-token");
    await kv.set(KV.mesh, "p1", {
      id: "p1",
      url: "https://mesh-test.invalid",
      name: "p1",
      status: "connected",
      sharedScopes: ["graph:edges"],
    });
    const edge = {
      id: "ge1",
      type: "related_to",
      sourceNodeId: "gn1",
      targetNodeId: "gn2",
      weight: 1,
      sourceObservationIds: [],
      createdAt: "2026-10-05T00:00:00.000Z",
    };
    vi.stubGlobal(
      "fetch",
      (async () => ({
        ok: true,
        json: async () => ({ graphEdges: [edge] }),
      })) as unknown as typeof fetch,
    );
    try {
      const written: string[] = [];
      const rawSet = kv.set;
      kv.set = (async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (scope === KV.graphEdges) written.push(key);
        return rawSet<T>(scope, key, data);
      }) as typeof kv.set;

      let release!: () => void;
      const held = withKeyedLock(
        "graph:persist",
        () => new Promise<void>((resolve) => (release = resolve)),
      );
      const op = sdk.trigger("mem::mesh-sync", {
        peerId: "p1",
        direction: "pull",
      });
      await flushMacrotasks(5);
      expect(written).toEqual([]);
      release();
      await held;
      const result = (await op) as { success: boolean };
      expect(result.success).toBe(true);
      expect(written).toEqual(["ge1"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("cascade-update stale-flag writes wait for graph:persist and re-read the row", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    registerCascadeFunction(sdk as never, kv as never);
    const memory: Memory = {
      id: "mem_old",
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      type: "fact",
      title: "Old fact",
      content: "Old content",
      concepts: ["react"],
      files: [],
      sessionIds: [],
      strength: 5,
      version: 1,
      isLatest: false,
      sourceObservationIds: ["obs_a"],
    };
    await kv.set(KV.memories, "mem_old", memory);
    await kv.set(KV.graphNodes, "node_1", graphNode("node_1"));
    const stored = await kv.get<GraphNode>(KV.graphNodes, "node_1");
    stored!.sourceObservationIds = ["obs_a"];
    await kv.set(KV.graphNodes, "node_1", stored!);

    const written: string[] = [];
    const rawSet = kv.set;
    kv.set = (async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (scope === KV.graphNodes) written.push(key);
      return rawSet<T>(scope, key, data);
    }) as typeof kv.set;

    let release!: () => void;
    const held = withKeyedLock(
      "graph:persist",
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const op = sdk.trigger("mem::cascade-update", {
      supersededMemoryId: "mem_old",
    });
    await flushMacrotasks();
    expect(written).toEqual([]);
    release();
    await held;
    const result = (await op) as { success: boolean };
    expect(result.success).toBe(true);
    const flagged = await kv.get<GraphNode>(KV.graphNodes, "node_1");
    expect(flagged?.stale).toBe(true);
  });

  it("graph-snapshot-rebuild lists inside graph:persist", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    registerGraphFunction(sdk as never, kv as never, {
      name: "stub",
      compress: async () => "",
      summarize: async () => "",
    } as never);
    const listed: string[] = [];
    const rawList = kv.list;
    kv.list = (async <T>(scope: string): Promise<T[]> => {
      listed.push(scope);
      return rawList<T>(scope);
    }) as typeof kv.list;

    let release!: () => void;
    const held = withKeyedLock(
      "graph:persist",
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const op = sdk.trigger("mem::graph-snapshot-rebuild", { force: true });
    await flushMacrotasks(5);
    expect(listed).not.toContain(KV.graphNodes);
    release();
    await held;
    await op;
  });

  it("graph-reset snapshot write waits for graph:persist", async () => {
    const kv = mockKV();
    const sdk = mockSdk();
    registerGraphFunction(sdk as never, kv as never, {
      name: "stub",
      compress: async () => "",
      summarize: async () => "",
    } as never);
    const snapshotWrites: string[] = [];
    const rawSet = kv.set;
    kv.set = (async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (scope === KV.graphSnapshot) snapshotWrites.push(key);
      return rawSet<T>(scope, key, data);
    }) as typeof kv.set;

    let release!: () => void;
    const held = withKeyedLock(
      "graph:persist",
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const op = sdk.trigger("mem::graph-reset", {});
    await flushMacrotasks();
    expect(snapshotWrites).toEqual([]);
    release();
    await held;
    await op;
    expect(snapshotWrites.length).toBeGreaterThan(0);
  });
});

describe("U6 no same-key nesting on touched call paths", () => {
  it("touched session and graph paths complete concurrently without deadlock", async () => {
    const kv = mockKV();
    const { fns } = apiSdk(kv);
    const { fns: eventFns } = eventSdk(kv);
    const meshSdk = mockSdk();
    registerMeshFunction(meshSdk as never, kv as never);
    const cascadeSdk = mockSdk();
    registerCascadeFunction(cascadeSdk as never, kv as never);

    await seedSession(kv, {
      id: "race1",
      project: "demo",
      cwd: "/tmp/demo",
      startedAt: "2026-10-01T00:00:00.000Z",
      status: "active",
      observationCount: 1,
    });

    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("deadlock: touched paths did not settle")), 10000);
    });
    const work = Promise.all([
      fns.get("api::session::start")!({
        body: { sessionId: "race1", project: "demo", cwd: "/tmp/demo" },
      }),
      eventFns.get("event::session::ended")!({ sessionId: "race1" }),
      fns.get("api::session::commit")!({ body: { sha: "deadbee", sessionId: "race1" } }),
      meshSdk.trigger("mem::mesh-receive", {
        graphNodes: [
          {
            id: "gn-race",
            type: "concept",
            name: "race-node",
            properties: {},
            sourceObservationIds: [],
            createdAt: "2026-10-05T00:00:00.000Z",
          },
        ],
      }),
    ]);
    await Promise.race([work, timeout]);
    const row = await kv.get<Session>(KV.sessions, "race1");
    expect(row?.commitShas).toContain("deadbee");
  }, 15000);
});
