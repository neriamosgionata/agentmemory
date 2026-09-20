import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  hydrateHookEnv,
  parseHookEnv,
} from "../src/hooks/_env.js";

describe("hook env hydration (#1331)", () => {
  let home: string;
  const ORIGINAL = { ...process.env };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "am-hook-env-"));
    mkdirSync(join(home, ".agentmemory"), { recursive: true });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL };
    rmSync(home, { recursive: true, force: true });
  });

  it("parses quoted values, comments, and blank lines", () => {
    expect(
      parseHookEnv(
        [
          "# comment",
          "",
          "AGENTMEMORY_SECRET=abc123",
          'AGENTMEMORY_URL="http://localhost:3111"',
          "FLAG='true'",
          "TRAILING=value # inline comment",
        ].join("\n"),
      ),
    ).toEqual({
      AGENTMEMORY_SECRET: "abc123",
      AGENTMEMORY_URL: "http://localhost:3111",
      FLAG: "true",
      TRAILING: "value",
    });
  });

  it("copies unset vars into process.env and never overrides real env", () => {
    const envPath = join(home, ".agentmemory", ".env");
    writeFileSync(
      envPath,
      "AGENTMEMORY_SECRET=from-file\nAGENTMEMORY_URL=http://from-file\n",
    );
    delete process.env["AGENTMEMORY_SECRET"];
    process.env["AGENTMEMORY_URL"] = "http://real-env";

    hydrateHookEnv(envPath);

    expect(process.env["AGENTMEMORY_SECRET"]).toBe("from-file");
    expect(process.env["AGENTMEMORY_URL"]).toBe("http://real-env");
  });

  it("is a no-op when the env file is missing", () => {
    delete process.env["AGENTMEMORY_SECRET"];
    hydrateHookEnv(join(home, "nope", ".env"));
    expect(process.env["AGENTMEMORY_SECRET"]).toBeUndefined();
  });

  it("resolves the default path from os.homedir (HOME or USERPROFILE)", async () => {
    const { hookEnvPath } = await import("../src/hooks/_env.js");
    expect(hookEnvPath().endsWith(join(".agentmemory", ".env"))).toBe(true);
  });
});
