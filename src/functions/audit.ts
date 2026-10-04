import type { AuditEntry } from "../types.js";
import { KV, generateId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { logger } from "../logger.js";

// Audit coverage policy (issue #125).
//
// Every structural deletion of a memory, observation, session, or
// semantic row MUST call recordAudit. Two shapes are allowed, keyed to
// whether the caller is scoped or bulk:
//
//   Scoped deletions — a user-visible, per-call action removing a
//   bounded set of items. Emit ONE audit row per call with targetIds
//   populated. Examples: mem::governance-delete, mem::forget.
//
//   Bulk deletions — automatic sweeps (retention, TTL eviction,
//   auto-forget) that can remove hundreds of rows per invocation.
//   Emit ONE batched audit row per invocation with targetIds listing
//   every removed id and details.evicted holding the count. Per-item
//   audit rows would flood the audit log during routine sweeps.
//
//   Either shape is required; silent deletes are not acceptable.
//
// operation field:
//   - "delete"          — permanent removal (governance, retention sweep, evict).
//   - "forget"          — forget/removal flows. Scoped when emitted by
//                         mem::forget (user-initiated); bulk-batched when
//                         emitted by mem::auto-forget (automatic sweep).
//   - everything else   — see AuditEntry["operation"] union in src/types.ts.
//
// When adding a new deletion path, add an explicit recordAudit call
// BEFORE kv.delete(...) and match one of the two shapes above.

export async function recordAudit(
  kv: StateKV,
  operation: AuditEntry["operation"],
  functionId: string,
  targetIds: string[],
  details: Record<string, unknown> = {},
  qualityScore?: number,
  userId?: string,
): Promise<AuditEntry> {
  const entry: AuditEntry = {
    id: generateId("aud"),
    timestamp: new Date().toISOString(),
    operation,
    userId,
    functionId,
    targetIds,
    details,
    qualityScore,
  };
  await kv.set(KV.audit, entry.id, entry);
  return entry;
}

export async function safeAudit(
  kv: StateKV,
  operation: AuditEntry["operation"],
  functionId: string,
  targetIds: string[],
  details: Record<string, unknown> = {},
  qualityScore?: number,
  userId?: string,
): Promise<void> {
  try {
    await recordAudit(kv, operation, functionId, targetIds, details, qualityScore, userId);
  } catch (err) {
    try {
      logger.warn("audit write failed", {
        functionId,
        operation,
        targetIds,
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {}
  }
}

// state::list over the full audit scope is the one call that can kill the
// state worker: at 70k+ rows the response exceeds the worker's WebSocket
// write budget, the connection resets, and the unflushed response keeps
// poisoning every reconnect until the daemon restarts (observed live
// 2026-10-04). list_keys returns ids only (~2 MB / ~80 ms for 70k keys), so
// the query pages newest-first through keys and fetches only the entries it
// needs. The scan cap bounds the pathological case of a filter matching
// nothing; id order is timestamp order to millisecond precision, with rare
// same-millisecond inversions smoothed by the final sort.
const AUDIT_QUERY_BATCH = 100;
const AUDIT_QUERY_SCAN_CAP = 20_000;

export async function queryAudit(
  kv: StateKV,
  filter?: {
    operation?: AuditEntry["operation"];
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
  },
): Promise<AuditEntry[]> {
  const limit = filter?.limit || 100;
  let fromMs: number | undefined;
  let toMs: number | undefined;
  if (filter?.dateFrom) {
    fromMs = new Date(filter.dateFrom).getTime();
    if (Number.isNaN(fromMs)) {
      throw new Error(`Invalid dateFrom: ${filter.dateFrom}`);
    }
  }
  if (filter?.dateTo) {
    toMs = new Date(filter.dateTo).getTime();
    if (Number.isNaN(toMs)) {
      throw new Error(`Invalid dateTo: ${filter.dateTo}`);
    }
  }

  const keys = (await kv.listKeys(KV.audit)).sort((a, b) =>
    a < b ? 1 : a > b ? -1 : 0,
  );
  const scanLimit = Math.min(keys.length, AUDIT_QUERY_SCAN_CAP);
  const matched: AuditEntry[] = [];

  for (
    let scanned = 0;
    scanned < scanLimit && matched.length < limit;
    scanned += AUDIT_QUERY_BATCH
  ) {
    const batch = keys.slice(scanned, Math.min(scanned + AUDIT_QUERY_BATCH, scanLimit));
    const rows = await Promise.all(
      batch.map((key) => kv.get<AuditEntry>(KV.audit, key)),
    );
    for (const entry of rows) {
      if (!entry) continue;
      if (filter?.operation && entry.operation !== filter.operation) continue;
      const at = new Date(entry.timestamp).getTime();
      if (fromMs !== undefined && at < fromMs) continue;
      if (toMs !== undefined && at > toMs) continue;
      matched.push(entry);
    }
  }

  return matched
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit);
}
