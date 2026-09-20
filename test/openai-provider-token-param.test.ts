import { describe, it, expect, afterEach, vi } from "vitest";
import { OpenAIProvider } from "../src/providers/openai.js";

const originalFetch = globalThis.fetch;

function installFetch(onBody: (body: Record<string, unknown>) => void): void {
  globalThis.fetch = vi.fn(
    async (_url: string | URL, init?: RequestInit) => {
      onBody(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  ) as unknown as typeof fetch;
}

describe("OpenAIProvider token parameter (#1219)", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env["OPENAI_MAX_TOKENS_PARAM"];
  });

  it("sends max_completion_tokens for reasoning models (default gpt-5.6-luna)", async () => {
    let body: Record<string, unknown> = {};
    installFetch((b) => {
      body = b;
    });
    const provider = new OpenAIProvider("key", "gpt-5.6-luna", 4096);
    await provider.compress("sys", "user");

    expect(body["max_completion_tokens"]).toBe(4096);
    expect(body["max_tokens"]).toBeUndefined();
  });

  it("keeps max_tokens for non-reasoning models", async () => {
    let body: Record<string, unknown> = {};
    installFetch((b) => {
      body = b;
    });
    const provider = new OpenAIProvider("key", "gpt-4o-mini", 4096);
    await provider.compress("sys", "user");

    expect(body["max_tokens"]).toBe(4096);
    expect(body["max_completion_tokens"]).toBeUndefined();
  });

  it("honors the OPENAI_MAX_TOKENS_PARAM override", async () => {
    process.env["OPENAI_MAX_TOKENS_PARAM"] = "max_tokens";
    let body: Record<string, unknown> = {};
    installFetch((b) => {
      body = b;
    });
    const provider = new OpenAIProvider("key", "gpt-5.6-luna", 4096);
    await provider.compress("sys", "user");

    expect(body["max_tokens"]).toBe(4096);
    expect(body["max_completion_tokens"]).toBeUndefined();
  });
});
