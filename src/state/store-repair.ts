import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// #1364: the file_based KV adapter can append a handful of garbage bytes
// (0x00, 0x1D, non-UTF-8) after the final JSON token of a scope file. The
// engine then fails a strict whole-file JSON.parse on boot and every read
// against that scope returns "Invocation stopped" while sibling scopes stay
// healthy. The engine owns the write path, so this module is the operator-
// side repair: detect a file whose last non-whitespace byte is not a JSON
// close token, then truncate everything after the last prefix that parses
// as complete JSON. No records are removed.

const MAX_REPAIR_BYTES = 512 * 1024 * 1024;
const TAIL_PROBE_BYTES = 64;
const MAX_BOUNDARY_ATTEMPTS = 10;

const JSON_CLOSE_BYTES = new Set([0x7d, 0x5d]);

export function endsWithJsonClose(buf: Buffer): boolean {
  for (let i = buf.length - 1; i >= 0; i--) {
    const b = buf[i]!;
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) continue;
    return JSON_CLOSE_BYTES.has(b);
  }
  return true;
}

export function findRepairBoundary(content: string): number | null {
  try {
    JSON.parse(content);
    return null;
  } catch {
    // fall through: look for a valid prefix
  }

  let searchFrom = content.length - 1;
  for (let attempt = 0; attempt < MAX_BOUNDARY_ATTEMPTS; attempt++) {
    let closeIndex = -1;
    for (let i = searchFrom; i >= 0; i--) {
      const ch = content[i];
      if (ch === "}" || ch === "]") {
        closeIndex = i;
        break;
      }
    }
    if (closeIndex < 0) return null;
    const prefix = content.slice(0, closeIndex + 1);
    try {
      JSON.parse(prefix);
      return closeIndex + 1;
    } catch {
      searchFrom = closeIndex - 1;
    }
  }
  return null;
}

export interface RepairedFile {
  file: string;
  removedBytes: number;
  keptBytes: number;
}

export interface StoreRepairReport {
  scanned: number;
  suspicious: string[];
  repaired: RepairedFile[];
  errors: string[];
}

export interface StoreScanReport {
  scanned: number;
  suspicious: string[];
  errors: string[];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function scanStateStore(stateDir: string): StoreScanReport {
  const report: StoreScanReport = { scanned: 0, suspicious: [], errors: [] };
  let files: string[];
  try {
    files = readdirSync(stateDir).filter((f) => f.endsWith(".bin"));
  } catch (err) {
    report.errors.push(`cannot read ${stateDir}: ${errorMessage(err)}`);
    return report;
  }

  for (const file of files) {
    report.scanned += 1;
    const path = join(stateDir, file);
    try {
      const size = statSync(path).size;
      if (size === 0) continue;
      const readLen = Math.min(TAIL_PROBE_BYTES, size);
      const buf = Buffer.alloc(readLen);
      const fd = openSync(path, "r");
      try {
        readSync(fd, buf, 0, readLen, size - readLen);
      } finally {
        closeSync(fd);
      }
      if (!endsWithJsonClose(buf)) report.suspicious.push(file);
    } catch (err) {
      report.errors.push(`${file}: ${errorMessage(err)}`);
    }
  }

  return report;
}

export function repairStateStore(stateDir: string): StoreRepairReport {
  const scan = scanStateStore(stateDir);
  const report: StoreRepairReport = {
    scanned: scan.scanned,
    suspicious: scan.suspicious,
    repaired: [],
    errors: [...scan.errors],
  };

  for (const file of scan.suspicious) {
    const path = join(stateDir, file);
    try {
      const size = statSync(path).size;
      if (size > MAX_REPAIR_BYTES) {
        report.errors.push(`${file}: exceeds ${MAX_REPAIR_BYTES} byte repair limit`);
        continue;
      }
      const content = readFileSync(path, "utf-8");
      const boundary = findRepairBoundary(content);
      if (boundary === null) {
        report.errors.push(`${file}: no parseable JSON prefix found; left untouched`);
        continue;
      }
      const kept = content.slice(0, boundary);
      const keptBytes = Buffer.byteLength(kept, "utf-8");
      writeFileSync(path, kept, "utf-8");
      report.repaired.push({
        file,
        removedBytes: Math.max(size - keptBytes, 0),
        keptBytes,
      });
    } catch (err) {
      report.errors.push(`${file}: ${errorMessage(err)}`);
    }
  }

  return report;
}
