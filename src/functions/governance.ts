import type { ISdk } from "../iii.js";
import type {
  Memory,
  GovernanceFilter,
  AuditEntry,
  CompressedObservation,
} from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { recordAudit, safeAudit, queryAudit } from "./audit.js";
import { deleteAccessLog } from "./access-tracker.js";
import { clearSessionDerivedState } from "./observation-lifecycle.js";
import { getSearchIndex, vectorIndexRemove, flushIndexSave } from "./search.js";
import { logger } from "../logger.js";

const BULK_FILTER_KEYS = ["type", "dateFrom", "dateTo", "project", "qualityBelow"];
const BULK_CONTROL_KEYS = ["dryRun", "reason"];

type DeleteFailure = { id: string; error: string };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function deleteMemoryRecord(
  kv: StateKV,
  id: string,
): Promise<"deleted" | "missing"> {
  const mem = await kv.get<Memory>(KV.memories, id);
  if (!mem) return "missing";
  await kv.delete(KV.memories, id);
  await deleteAccessLog(kv, id);
  getSearchIndex().remove(id);
  vectorIndexRemove(id);
  return "deleted";
}

export function registerGovernanceFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::governance-delete", 
    async (data: {
      memoryIds: string[];
      reason?: string;
      sessionId?: string;
    }) => {
      if (
        !data.memoryIds ||
        !Array.isArray(data.memoryIds) ||
        data.memoryIds.length === 0
      ) {
        return { success: false, error: "memoryIds array is required" };
      }

      const deletedIds: string[] = [];
      const notFound: string[] = [];
      const failures: DeleteFailure[] = [];
      let deletedObservations = 0;
      const deletedObsSessions = new Set<string>();
      const index = getSearchIndex();
      for (const id of data.memoryIds) {
        try {
          if ((await deleteMemoryRecord(kv, id)) === "deleted") {
            deletedIds.push(id);
            continue;
          }
        } catch (err) {
          logger.warn("Governance delete failed", {
            memoryId: id,
            error: errorMessage(err),
          });
          failures.push({ id, error: "delete_failed" });
          continue;
        }

        // #1273: captured observations live in mem:obs:<sessionId>, so a
        // governance call with only an observation id used to delete
        // nothing. Resolve the owning session from an explicit param or the
        // BM25 entry, then delete the row and both index entries.
        const sessionId = data.sessionId ?? index.getSessionId(id);
        if (!sessionId) {
          notFound.push(id);
          continue;
        }
        const obs = await kv.get<CompressedObservation>(
          KV.observations(sessionId),
          id,
        );
        if (!obs) {
          notFound.push(id);
          continue;
        }
        await kv.delete(KV.observations(sessionId), id);
        await deleteAccessLog(kv, id);
        index.remove(id);
        vectorIndexRemove(id);
        deletedObsSessions.add(sessionId);
        deletedObservations++;
      }

      for (const sessionId of deletedObsSessions) {
        await clearSessionDerivedState(kv, sessionId);
      }

      const deleted = deletedIds.length;
      if (deleted + deletedObservations > 0) await flushIndexSave();

      if (deleted + deletedObservations > 0 || failures.length > 0) {
        await recordAudit(
          kv,
          "delete",
          "mem::governance-delete",
          deletedIds,
          {
            reason: data.reason || "manual deletion",
            deleted,
            deletedObservations,
            requested: data.memoryIds.length,
            notFound: notFound.length,
            failed: failures.length,
            failures: failures.length > 0 ? failures : undefined,
          },
        );
      }

      logger.info("Governance delete", {
        requested: data.memoryIds.length,
        deleted,
        deletedObservations,
        notFound: notFound.length,
        failed: failures.length,
      });
      return {
        success: failures.length === 0,
        deleted,
        deletedObservations,
        total: data.memoryIds.length,
        notFound,
        failed: failures.length,
        failures: failures.length > 0 ? failures : undefined,
      };
    },
  );

  sdk.registerFunction("mem::governance-bulk",
    async (input: GovernanceFilter & { dryRun?: boolean; reason?: string }) => {
      const data = input ?? {};
      const unsupported = Object.keys(data).filter(
        (key) => !BULK_FILTER_KEYS.includes(key) && !BULK_CONTROL_KEYS.includes(key),
      );
      if (unsupported.length > 0) {
        return {
          success: false,
          error: `Unsupported bulk delete filter: ${unsupported.join(", ")}. Supported filters: ${BULK_FILTER_KEYS.join(", ")}`,
        };
      }
      if (
        data.project !== undefined &&
        (typeof data.project !== "string" || data.project.trim().length === 0)
      ) {
        return { success: false, error: "project must be a non-empty string" };
      }

      const hasFilter =
        (data.type && data.type.length > 0) ||
        data.dateFrom ||
        data.dateTo ||
        (typeof data.project === "string" && data.project.length > 0) ||
        data.qualityBelow !== undefined;
      if (!hasFilter) {
        return {
          success: false,
          error: `At least one filter is required for bulk delete (${BULK_FILTER_KEYS.join(", ")})`,
        };
      }

      const memories = await kv.list<Memory>(KV.memories);
      let candidates = memories;

      if (data.type && data.type.length > 0) {
        candidates = candidates.filter((m) => data.type!.includes(m.type));
      }
      if (data.dateFrom) {
        const from = new Date(data.dateFrom).getTime();
        if (Number.isNaN(from)) {
          return { success: false, error: "Invalid dateFrom format" };
        }
        candidates = candidates.filter(
          (m) => new Date(m.createdAt).getTime() >= from,
        );
      }
      if (data.dateTo) {
        const to = new Date(data.dateTo).getTime();
        if (Number.isNaN(to)) {
          return { success: false, error: "Invalid dateTo format" };
        }
        candidates = candidates.filter(
          (m) => new Date(m.createdAt).getTime() <= to,
        );
      }
      if (typeof data.project === "string" && data.project.length > 0) {
        candidates = candidates.filter((m) => m.project === data.project);
      }
      if (data.qualityBelow !== undefined) {
        candidates = candidates.filter((m) => m.strength < data.qualityBelow!);
      }

      if (data.dryRun) {
        return {
          success: true,
          dryRun: true,
          wouldDelete: candidates.length,
          ids: candidates.map((m) => m.id),
        };
      }

      const BATCH_SIZE = 50;
      const successfulIds: string[] = [];
      const notFound: string[] = [];
      const failures: DeleteFailure[] = [];
      for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
        const batch = candidates.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map((mem) => deleteMemoryRecord(kv, mem.id)),
        );
        results.forEach((result, j) => {
          const mem = batch[j];
          if (result.status === "rejected") {
            logger.warn("Governance bulk delete failed", {
              memoryId: mem.id,
              error: errorMessage(result.reason),
            });
            failures.push({ id: mem.id, error: "delete_failed" });
          } else if (result.value === "deleted") {
            successfulIds.push(mem.id);
          } else {
            notFound.push(mem.id);
          }
        });
      }

      if (successfulIds.length > 0) await flushIndexSave();

      if (successfulIds.length > 0 || failures.length > 0) {
        await safeAudit(
          kv,
          "delete",
          "mem::governance-bulk",
          successfulIds,
          {
            filter: data,
            deleted: successfulIds.length,
            notFound: notFound.length,
            failed: failures.length,
            failures: failures.length > 0 ? failures : undefined,
          },
        );
      }

      logger.info("Governance bulk delete", {
        deleted: successfulIds.length,
        notFound: notFound.length,
        failed: failures.length,
      });
      return {
        success: failures.length === 0,
        deleted: successfulIds.length,
        notFound,
        failed: failures.length,
        failures: failures.length > 0 ? failures : undefined,
      };
    },
  );

  sdk.registerFunction("mem::audit-query",
    async (data?: {
      operation?: AuditEntry["operation"];
      dateFrom?: string;
      dateTo?: string;
      limit?: number;
    }) => {
      return queryAudit(kv, data);
    },
  );
}
