import type { ISdk } from "iii-sdk";
import type {
  Session,
  CompressedObservation,
  RawObservation,
} from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { recordAudit } from "./audit.js";
import { logger } from "../logger.js";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

function isCompressed(
  obs: CompressedObservation | RawObservation,
): obs is CompressedObservation {
  return typeof (obs as { title?: unknown }).title === "string" &&
    (obs as { title: string }).title.length > 0;
}

/**
 * Recovery path for observations whose compression failed (#1228): the row
 * was stored raw, so it is invisible to search, and mem::observe dedupes a
 * re-send. This re-runs mem::compress over the raw rows, bounded per call so
 * a large backlog cannot wedge the worker; call it repeatedly to drain.
 */
export function registerRecompressFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::recompress",
    async (data?: { sessionId?: string; limit?: number }) => {
      const requested =
        typeof data?.limit === "number" && Number.isFinite(data.limit)
          ? Math.floor(data.limit)
          : DEFAULT_LIMIT;
      const limit = Math.min(Math.max(requested, 1), MAX_LIMIT);
      const explicitSessionId =
        typeof data?.sessionId === "string" && data.sessionId.trim().length > 0
          ? data.sessionId.trim()
          : undefined;

      let sessions: Session[];
      if (explicitSessionId) {
        const session = await kv.get<Session>(KV.sessions, explicitSessionId);
        sessions = session ? [session] : [];
      } else {
        sessions = await kv.list<Session>(KV.sessions).catch(() => []);
      }

      let attempted = 0;
      let recovered = 0;
      let failed = 0;
      let limitReached = false;

      outer: for (const session of sessions) {
        let observations: Array<CompressedObservation | RawObservation>;
        try {
          observations = await kv.list<CompressedObservation | RawObservation>(
            KV.observations(session.id),
          );
        } catch (err) {
          logger.warn("Recompress: observation scan failed", {
            sessionId: session.id,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        for (const obs of observations) {
          if (attempted >= limit) {
            limitReached = true;
            break outer;
          }
          if (isCompressed(obs)) continue;
          attempted++;
          try {
            const result = (await sdk.trigger({
              function_id: "mem::compress",
              payload: {
                observationId: obs.id,
                sessionId: session.id,
                raw: obs,
              },
            })) as { success?: boolean } | undefined;
            if (result && result.success !== false) recovered++;
            else failed++;
          } catch (err) {
            failed++;
            logger.warn("Recompress: mem::compress failed", {
              sessionId: session.id,
              observationId: obs.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      if (attempted > 0) {
        await recordAudit(kv, "compress", "mem::recompress", explicitSessionId ? [explicitSessionId] : [], {
          attempted,
          recovered,
          failed,
          limit,
        }).catch(() => undefined);
      }

      logger.info("Recompress complete", {
        attempted,
        recovered,
        failed,
        sessionsScanned: sessions.length,
      });
      return {
        success: true,
        sessionsScanned: sessions.length,
        attempted,
        recovered,
        failed,
        limitReached,
        hint: limitReached
          ? `Limit of ${limit} reached; call again to continue draining.`
          : undefined,
      };
    },
  );
}
