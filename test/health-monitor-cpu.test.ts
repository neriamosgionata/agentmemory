import { describe, expect, it } from "vitest";
import { cpus } from "node:os";
import { normalizeCpuPercent } from "../src/health/monitor.js";

describe("normalizeCpuPercent", () => {
  it("divides single-core percent by the core count (#1235)", () => {
    expect(normalizeCpuPercent(244, 16)).toBeCloseTo(15.25, 2);
  });

  it("clamps a zero or bogus core count to 1 rather than dividing by zero", () => {
    expect(normalizeCpuPercent(50, 0)).toBe(50);
  });

  it("uses the real core count by default", () => {
    expect(normalizeCpuPercent(cpus().length * 100)).toBeCloseTo(100, 2);
  });
});
