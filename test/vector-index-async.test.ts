import { describe, it, expect } from "vitest";
import { VectorIndex } from "../src/state/vector-index.js";

function vec(seed: number, dim = 8): Float32Array {
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = Math.sin(seed * (i + 1));
  return out;
}

describe("VectorIndex.searchAsync (#195)", () => {
  it("returns the same ranking as the synchronous scan", async () => {
    const index = new VectorIndex();
    for (let i = 0; i < 500; i++) {
      index.add(`obs_${i}`, `ses_${i % 7}`, vec(i));
    }
    const query = vec(123);

    const sync = index.search(query, 10);
    const async_ = await index.searchAsync(query, 10);

    expect(async_.map((r) => r.obsId)).toEqual(sync.map((r) => r.obsId));
    expect(async_.map((r) => r.score)).toEqual(sync.map((r) => r.score));
  });

  it("handles an empty index", async () => {
    const index = new VectorIndex();
    await expect(index.searchAsync(vec(1), 5)).resolves.toEqual([]);
  });

  it("still returns top-k when there are fewer vectors than the limit", async () => {
    const index = new VectorIndex();
    index.add("only", "ses_1", vec(1));
    const results = await index.searchAsync(vec(1), 10);
    expect(results).toHaveLength(1);
    expect(results[0].obsId).toBe("only");
  });
});
