import type { MemoryProvider } from "../types.js";
import { getEnvVar } from "../config.js";

// The daemon shares one LLM endpoint across interactive work (per-turn
// summarization, remembered-observation extraction) and background drains
// (api::graph-build). Against a single-slot local server (Ollama reports
// n_slots = 1) a continuous background drain keeps the slot busy for the
// whole run, so interactive calls queue behind 50-90s generations and die
// on the 180s invocation ceiling. The graph-build loop parks between
// batches here, waiting until no LLM call has been in flight for a quiet
// window. Tracking is activated for loopback endpoints by default
// (AGENTMEMORY_LLM_GATE overrides), so hosted APIs keep their existing
// parallelism.

const LOOPBACK_ENDPOINT =
  /^(?:https?:\/\/)?(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]|$)/i;

const IDLE_GAP_DEFAULT_MS = 3000;
const IDLE_MAX_WAIT_DEFAULT_MS = 20000;
const IDLE_POLL_MS = 100;

let trackingActive = false;
let inFlight = 0;
let lastEndAt = 0;

export function gateEnabledFor(baseURL?: string): boolean {
  const raw = (getEnvVar("AGENTMEMORY_LLM_GATE") ?? "auto").trim().toLowerCase();
  if (raw === "off" || raw === "false" || raw === "0") return false;
  if (raw === "on" || raw === "true" || raw === "1") return true;
  return typeof baseURL === "string" && LOOPBACK_ENDPOINT.test(baseURL.trim());
}

export function enableLlmActivityGateFor(baseURL?: string): boolean {
  if (!gateEnabledFor(baseURL)) return false;
  trackingActive = true;
  return true;
}

export function isLlmActivityTrackingActive(): boolean {
  return trackingActive;
}

function nonNegativeEnvMs(key: string, fallback: number): number {
  const raw = getEnvVar(key);
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

export function llmIdleGapMs(): number {
  return nonNegativeEnvMs("AGENTMEMORY_LLM_IDLE_GAP_MS", IDLE_GAP_DEFAULT_MS);
}

export function llmIdleMaxWaitMs(): number {
  return nonNegativeEnvMs("AGENTMEMORY_LLM_IDLE_MAX_WAIT_MS", IDLE_MAX_WAIT_DEFAULT_MS);
}

function markLlmCallStart(): void {
  inFlight += 1;
}

function markLlmCallEnd(): void {
  inFlight = Math.max(0, inFlight - 1);
  lastEndAt = Date.now();
}

export async function trackLlmCall<T>(fn: () => Promise<T>): Promise<T> {
  markLlmCallStart();
  try {
    return await fn();
  } finally {
    markLlmCallEnd();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForLlmIdle(maxWaitMs: number = llmIdleMaxWaitMs()): Promise<boolean> {
  if (!trackingActive) return true;
  const gap = llmIdleGapMs();
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    if (inFlight === 0 && Date.now() - lastEndAt >= gap) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return inFlight === 0 && Date.now() - lastEndAt >= gap;
    await sleep(Math.min(IDLE_POLL_MS, remaining));
  }
}

export function wrapProviderWithActivity(inner: MemoryProvider): MemoryProvider {
  const wrapped: MemoryProvider = {
    name: inner.name,
    compress: (systemPrompt, userPrompt) =>
      trackLlmCall(() => inner.compress(systemPrompt, userPrompt)),
    summarize: (systemPrompt, userPrompt) =>
      trackLlmCall(() => inner.summarize(systemPrompt, userPrompt)),
  };
  if (inner.describeImage) {
    const describeImage = inner.describeImage.bind(inner);
    wrapped.describeImage = (imageData, mimeType, prompt) =>
      trackLlmCall(() => describeImage(imageData, mimeType, prompt));
  }
  return wrapped;
}

export function __resetLlmActivity(): void {
  trackingActive = false;
  inFlight = 0;
  lastEndAt = 0;
}
