import { describe, it, expect, vi } from "vitest";
import { compressWithRetry } from "../src/eval/self-correct.js";
import type { MemoryProvider } from "../src/types.js";

function providerReturning(...responses: string[]): MemoryProvider {
  const compress = vi.fn();
  for (const response of responses) {
    compress.mockResolvedValueOnce(response);
  }
  return {
    name: "test",
    compress,
    summarize: vi.fn().mockResolvedValue(""),
  };
}

const alwaysInvalid = () => ({ valid: false, errors: ["bad"] });
const acceptsGood = (response: string) => ({
  valid: response.includes("GOOD"),
  errors: ["bad"],
});

describe("compressWithRetry (#1271)", () => {
  it("returns valid:true when the first response passes", async () => {
    const provider = providerReturning("GOOD");
    const result = await compressWithRetry(provider, "sys", "user", acceptsGood);
    expect(result.valid).toBe(true);
    expect(result.retried).toBe(false);
  });

  it("returns valid:true when a retry passes", async () => {
    const provider = providerReturning("bad", "GOOD");
    const result = await compressWithRetry(provider, "sys", "user", acceptsGood);
    expect(result.valid).toBe(true);
    expect(result.retried).toBe(true);
    expect(result.response).toBe("GOOD");
  });

  it("flags valid:false instead of handing back a rejected response", async () => {
    const provider = providerReturning("bad one", "bad two");
    const result = await compressWithRetry(
      provider,
      "sys",
      "user",
      alwaysInvalid,
    );
    expect(result.valid).toBe(false);
    expect(result.retried).toBe(true);
    // The response is still surfaced for logging, but callers must not
    // persist it as though the validator had accepted it.
    expect(result.response).toBe("bad one");
  });
});
