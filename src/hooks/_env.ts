import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// #1331: hooks and the standalone MCP shim are separate Node processes and
// never went through src/config.ts's hydration, so values that live only in
// ~/.agentmemory/.env (AGENTMEMORY_SECRET, AGENTMEMORY_URL,
// AGENTMEMORY_INJECT_CONTEXT) were invisible to them. Every request then went
// out unauthenticated and the failure was swallowed. os.homedir() resolves
// USERPROFILE on Windows, where HOME is unset.
export function hookEnvPath(): string {
  return join(homedir(), ".agentmemory", ".env");
}

export function parseHookEnv(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!key) continue;
    let val = trimmed.slice(eqIdx + 1).trim();
    const quoteChar = val[0] === '"' || val[0] === "'" ? val[0] : "";
    if (quoteChar) {
      const closeIdx = val.indexOf(quoteChar, 1);
      if (closeIdx !== -1) val = val.slice(1, closeIdx);
    } else {
      const hashIdx = val.indexOf(" #");
      if (hashIdx !== -1) val = val.slice(0, hashIdx).trim();
    }
    vars[key] = val;
  }
  return vars;
}

/** Copy unset vars from ~/.agentmemory/.env into process.env. Real process
 *  env always wins, matching config.ts's precedence. */
export function hydrateHookEnv(envPath = hookEnvPath()): void {
  if (!existsSync(envPath)) return;
  let vars: Record<string, string>;
  try {
    vars = parseHookEnv(readFileSync(envPath, "utf-8"));
  } catch {
    return;
  }
  for (const [key, value] of Object.entries(vars)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
