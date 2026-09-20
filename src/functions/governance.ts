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
import { getSearchIndex, vectorIndexRemove, flushIndexSave } from "./search.js";
import { logger } from "../logger.js";

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

      let deleted = 0;
      let deletedObservations = 0;
      const notFound: string[] = [];
      const index = getSearchIndex();
      for (const id of data.memoryIds) {
        const mem = await kv.get<Memory>(KV.memories, id);
        if (mem) {
          await kv.delete(KV.memories, id);
          await deleteAccessLog(kv, id);
          index.remove(id);
          vectorIndexRemove(id);
          deleted++;
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
        deletedObservations++;
      }

      if (deleted + deletedObservations > 0) await flushIndexSave();

      await recordAudit(
        kv,
        "delete",
        "mem::governance-delete",
        data.memoryIds,
        {
          reason: data.reason || "manual deletion",
          deleted,
          deletedObservations,
          notFound: notFound.length > 0 ? notFound : undefined,
        },
      );

      logger.info("Governance delete", {
        requested: data.memoryIds.length,
        deleted,
        deletedObservations,
        notFound: notFound.length,
      });
      return {
        success: true,
        deleted,
        deletedObservations,
        total: data.memoryIds.length,
        notFound: notFound.length > 0 ? notFound : undefined,
      };
    },
  );

  sdk.registerFunction("mem::governance-bulk", 
    async (data: GovernanceFilter & { dryRun?: boolean }) => {

      const hasFilter =
        (data.type && data.type.length > 0) ||
        data.dateFrom ||
        data.dateTo ||
        data.qualityBelow !== undefined;
      if (!hasFilter && !data.dryRun) {
        return {
          success: false,
          error: "At least one filter is required for non-dryRun bulk delete",
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
      const failures: Array<{ id: string; error: string }> = [];
      for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
        const batch = candidates.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map(async (mem) => {
            await kv.delete(KV.memories, mem.id);
            await deleteAccessLog(kv, mem.id);
            getSearchIndex().remove(mem.id);
            vectorIndexRemove(mem.id);
          }),
        );
        results.forEach((result, j) => {
          const mem = batch[j];
          if (result.status === "fulfilled") {
            successfulIds.push(mem.id);
          } else {
            logger.warn("Governance bulk delete failed", {
              memoryId: mem.id,
              error:
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason),
            });
            failures.push({
              id: mem.id,
              error: "delete_failed",
            });
          }
        });
      }

      if (successfulIds.length > 0) await flushIndexSave();

      await safeAudit(
        kv,
        "delete",
        "mem::governance-bulk",
        successfulIds,
        {
          filter: data,
          deleted: successfulIds.length,
          failed: failures.length,
          failures: failures.length > 0 ? failures : undefined,
        },
      );

      logger.info("Governance bulk delete", {
        deleted: successfulIds.length,
        failed: failures.length,
      });
      return {
        success: failures.length === 0,
        deleted: successfulIds.length,
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
