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
