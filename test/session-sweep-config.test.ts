import { describe, it, expect, afterEach } from "vitest";

import {
  getSessionSweepStaleHours,
  isSessionSweepEnabled,
} from "../src/config.js";

const KEYS = [
  "AGENTMEMORY_SESSION_SWEEP_ENABLED",
  "AGENTMEMORY_SESSION_SWEEP_STALE_HOURS",
];

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

describe("session sweep config", () => {
  it("is enabled unless explicitly set to false", () => {
    process.env["AGENTMEMORY_SESSION_SWEEP_ENABLED"] = "";
    expect(isSessionSweepEnabled()).toBe(true);

    process.env["AGENTMEMORY_SESSION_SWEEP_ENABLED"] = "true";
    expect(isSessionSweepEnabled()).toBe(true);

    process.env["AGENTMEMORY_SESSION_SWEEP_ENABLED"] = "0";
    expect(isSessionSweepEnabled()).toBe(true);

    process.env["AGENTMEMORY_SESSION_SWEEP_ENABLED"] = "false";
    expect(isSessionSweepEnabled()).toBe(false);
  });

  it("defaults stale hours to 24 and rejects malformed or non-positive values", () => {
    for (const bad of ["", "abc", "1e2", "0", "-5", "24.5", "   "]) {
      process.env["AGENTMEMORY_SESSION_SWEEP_STALE_HOURS"] = bad;
      expect(getSessionSweepStaleHours()).toBe(24);
    }
  });

  it("accepts a positive integer and trims whitespace", () => {
    process.env["AGENTMEMORY_SESSION_SWEEP_STALE_HOURS"] = " 48 ";
    expect(getSessionSweepStaleHours()).toBe(48);
  });
});
