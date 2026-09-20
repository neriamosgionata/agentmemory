import type { EmbeddingProvider } from "../../types.js";
import { getEnvVar } from "../../config.js";
import { fetchWithTimeout } from "../_fetch.js";
import { resolveDimensionsDetailed } from "./_dimensions.js";
import { logger } from "../../logger.js";

const API_URL = "https://openrouter.ai/api/v1/embeddings";

const DEFAULT_MODEL = "openai/text-embedding-3-small";

export class OpenRouterEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openrouter";
  /** Mutable while `dimensionsInferred` is true (self-corrects on first embed). */
  dimensions: number;
  dimensionsInferred: boolean;
  private apiKey: string;
  private model: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || getEnvVar("OPENROUTER_API_KEY") || "";
    if (!this.apiKey) throw new Error("OPENROUTER_API_KEY is required");
    this.model = getEnvVar("OPENROUTER_EMBEDDING_MODEL") || DEFAULT_MODEL;
    const resolution = resolveDimensionsDetailed(
      this.model,
      getEnvVar("OPENROUTER_EMBEDDING_DIMENSIONS"),
      "OPENROUTER_EMBEDDING_DIMENSIONS",
    );
    this.dimensions = resolution.dimensions;
    this.dimensionsInferred = resolution.inferred;
  }

  async embed(text: string): Promise<Float32Array> {
    const [result] = await this.embedBatch([text]);
    return result;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const response = await fetchWithTimeout(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(
        `OpenRouter embedding failed (${response.status}): ${err}`,
      );
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };

    const vectors = data.data.map((d) => new Float32Array(d.embedding));
    const detected = vectors[0]?.length;
    if (
      this.dimensionsInferred &&
      typeof detected === "number" &&
      detected > 0 &&
      detected !== this.dimensions
    ) {
      logger.info("Embedding dimensions detected", {
        provider: this.name,
        model: this.model,
        previous: this.dimensions,
        detected,
      });
      this.dimensions = detected;
      this.dimensionsInferred = false;
    }
    return vectors;
  }

  /** One throwaway embed so boot validation sees the real width. */
  async probeDimensions(): Promise<number> {
    await this.embed("dimension probe");
    return this.dimensions;
  }
}
