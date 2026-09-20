import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerMcpEndpoints } from "../src/mcp/server.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
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
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  const triggerOverrides = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      if (triggerOverrides.has(id)) return triggerOverrides.get(id)!(payload);
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
    overrideTrigger: (id: string, handler: Function) =>
      triggerOverrides.set(id, handler),
    getFunction: (id: string) => functions.get(id),
  };
}

describe("memory_action_create forwards createdBy (#1105)", () => {
  let sdk: ReturnType<typeof mockSdk>;

  beforeEach(() => {
    sdk = mockSdk();
    registerMcpEndpoints(sdk as never, mockKV() as never);
  });

  it("forwards args.createdBy into the mem::action-create payload", async () => {
    let captured: { createdBy?: string } | undefined;
    sdk.overrideTrigger("mem::action-create", (payload: unknown) => {
      captured = payload as { createdBy?: string };
      return { id: "act_1" };
    });
    const res = (await sdk.getFunction("mcp::tools::call")!({
      body: {
        name: "memory_action_create",
        arguments: { title: "Ship it", createdBy: "agent-x" },
      },
      headers: {},
      query_params: {},
    })) as { status_code: number };

    expect(res.status_code).toBe(200);
    expect(captured?.createdBy).toBe("agent-x");
  });

  it("omits createdBy when absent so the store default applies", async () => {
    let captured: Record<string, unknown> | undefined;
    sdk.overrideTrigger("mem::action-create", (payload: unknown) => {
      captured = payload as Record<string, unknown>;
      return { id: "act_2" };
    });
    await sdk.getFunction("mcp::tools::call")!({
      body: {
        name: "memory_action_create",
        arguments: { title: "No author" },
      },
      headers: {},
      query_params: {},
    });

    expect(captured && "createdBy" in captured).toBe(false);
  });
});
