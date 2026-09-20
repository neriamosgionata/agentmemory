import { describe, it, expect, afterEach } from "vitest";
import { resolveAnthropicTimeout } from "../src/providers/anthropic.js";

// The Anthropic SDK default timeout is 60s; complex summarization against
// alternative base URLs exceeded it with no retry. #655
describe("Anthropic SDK timeout (#655)", () => {
  const keys = ["ANTHROPIC_TIMEOUT_MS", "AGENTMEMORY_LLM_TIMEOUT_MS"] as const;
  const originals = Object.fromEntries(keys.map((k) => [k, process.env[k]]));

  afterEach(() => {
    for (const k of keys) {
      if (originals[k] === undefined) delete process.env[k];
      else process.env[k] = originals[k];
    }
  });

  it("returns undefined when neither env var is set (SDK default applies)", () => {
    for (const k of keys) delete process.env[k];
    expect(resolveAnthropicTimeout()).toBeUndefined();
  });

  it("prefers ANTHROPIC_TIMEOUT_MS", () => {
    process.env["ANTHROPIC_TIMEOUT_MS"] = "120000";
    process.env["AGENTMEMORY_LLM_TIMEOUT_MS"] = "30000";
    expect(resolveAnthropicTimeout()).toBe(120_000);
  });

  it("falls back to AGENTMEMORY_LLM_TIMEOUT_MS and ignores malformed values", () => {
    delete process.env["ANTHROPIC_TIMEOUT_MS"];
    process.env["AGENTMEMORY_LLM_TIMEOUT_MS"] = "90s";
    expect(resolveAnthropicTimeout()).toBeUndefined();
    process.env["AGENTMEMORY_LLM_TIMEOUT_MS"] = "90000";
    expect(resolveAnthropicTimeout()).toBe(90_000);
  });
});
