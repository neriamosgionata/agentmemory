import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";

export const IMPORT_ROOT_ENV = "AGENTMEMORY_IMPORT_ROOT";

export function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) return join(homedir(), input.slice(2));
  return input;
}

export function allowedFileRoots(extra: string[] = []): string[] {
  const roots = [join(homedir(), ".agentmemory")];
  const dataDir = process.env["AGENTMEMORY_DATA_DIR"]?.trim();
  if (dataDir) roots.push(dataDir);
  const configured = process.env[IMPORT_ROOT_ENV] || "";
  for (const entry of configured.split(delimiter)) {
    const trimmed = entry.trim();
    if (trimmed) roots.push(expandHome(trimmed));
  }
  roots.push(...extra);
  return roots.filter((root) => isAbsolute(root)).map((root) => resolve(root));
}

async function realpathOfNearest(path: string): Promise<string> {
  const suffix: string[] = [];
  let current = path;
  for (;;) {
    try {
      const real = await realpath(current);
      return suffix.length > 0 ? join(real, ...suffix.reverse()) : real;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      const parent = dirname(current);
      if (parent === current) return path;
      suffix.push(basename(current));
      current = parent;
    }
  }
}

function within(path: string, root: string): boolean {
  if (path === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return path.startsWith(prefix);
}

export type ConfinedPath =
  | { ok: true; path: string }
  | { ok: false; error: string };

export async function confinePath(
  input: unknown,
  roots: string[] = allowedFileRoots(),
): Promise<ConfinedPath> {
  if (typeof input !== "string" || input.trim() === "" || input.includes("\0")) {
    return { ok: false, error: "path must be a non-empty string" };
  }
  const absolute = resolve(expandHome(input.trim()));
  let real: string;
  try {
    real = await realpathOfNearest(absolute);
  } catch {
    return { ok: false, error: "path could not be resolved" };
  }
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = await realpathOfNearest(root);
    } catch {
      continue;
    }
    if (within(real, realRoot)) return { ok: true, path: absolute };
  }
  return {
    ok: false,
    error: `path is outside the allowed roots (${roots.join(", ")}). Set ${IMPORT_ROOT_ENV} to a directory to allow file access under it.`,
  };
}
