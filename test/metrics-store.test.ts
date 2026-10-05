import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { MetricsStore } from "../src/eval/metrics-store.js";
import { mockKV } from "./helpers/mocks.js";

describe("MetricsStore windowing", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-10-05T10:00:00Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env["AGENTMEMORY_METRICS_WINDOW_MS"];
  });

  it("resets counters once the window elapses", async () => {
    const kv = mockKV();
    const metrics = new MetricsStore(kv as never);
    await metrics.record("mem::summarize", 100, false);
    await metrics.record("mem::summarize", 200, false);

    let m = await metrics.get("mem::summarize");
    expect(m?.totalCalls).toBe(2);
    expect(m?.failureCount).toBe(2);

    vi.advanceTimersByTime(3_600_001);
    await metrics.record("mem::summarize", 50, true);

    m = await metrics.get("mem::summarize");
    expect(m?.totalCalls).toBe(1);
    expect(m?.failureCount).toBe(0);
    expect(m?.successCount).toBe(1);
    expect(m?.avgLatencyMs).toBe(50);
    expect(m?.lastCallAt).toBeDefined();
  });

  it("zeroes an expired window on read without a new call", async () => {
    const kv = mockKV();
    const metrics = new MetricsStore(kv as never);
    await metrics.record("mem::summarize", 300, false);

    vi.advanceTimersByTime(3_600_001);
    const m = await metrics.get("mem::summarize");
    expect(m?.totalCalls).toBe(0);
    expect(m?.failureCount).toBe(0);
    expect(m?.avgLatencyMs).toBe(0);
  });

  it("exposes lastFailureAt only while the failure is in the window", async () => {
    const kv = mockKV();
    const metrics = new MetricsStore(kv as never);
    await metrics.record("mem::summarize", 10, true);
    expect((await metrics.get("mem::summarize"))?.lastFailureAt).toBeUndefined();

    await metrics.record("mem::summarize", 10, false);
    const failed = await metrics.get("mem::summarize");
    expect(failed?.lastFailureAt).toBe(new Date().toISOString());

    vi.advanceTimersByTime(3_600_001);
    expect((await metrics.get("mem::summarize"))?.lastFailureAt).toBeUndefined();
  });

  it("keeps the quality average consistent across store instances", async () => {
    const kv = mockKV();
    const first = new MetricsStore(kv as never);
    await first.record("mem::summarize", 10, true, 100);
    await first.record("mem::summarize", 10, true, 0);

    const second = new MetricsStore(kv as never);
    await second.record("mem::summarize", 10, true, 0);

    const m = await second.get("mem::summarize");
    expect(m?.avgQualityScore).toBeCloseTo(100 / 3, 5);
  });

  it("getAll zeroes expired rows without dropping them", async () => {
    const kv = mockKV();
    const metrics = new MetricsStore(kv as never);
    await metrics.record("mem::summarize", 100, false);
    await metrics.record("mem::compress", 5, true);

    vi.advanceTimersByTime(3_600_001);
    await metrics.record("mem::compress", 5, true);

    const all = await metrics.getAll();
    const byId = new Map(all.map((m) => [m.functionId, m]));
    expect(byId.get("mem::summarize")?.totalCalls).toBe(0);
    expect(byId.get("mem::compress")?.totalCalls).toBe(1);
    expect(byId.get("mem::compress")?.successCount).toBe(1);
  });
});
