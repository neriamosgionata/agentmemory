import type { FunctionMetrics } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";

const DEFAULT_WINDOW_MS = 3_600_000;

function metricsWindowMs(): number {
  const raw = process.env["AGENTMEMORY_METRICS_WINDOW_MS"];
  if (!raw) return DEFAULT_WINDOW_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_WINDOW_MS;
  return Math.floor(parsed);
}

function emptyMetrics(
  functionId: string,
  now: string,
  windowMs: number,
): FunctionMetrics {
  return {
    functionId,
    totalCalls: 0,
    successCount: 0,
    failureCount: 0,
    avgLatencyMs: 0,
    avgQualityScore: 0,
    windowStartedAt: now,
    windowMs,
    qualitySampleCount: 0,
  };
}

function isExpired(
  metrics: FunctionMetrics,
  windowMs: number,
  nowMs: number,
): boolean {
  if (!metrics.windowStartedAt) return true;
  const startedMs = Date.parse(metrics.windowStartedAt);
  if (Number.isNaN(startedMs)) return true;
  return nowMs - startedMs >= windowMs;
}

export class MetricsStore {
  private cache = new Map<string, FunctionMetrics>();

  constructor(private kv: StateKV) {}

  async record(
    functionId: string,
    latencyMs: number,
    success: boolean,
    qualityScore?: number,
  ): Promise<void> {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const windowMs = metricsWindowMs();
    const stored =
      this.cache.get(functionId) ??
      (await this.kv.get<FunctionMetrics>(KV.metrics, functionId)) ??
      emptyMetrics(functionId, now, windowMs);
    const m = isExpired(stored, windowMs, nowMs)
      ? emptyMetrics(functionId, now, windowMs)
      : stored;

    const prev = m.totalCalls;
    m.totalCalls += 1;
    m.avgLatencyMs = (m.avgLatencyMs * prev + latencyMs) / m.totalCalls;
    if (success) {
      m.successCount += 1;
    } else {
      m.failureCount += 1;
      m.lastFailureAt = now;
    }
    if (qualityScore !== undefined) {
      const prevQualityCalls = m.qualitySampleCount ?? 0;
      m.avgQualityScore =
        (m.avgQualityScore * prevQualityCalls + qualityScore) /
        (prevQualityCalls + 1);
      m.qualitySampleCount = prevQualityCalls + 1;
    }

    m.windowMs = windowMs;
    m.lastCallAt = now;
    this.cache.set(functionId, m);
    await this.kv.set(KV.metrics, functionId, m).catch(() => {});
  }

  async get(functionId: string): Promise<FunctionMetrics | null> {
    const stored =
      this.cache.get(functionId) ??
      (await this.kv.get<FunctionMetrics>(KV.metrics, functionId));
    if (!stored) return null;
    const windowMs = metricsWindowMs();
    if (isExpired(stored, windowMs, Date.now())) {
      return emptyMetrics(functionId, new Date().toISOString(), windowMs);
    }
    return stored;
  }

  async getAll(): Promise<FunctionMetrics[]> {
    const kvMetrics = await this.kv
      .list<FunctionMetrics>(KV.metrics)
      .catch(() => []);
    const merged = new Map<string, FunctionMetrics>();
    for (const m of kvMetrics) merged.set(m.functionId, m);
    for (const [id, m] of this.cache) merged.set(id, m);
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const windowMs = metricsWindowMs();
    return Array.from(merged.values()).map((m) =>
      isExpired(m, windowMs, nowMs) ? emptyMetrics(m.functionId, now, windowMs) : m,
    );
  }
}
