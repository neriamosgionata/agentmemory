import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// #991: the 1.5s deferred exit on SessionEnd (and Stop) outlived the host's
// shutdown grace and surfaced as "Hook cancelled". Single-request hooks only
// need the timer to cover dispatch; the bridge path keeps the longer window.
describe("hook deferred-exit budget (#991)", () => {
  it("Stop exits after 500ms", () => {
    const stop = readFileSync("src/hooks/stop.ts", "utf-8");
    expect(stop).toMatch(/setTimeout\(\(\) => process\.exit\(0\), 500\)\.unref\(\)/);
    expect(stop).not.toMatch(/process\.exit\(0\), 1500\)/);
  });

  it("SessionEnd uses 500ms without the bridge and 1500ms with it", () => {
    const sessionEnd = readFileSync("src/hooks/session-end.ts", "utf-8");
    expect(sessionEnd).toMatch(
      /bridgeEnabled \? 1500 : 500/,
    );
    expect(sessionEnd).toMatch(/CLAUDE_MEMORY_BRIDGE/);
  });
});
