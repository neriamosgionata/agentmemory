import { describe, it, expect, vi } from "vitest";

// A text-classification pipeline over a single-logit cross-encoder scores
// every pair ~1.0; the reranker must treat that as "no signal" instead of
// overwriting combinedScore and reordering by noise. #724
vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn(async () => async () => [
    { label: "LABEL_1", score: 1.0 },
  ]),
}));

import { rerank } from "../src/state/reranker.js";

describe("reranker flat-score guard (#724)", () => {
  it("keeps the pre-rerank order and scores when all scores are equal", async () => {
    const results = [
      {
        observation: { id: "o1", title: "A", narrative: "a" },
        bm25Score: 0.9,
        vectorScore: 0,
        graphScore: 0,
        combinedScore: 0.9,
        sessionId: "s1",
      },
      {
        observation: { id: "o2", title: "B", narrative: "b" },
        bm25Score: 0.4,
        vectorScore: 0,
        graphScore: 0,
        combinedScore: 0.4,
        sessionId: "s1",
      },
    ] as any;

    const out = await rerank("query", results);

    expect(out.map((r) => r.observation.id)).toEqual(["o1", "o2"]);
    expect(out[0].combinedScore).toBe(0.9);
    expect(out[1].combinedScore).toBe(0.4);
    expect(out[0].rerankPosition).toBeUndefined();
  });
});
