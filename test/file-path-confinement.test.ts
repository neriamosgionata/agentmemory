import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { allowedFileRoots, confinePath } from "../src/functions/path-guard.js";
import { registerGraphImportFunction } from "../src/functions/graph-import.js";
import { registerReplayFunctions } from "../src/functions/replay.js";
import { registerCompressFileFunction } from "../src/functions/compress-file.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string) => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function mockSdk() {
  const fns = new Map<string, Function>();
  return {
    registerFunction: (id: string, h: Function) => fns.set(id, h),
    registerTrigger: () => {},
    trigger: async (input: { function_id: string; payload?: unknown }) => {
      const fn = fns.get(input.function_id);
      return fn ? fn(input.payload) : { success: true };
    },
  };
}

describe("file path confinement", () => {
  let base: string;
  let root: string;
  let outside: string;
  const savedRoot = process.env.AGENTMEMORY_IMPORT_ROOT;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "am-confine-"));
    root = join(base, "allowed");
    outside = join(base, "outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    process.env.AGENTMEMORY_IMPORT_ROOT = root;
  });

  afterEach(() => {
    if (savedRoot === undefined) delete process.env.AGENTMEMORY_IMPORT_ROOT;
    else process.env.AGENTMEMORY_IMPORT_ROOT = savedRoot;
    rmSync(base, { recursive: true, force: true });
  });

  it("accepts paths under the import root, including ones that do not exist yet", async () => {
    writeFileSync(join(root, "notes.md"), "# x\n");
    expect(await confinePath(join(root, "notes.md"))).toMatchObject({ ok: true });
    expect(await confinePath(join(root, "new", "graph.json"))).toMatchObject({ ok: true });
    expect(allowedFileRoots()).toContain(root);
  });

  it("rejects traversal out of the root", async () => {
    writeFileSync(join(outside, "graph.json"), "{}");
    const result = await confinePath(join(root, "..", "outside", "graph.json"));
    expect(result.ok).toBe(false);
  });

  it("rejects absolute paths outside every root", async () => {
    expect((await confinePath(join(outside, "graph.json"))).ok).toBe(false);
    expect((await confinePath("/etc/hosts")).ok).toBe(false);
  });

  it("rejects a symlinked directory inside the root that points outside", async () => {
    writeFileSync(join(outside, "graph.json"), "{}");
    symlinkSync(outside, join(root, "link"));
    expect((await confinePath(join(root, "link", "graph.json"))).ok).toBe(false);
  });

  it("rejects empty and NUL-containing input", async () => {
    expect((await confinePath("")).ok).toBe(false);
    expect((await confinePath(`${root}/a\0b`)).ok).toBe(false);
    expect((await confinePath(42)).ok).toBe(false);
  });

  it("graph import refuses files outside the allowed roots", async () => {
    writeFileSync(join(outside, "graph.json"), JSON.stringify({ nodes: [], links: [] }));
    const sdk = mockSdk();
    registerGraphImportFunction(sdk as never, mockKV() as never);
    const result = (await sdk.trigger({
      function_id: "mem::graph::import-graphify",
      payload: { path: join(outside, "graph.json") },
    })) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/outside the allowed roots/);
    const traversal = (await sdk.trigger({
      function_id: "mem::graph::import-graphify",
      payload: { path: join(root, "..", "outside", "graph.json") },
    })) as { success: boolean };
    expect(traversal.success).toBe(false);
    const notJson = (await sdk.trigger({
      function_id: "mem::graph::import-graphify",
      payload: { path: join(root, "notes.txt") },
    })) as { success: boolean; error?: string };
    expect(notJson.success).toBe(false);
  });

  it("jsonl replay refuses directories outside the allowed roots", async () => {
    writeFileSync(join(outside, "s.jsonl"), "{}\n");
    const sdk = mockSdk();
    registerReplayFunctions(sdk as never, mockKV() as never);
    const result = (await sdk.trigger({
      function_id: "mem::replay::import-jsonl",
      payload: { path: outside },
    })) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/outside the allowed roots/);
  });

  it("compress-file refuses markdown outside the allowed roots", async () => {
    writeFileSync(join(outside, "README.md"), "# Title\n\nSome prose.\n");
    const summarize = vi.fn(async () => "# Title\n\nProse.\n");
    const sdk = mockSdk();
    registerCompressFileFunction(sdk as never, mockKV() as never, { name: "t", summarize, compress: summarize } as never);
    const result = (await sdk.trigger({
      function_id: "mem::compress-file",
      payload: { filePath: join(outside, "README.md") },
    })) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(summarize).not.toHaveBeenCalled();
  });
});
