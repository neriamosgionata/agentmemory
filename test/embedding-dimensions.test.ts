import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveDimensions } from "../src/providers/embedding/_dimensions.js";
import { OpenRouterEmbeddingProvider } from "../src/providers/embedding/openrouter.js";
import { OpenAIEmbeddingProvider } from "../src/providers/embedding/openai.js";
import { withDimensionGuard } from "../src/providers/embedding/index.js";

describe("resolveDimensions", () => {
  const ENV = "OPENROUTER_EMBEDDING_DIMENSIONS";

  it("resolves namespaced OpenRouter model ids to their real dimensions", () => {
    expect(resolveDimensions("openai/text-embedding-3-large", undefined, ENV)).toBe(3072);
    expect(resolveDimensions("openai/text-embedding-3-small", undefined, ENV)).toBe(1536);
    expect(resolveDimensions("openai/text-embedding-ada-002", undefined, ENV)).toBe(1536);
  });

  it("resolves bare model ids to their real dimensions", () => {
    expect(resolveDimensions("text-embedding-3-large", undefined, ENV)).toBe(3072);
    expect(resolveDimensions("text-embedding-3-small", undefined, ENV)).toBe(1536);
    expect(resolveDimensions("text-embedding-ada-002", undefined, ENV)).toBe(1536);
  });

  it("lets a valid override win over the model-derived dimensions", () => {
    expect(resolveDimensions("openai/text-embedding-3-large", "1024", ENV)).toBe(1024);
    expect(resolveDimensions("text-embedding-3-small", "768", ENV)).toBe(768);
  });

  it("throws with the given env name on invalid override values", () => {
    for (const bad of ["abc", "0", "-5"]) {
      expect(() => resolveDimensions("text-embedding-3-large", bad, ENV)).toThrow(
        new RegExp(`${ENV} must be a positive integer, got: ${bad}`),
      );
    }
  });

  it("uses the supplied env name in the error message", () => {
    expect(() => resolveDimensions("text-embedding-3-large", "abc", "OPENAI_EMBEDDING_DIMENSIONS")).toThrow(
      /OPENAI_EMBEDDING_DIMENSIONS must be a positive integer, got: abc/,
    );
  });

  it("falls back to the default (1536) for unknown models", () => {
    expect(resolveDimensions("mystery-self-hosted-model", undefined, ENV)).toBe(1536);
    expect(resolveDimensions("someprovider/unknown-model", undefined, ENV)).toBe(1536);
  });
});

describe("OpenRouterEmbeddingProvider dimension regression", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env["OPENROUTER_EMBEDDING_MODEL"];
    delete process.env["OPENROUTER_EMBEDDING_DIMENSIONS"];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("reports 3072 for openai/text-embedding-3-large with no override (guard would throw on the old hardcoded 1536)", () => {
    process.env["OPENROUTER_EMBEDDING_MODEL"] = "openai/text-embedding-3-large";
    const provider = new OpenRouterEmbeddingProvider("test-key");
    expect(provider.dimensions).toBe(3072);
  });

  it("defaults to 1536 for openai/text-embedding-3-small", () => {
    const provider = new OpenRouterEmbeddingProvider("test-key");
    expect(provider.dimensions).toBe(1536);
  });

  it("lets OPENROUTER_EMBEDDING_DIMENSIONS override the model-derived dimensions", () => {
    process.env["OPENROUTER_EMBEDDING_MODEL"] = "openai/text-embedding-3-large";
    process.env["OPENROUTER_EMBEDDING_DIMENSIONS"] = "1024";
    const provider = new OpenRouterEmbeddingProvider("test-key");
    expect(provider.dimensions).toBe(1024);
  });
});

describe("OpenAIEmbeddingProvider defaults unchanged", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env["OPENAI_EMBEDDING_MODEL"];
    delete process.env["OPENAI_EMBEDDING_DIMENSIONS"];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("defaults to 1536 for text-embedding-3-small", () => {
    const provider = new OpenAIEmbeddingProvider("test-key");
    expect(provider.dimensions).toBe(1536);
  });

  it("reports 3072 for text-embedding-3-large", () => {
    process.env["OPENAI_EMBEDDING_MODEL"] = "text-embedding-3-large";
    const provider = new OpenAIEmbeddingProvider("test-key");
    expect(provider.dimensions).toBe(3072);
  });
});


describe("inferred-dimension self-correction (#1373)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env["OPENAI_EMBEDDING_DIMENSIONS"];
    delete process.env["OPENAI_EMBEDDING_MODEL"];
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  function stubEmbedding(width: number) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ embedding: new Array(width).fill(0.1) }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("adopts the real width from the first response instead of the 1536 guess", async () => {
    process.env["OPENAI_EMBEDDING_MODEL"] = "mystery-self-hosted-model";
    stubEmbedding(768);
    const provider = new OpenAIEmbeddingProvider("sk-test");
    expect(provider.dimensionsInferred).toBe(true);
    expect(provider.dimensions).toBe(1536);

    const vector = await provider.embed("hello");

    expect(vector.length).toBe(768);
    expect(provider.dimensions).toBe(768);
    expect(provider.dimensionsInferred).toBe(false);
  });

  it("passes the dimension guard once the width is detected", async () => {
    process.env["OPENAI_EMBEDDING_MODEL"] = "mystery-self-hosted-model";
    stubEmbedding(768);
    const guarded = withDimensionGuard(new OpenAIEmbeddingProvider("sk-test"));

    const vector = await guarded.embed("hello");

    expect(vector.length).toBe(768);
  });

  it("does not override an explicit dimensions setting", async () => {
    process.env["OPENAI_EMBEDDING_MODEL"] = "mystery-self-hosted-model";
    process.env["OPENAI_EMBEDDING_DIMENSIONS"] = "768";
    stubEmbedding(768);
    const provider = new OpenAIEmbeddingProvider("sk-test");

    expect(provider.dimensionsInferred).toBe(false);
    expect(provider.dimensions).toBe(768);
  });

  it("probeDimensions returns the detected width without persisting a guess", async () => {
    process.env["OPENAI_EMBEDDING_MODEL"] = "mystery-self-hosted-model";
    stubEmbedding(1024);
    const provider = new OpenAIEmbeddingProvider("sk-test");

    await expect(provider.probeDimensions!()).resolves.toBe(1024);
  });
});

describe("OpenRouter inferred-dimension self-correction (#1373)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env["OPENROUTER_EMBEDDING_DIMENSIONS"];
    delete process.env["OPENROUTER_EMBEDDING_MODEL"];
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it("adopts the response width for an untabled model", async () => {
    process.env["OPENROUTER_EMBEDDING_MODEL"] = "vendor/mystery-model";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ embedding: new Array(1024).fill(0.2) }],
        }),
      }),
    );
    const provider = new OpenRouterEmbeddingProvider("sk-test");
    expect(provider.dimensionsInferred).toBe(true);

    const vector = await provider.embed("hello");

    expect(vector.length).toBe(1024);
    expect(provider.dimensions).toBe(1024);
    expect(provider.dimensionsInferred).toBe(false);
  });
});
