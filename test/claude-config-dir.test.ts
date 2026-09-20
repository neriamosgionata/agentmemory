import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { claudeConfigDir } from "../src/config.js";
import { registerReplayFunctions } from "../src/functions/replay.js";

describe("claudeConfigDir (#1067/#1103)", () => {
  const original = process.env["CLAUDE_CONFIG_DIR"];

  afterEach(() => {
    if (original === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
    else process.env["CLAUDE_CONFIG_DIR"] = original;
  });

  it("defaults to ~/.claude when unset", () => {
    delete process.env["CLAUDE_CONFIG_DIR"];
    expect(claudeConfigDir()).toBe(join(process.env["HOME"]!, ".claude"));
  });

  it("honors CLAUDE_CONFIG_DIR and trims it", () => {
    process.env["CLAUDE_CONFIG_DIR"] = "/tmp/xdg/claude  ";
    expect(claudeConfigDir()).toBe("/tmp/xdg/claude");
  });
});

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value);
      return value;
    },
    delete: async (scope: string, key: string) => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function mockSdk(kv: ReturnType<typeof mockKV>) {
  const fns = new Map<string, Function>();
  return {
    registerFunction: (id: string, handler: Function) => fns.set(id, handler),
    registerTrigger: () => {},
    trigger: async (
      idOrInput: string | { function_id: string; payload?: unknown },
      data?: unknown,
    ) => {
      const id =
        typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload =
        typeof idOrInput === "string" ? data : (idOrInput as any).payload;
      const fn = fns.get(id);
      if (!fn) return { success: true };
      return fn(payload);
    },
    _kv: kv,
  } as any;
}

describe("import-jsonl default root honors CLAUDE_CONFIG_DIR (#1103)", () => {
  let root: string;
  const original = process.env["CLAUDE_CONFIG_DIR"];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "am-claude-cfg-"));
    process.env["CLAUDE_CONFIG_DIR"] = root;
  });

  afterEach(() => {
    if (original === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
    else process.env["CLAUDE_CONFIG_DIR"] = original;
    rmSync(root, { recursive: true, force: true });
  });

  it("imports from $CLAUDE_CONFIG_DIR/projects when no path is given", async () => {
    const dir = join(root, "projects", "proj");
    mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({
        type: "user",
        uuid: "u1",
        sessionId: "sess-cfg",
        timestamp: "2026-04-17T10:00:00.000Z",
        cwd: root,
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        sessionId: "sess-cfg",
        timestamp: "2026-04-17T10:00:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "world" }],
        },
      }),
    ];
    writeFileSync(join(dir, "sess-cfg.jsonl"), lines.join("\n") + "\n");

    const kv = mockKV();
    const sdk = mockSdk(kv);
    registerReplayFunctions(sdk, kv as never);

    const result = (await sdk.trigger("mem::replay::import-jsonl", {})) as {
      success: boolean;
      imported?: number;
    };

    expect(result.success).toBe(true);
    expect(result.imported).toBe(1);
  });
});
