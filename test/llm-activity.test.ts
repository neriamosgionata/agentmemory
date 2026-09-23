import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  gateEnabledFor,
  enableLlmActivityGateFor,
  llmIdleGapMs,
  llmIdleMaxWaitMs,
  waitForLlmIdle,
  wrapProviderWithActivity,
  isLlmActivityTrackingActive,
  trackLlmCall,
  __resetLlmActivity,
} from "../src/providers/llm-activity.js";
import { createFallbackProvider, createProvider } from "../src/providers/index.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LOOPBACK = "http://127.0.0.1:11434/v1";

describe("llm activity gate", () => {
  const ORIG_GATE = process.env["AGENTMEMORY_LLM_GATE"];
  const ORIG_GAP = process.env["AGENTMEMORY_LLM_IDLE_GAP_MS"];
  const ORIG_MAX = process.env["AGENTMEMORY_LLM_IDLE_MAX_WAIT_MS"];
  const ORIG_KEY = process.env["OPENAI_API_KEY"];

  beforeEach(() => {
    delete process.env["AGENTMEMORY_LLM_GATE"];
    delete process.env["AGENTMEMORY_LLM_IDLE_GAP_MS"];
    delete process.env["AGENTMEMORY_LLM_IDLE_MAX_WAIT_MS"];
    __resetLlmActivity();
  });

  afterEach(() => {
    if (ORIG_GATE === undefined) delete process.env["AGENTMEMORY_LLM_GATE"];
    else process.env["AGENTMEMORY_LLM_GATE"] = ORIG_GATE;
    if (ORIG_GAP === undefined) delete process.env["AGENTMEMORY_LLM_IDLE_GAP_MS"];
    else process.env["AGENTMEMORY_LLM_IDLE_GAP_MS"] = ORIG_GAP;
    if (ORIG_MAX === undefined) delete process.env["AGENTMEMORY_LLM_IDLE_MAX_WAIT_MS"];
    else process.env["AGENTMEMORY_LLM_IDLE_MAX_WAIT_MS"] = ORIG_MAX;
    if (ORIG_KEY === undefined) delete process.env["OPENAI_API_KEY"];
    else process.env["OPENAI_API_KEY"] = ORIG_KEY;
    __resetLlmActivity();
  });

  describe("gateEnabledFor", () => {
    it("auto-enables for loopback base URLs only", () => {
      expect(gateEnabledFor("http://127.0.0.1:11434/v1")).toBe(true);
      expect(gateEnabledFor("http://localhost:11434/v1")).toBe(true);
      expect(gateEnabledFor("https://api.openai.com")).toBe(false);
      expect(gateEnabledFor(undefined)).toBe(false);
    });

    it("honors an explicit override over the URL heuristic", () => {
      process.env["AGENTMEMORY_LLM_GATE"] = "off";
      expect(gateEnabledFor(LOOPBACK)).toBe(false);

      process.env["AGENTMEMORY_LLM_GATE"] = "on";
      expect(gateEnabledFor("https://api.openai.com")).toBe(true);
    });
  });

  describe("enableLlmActivityGateFor", () => {
    it("activates tracking only when the gate applies", () => {
      expect(enableLlmActivityGateFor("https://api.openai.com")).toBe(false);
      expect(isLlmActivityTrackingActive()).toBe(false);

      expect(enableLlmActivityGateFor(LOOPBACK)).toBe(true);
      expect(isLlmActivityTrackingActive()).toBe(true);
    });
  });

  describe("llmIdleGapMs", () => {
    it("defaults to 3000ms and honors a valid override", () => {
      expect(llmIdleGapMs()).toBe(3000);
      process.env["AGENTMEMORY_LLM_IDLE_GAP_MS"] = "450";
      expect(llmIdleGapMs()).toBe(450);
      process.env["AGENTMEMORY_LLM_IDLE_GAP_MS"] = "nope";
      expect(llmIdleGapMs()).toBe(3000);
      process.env["AGENTMEMORY_LLM_IDLE_GAP_MS"] = "";
      expect(llmIdleGapMs()).toBe(3000);
    });
  });

  describe("llmIdleMaxWaitMs", () => {
    it("defaults to 20000ms and honors a valid override", () => {
      expect(llmIdleMaxWaitMs()).toBe(20000);
      process.env["AGENTMEMORY_LLM_IDLE_MAX_WAIT_MS"] = "250";
      expect(llmIdleMaxWaitMs()).toBe(250);
      process.env["AGENTMEMORY_LLM_IDLE_MAX_WAIT_MS"] = "-5";
      expect(llmIdleMaxWaitMs()).toBe(20000);
    });
  });

  it("waitForLlmIdle is a no-op until activity tracking is active", async () => {
    process.env["AGENTMEMORY_LLM_IDLE_GAP_MS"] = "5000";
    expect(isLlmActivityTrackingActive()).toBe(false);
    await expect(waitForLlmIdle()).resolves.toBe(true);
  });

  it("waits for the in-flight call and the idle gap after it ends", async () => {
    process.env["AGENTMEMORY_LLM_IDLE_GAP_MS"] = "120";
    enableLlmActivityGateFor(LOOPBACK);

    let release!: () => void;
    const inFlight = trackLlmCall(
      () => new Promise<void>((r) => { release = r; }),
    );
    let idle = false;
    const idleWait = waitForLlmIdle().then(() => { idle = true; });

    await sleep(40);
    expect(idle).toBe(false);
    release();
    await inFlight;
    await sleep(60);
    expect(idle).toBe(false);
    await idleWait;
    expect(idle).toBe(true);
  });

  it("gives up at maxWait and reports the idle state reached", async () => {
    process.env["AGENTMEMORY_LLM_IDLE_GAP_MS"] = "5000";
    enableLlmActivityGateFor(LOOPBACK);

    let release!: () => void;
    const inFlight = trackLlmCall(
      () => new Promise<void>((r) => { release = r; }),
    );

    const startedAt = Date.now();
    await expect(waitForLlmIdle(120)).resolves.toBe(false);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(1000);

    release();
    await inFlight;
  });

  it("wrapProviderWithActivity marks calls and passes descriptors through", async () => {
    process.env["AGENTMEMORY_LLM_IDLE_GAP_MS"] = "120";
    enableLlmActivityGateFor(LOOPBACK);
    const inner = {
      name: "fake",
      compress: vi.fn(async () => { await sleep(50); return "compressed"; }),
      summarize: vi.fn(async () => "summarized"),
      describeImage: vi.fn(async () => "described"),
    };
    const wrapped = wrapProviderWithActivity(inner as never);

    expect(wrapped.name).toBe("fake");
    expect(await wrapped.summarize("s", "u")).toBe("summarized");
    expect(await wrapped.describeImage!("d", "image/png", "p")).toBe("described");

    const call = wrapped.compress("s", "u");
    const p = call;
    await sleep(20);
    let idle = false;
    const idleWait = waitForLlmIdle().then(() => { idle = true; });
    await sleep(20);
    expect(idle).toBe(false);
    expect(await p).toBe("compressed");
    await idleWait;
    expect(idle).toBe(true);
  });

  it("createProvider activates tracking only for a loopback base URL", () => {
    process.env["OPENAI_API_KEY"] = "test-key";
    const remote = createProvider({ provider: "openai", model: "gpt-4o", maxTokens: 16, baseURL: "https://api.openai.com" });
    expect(remote.name).toContain("openai");
    expect(isLlmActivityTrackingActive()).toBe(false);

    createProvider({ provider: "openai", model: "qwen3:8b", maxTokens: 16, baseURL: LOOPBACK });
    expect(isLlmActivityTrackingActive()).toBe(true);
  });

  it("createFallbackProvider activates tracking on the fallback path too", () => {
    process.env["OPENAI_API_KEY"] = "test-key";
    createFallbackProvider(
      { provider: "openai", model: "gpt-4o", maxTokens: 16, baseURL: "https://api.openai.com" },
      { providers: ["noop"] },
    );
    expect(isLlmActivityTrackingActive()).toBe(false);

    createFallbackProvider(
      { provider: "openai", model: "qwen3:8b", maxTokens: 16, baseURL: LOOPBACK },
      { providers: ["noop"] },
    );
    expect(isLlmActivityTrackingActive()).toBe(true);
  });
});
