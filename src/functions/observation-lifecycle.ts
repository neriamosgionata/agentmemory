import type { Session } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { getGraphView, invalidateGraphCache } from "../state/graph-cache.js";
import { logger } from "../logger.js";

export interface ObservationDeletion {
  sessionId: string;
  obsId: string;
}

/**
 * Derived per-session state (incremental summary partials, graph-extraction
 * watermarks) is only valid for the exact observation rows it was computed
 * from. Any delete or reorder invalidates the partial cache's chunk
 * boundaries and the watermark's coverage, so both rows are dropped and the
 * next summarize/extract recomputes from scratch. Missing rows are not an
 * error: most sessions never had derived state to begin with.
 */
export async function clearSessionDerivedState(
  kv: StateKV,
  sessionId: string,
): Promise<void> {
  if (!sessionId) return;
  await Promise.all(
    [KV.summaryPartials, KV.graphExtractionWatermarks].map((scope) =>
      kv.delete(scope, sessionId).catch((err: unknown) => {
        logger.warn("derived-state cleanup failed", {
          scope,
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }),
    ),
  );
}

/**
 * Every observation delete path (evict, auto-forget, the per-session capture
 * cap) removed the KV row and search entries but left two derived views
 * stale: the owning session's observationCount and the graph nodes/edges that
 * cite the observation as provenance. Reconcile both once per batch so
 * counters keep matching the store and graph queries stop surfacing
 * replaced-away sources. #1157
 */
export async function reconcileObservationDeletions(
  kv: StateKV,
  deletions: ObservationDeletion[],
): Promise<void> {
  if (deletions.length === 0) return;
  const obsIds = new Set(deletions.map((d) => d.obsId));

  const perSession = new Map<string, number>();
  for (const d of deletions) {
    perSession.set(d.sessionId, (perSession.get(d.sessionId) ?? 0) + 1);
  }
  for (const [sessionId, count] of perSession) {
    try {
      const session = await kv.get<Session>(KV.sessions, sessionId);
      if (!session || typeof session.observationCount !== "number") continue;
      const next = Math.max(0, session.observationCount - count);
      if (next === session.observationCount) continue;
      await kv.set(KV.sessions, sessionId, {
        ...session,
        observationCount: next,
      });
    } catch (err) {
      logger.warn("observation deletion session-counter sync failed", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // A delete shifts the observation list, so any partial cache or
  // extraction watermark computed against the old shape is stale even
  // though the surviving rows are untouched. Force a full recompute.
  await Promise.all(
    [...perSession.keys()].map((sessionId) =>
      clearSessionDerivedState(kv, sessionId),
    ),
  );

  try {
    const view = await getGraphView(kv);
    let touched = 0;
    for (const node of view.nodes.values()) {
      const citations = node.sourceObservationIds ?? [];
      if (!citations.some((id) => obsIds.has(id))) continue;
      await kv.set(KV.graphNodes, node.id, {
        ...node,
        sourceObservationIds: citations.filter((id) => !obsIds.has(id)),
      });
      touched++;
    }
    for (const edge of view.edges.values()) {
      const citations = edge.sourceObservationIds ?? [];
      if (!citations.some((id) => obsIds.has(id))) continue;
      await kv.set(KV.graphEdges, edge.id, {
        ...edge,
        sourceObservationIds: citations.filter((id) => !obsIds.has(id)),
      });
      touched++;
    }
    if (touched > 0) invalidateGraphCache(kv as unknown as object);
  } catch (err) {
    logger.warn("observation deletion graph-provenance sync failed", {
      deleted: deletions.length,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
