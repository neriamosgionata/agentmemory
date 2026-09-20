import type { CompressedObservation, Memory } from "../types.js";
import { KV } from "./schema.js";
import type { StateKV } from "./kv.js";
import { memoryToObservation } from "./memory-utils.js";

/**
 * Observation rows live in per-session scopes and are not addressable from an
 * id alone. Resolve the owning row by hint first, then a bounded scan over
 * sessions. Shared by smart-search and graph retrieval, which both receive
 * bare observation ids from indexes/traversals. #925
 */
export async function findObservation(
  kv: StateKV,
  obsId: string,
  sessionIdHint?: string,
): Promise<CompressedObservation | null> {
  if (sessionIdHint) {
    const obs = await kv
      .get<CompressedObservation>(KV.observations(sessionIdHint), obsId)
      .catch(() => null);
    if (obs) return obs;
  }

  const sessions = await kv.list<{ id: string }>(KV.sessions);
  for (let i = 0; i < sessions.length; i += 5) {
    const batch = sessions.slice(i, i + 5);
    const results = await Promise.all(
      batch.map((s) =>
        kv
          .get<CompressedObservation>(KV.observations(s.id), obsId)
          .catch(() => null),
      ),
    );
    const found = results.find((r) => r !== null);
    if (found) return found;
  }
  return null;
}

export async function findObservationSession(
  kv: StateKV,
  obsId: string,
  sessionIdHint?: string,
): Promise<string | null> {
  const obs = await findObservation(kv, obsId, sessionIdHint);
  return obs?.sessionId ?? null;
}

/**
 * Expand an id that may name an observation OR a durable memory. Compact
 * smart-search results return `mem_*` ids; expanding them only through the
 * observation scopes dropped every durable hit. Falls back to KV.memories and
 * coerces through memoryToObservation so callers get one shape. #1080
 */
export async function findObservationOrMemory(
  kv: StateKV,
  id: string,
  sessionIdHint?: string,
): Promise<CompressedObservation | null> {
  const obs = await findObservation(kv, id, sessionIdHint);
  if (obs) return obs;
  const mem = await kv.get<Memory>(KV.memories, id).catch(() => null);
  return mem ? memoryToObservation(mem) : null;
}
