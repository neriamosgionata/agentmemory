import { TriggerAction, type ISdk } from "../iii.js";
import type {
  CompressedObservation,
  GraphExtractionWatermark,
  HookPayload,
  Session,
} from "../types.js";
import { KV, STREAM } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { isReflectEnabled } from "../functions/slots.js";
import {
  getAgentId,
  getConsolidationCooldownMs,
  getGraphBatchSize,
  isConsolidationEnabled,
  isGraphExtractionEnabled,
} from "../config.js";
import { logger } from "../logger.js";

// Global marker recording when corpus consolidation last ran, used to debounce
// the per-turn session-stop fan-out.
const CONSOLIDATION_MARKER_KEY = "consolidation:lastRun";

async function consolidationDueUnserialized(kv: StateKV): Promise<boolean> {
  const cooldownMs = getConsolidationCooldownMs();
  if (cooldownMs <= 0) return true; // debounce disabled
  const now = Date.now();
  const marker = await kv
    .get<{ at?: number }>(KV.config, CONSOLIDATION_MARKER_KEY)
    .catch(() => null);
  const lastAt = typeof marker?.at === "number" ? marker.at : 0;
  if (now - lastAt < cooldownMs) return false;
  await kv.set(KV.config, CONSOLIDATION_MARKER_KEY, { at: now }).catch(() => {});
  return true;
}

// Concurrent session-stop events would otherwise interleave the marker
// read-check-write above and both pass the cooldown. Serialize the whole
// check through an in-process chain so exactly one concurrent caller wins.
let consolidationCheckChain: Promise<unknown> = Promise.resolve();

function consolidationDue(kv: StateKV): Promise<boolean> {
  const result = consolidationCheckChain.then(() =>
    consolidationDueUnserialized(kv),
  );
  consolidationCheckChain = result.catch(() => false);
  return result;
}

// R4/R5: session-stop graph extraction is tail-only and resumable. The
// per-session watermark counts the compressed observations already fed to
// mem::graph-extract; each stop processes only what lies past it, in
// batches. The watermark advances only after a batch reports success with a
// healthy LLM leg (success:true AND not llmFailed), so a failed or partial
// batch is retried on the next stop instead of being skipped. The wall-clock
// budget and consecutive-failure cap mirror api::graph-build's drain: a slow
// or flapping provider stops the loop instead of holding the stop lifecycle
// open.
const GRAPH_EXTRACT_BUDGET_MS = 60_000;
const GRAPH_EXTRACT_MAX_FAILURES = 3;
const GRAPH_EXTRACT_MAX_BATCH = 100;

async function extractGraphSessionTail(
  sdk: ISdk,
  kv: StateKV,
  sessionId: string,
): Promise<void> {
  await withKeyedLock(`graph-extract:${sessionId}`, async () => {
    const observations = await kv.list<CompressedObservation>(
      KV.observations(sessionId),
    );
    const compressed = observations.filter((o) => o.title);
    if (compressed.length === 0) return;

    const watermark = await kv
      .get<GraphExtractionWatermark>(KV.graphExtractionWatermarks, sessionId)
      .catch(() => null);
    let start = Math.max(
      0,
      Math.min(watermark?.extractedCount ?? 0, compressed.length),
    );
    // Re-anchor if the observation list shifted under the recorded count.
    const boundary = watermark?.boundaryObservationId;
    if (boundary && start > 0 && compressed[start - 1]?.id !== boundary) {
      const anchor = compressed.findIndex((o) => o.id === boundary);
      start = anchor >= 0 ? anchor + 1 : 0;
    }
    if (start >= compressed.length) return;

    const batchSize = Math.max(
      1,
      Math.min(GRAPH_EXTRACT_MAX_BATCH, getGraphBatchSize()),
    );
    const startedAt = Date.now();
    for (let i = start; i < compressed.length; ) {
      const batch = compressed.slice(i, i + batchSize);
      let consecutiveFailures = 0;
      for (;;) {
        if (Date.now() - startedAt > GRAPH_EXTRACT_BUDGET_MS) {
          logger.warn("session-stop graph-extract budget exceeded", {
            sessionId,
            batchStart: i,
            remaining: compressed.length - i,
          });
          return;
        }
        let result:
          | { success?: boolean; llmFailed?: boolean; error?: string }
          | undefined;
        let invocationError: string | undefined;
        try {
          result = (await sdk.trigger({
            function_id: "mem::graph-extract",
            payload: { observations: batch },
          })) as typeof result;
        } catch (err) {
          invocationError = err instanceof Error ? err.message : String(err);
        }
        if (result?.success === true && result.llmFailed !== true) {
          const last = batch[batch.length - 1];
          if (last) {
            await kv.set(KV.graphExtractionWatermarks, sessionId, {
              sessionId,
              extractedCount: i + batch.length,
              boundaryObservationId: last.id,
              updatedAt: new Date().toISOString(),
            } satisfies GraphExtractionWatermark);
          }
          break;
        }
        consecutiveFailures += 1;
        logger.warn("session-stop graph-extract batch failed", {
          sessionId,
          batchStart: i,
          attempt: consecutiveFailures,
          maxAttempts: GRAPH_EXTRACT_MAX_FAILURES,
          llmFailed: result?.llmFailed === true,
          error: invocationError ?? result?.error,
        });
        if (consecutiveFailures >= GRAPH_EXTRACT_MAX_FAILURES) return;
      }
      i += batch.length;
    }
  });
}

export function registerEventTriggers(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "event::session::started",
    async (data: {
      sessionId: string;
      project: string;
      cwd: string;
      agentId?: string;
    }) => {
      const requestAgentId =
        typeof data.agentId === "string" && data.agentId.trim().length > 0
          ? data.agentId.trim().slice(0, 128)
          : undefined;
      const agentId = requestAgentId ?? getAgentId();
      const session: Session = {
        id: data.sessionId,
        project: data.project,
        cwd: data.cwd,
        startedAt: new Date().toISOString(),
        status: "active",
        observationCount: 0,
        ...(agentId ? { agentId } : {}),
      };
      await kv.set(KV.sessions, data.sessionId, session);
      const contextResult = await sdk.trigger<
        { sessionId: string; project: string; agentId?: string },
        { context: string }
      >({
        function_id: "mem::context",
        payload: {
          sessionId: data.sessionId,
          project: data.project,
          ...(agentId ? { agentId } : {}),
        },
      });
      return { session, context: contextResult.context };
    },
  );
  sdk.registerTrigger({
    type: "durable:subscriber",
    function_id: "event::session::started",
    config: { topic: "agentmemory.session.started" },
  });

  sdk.registerFunction("event::observation", async (data: HookPayload) =>
    sdk.trigger({ function_id: "mem::observe", payload: data }),
  );
  sdk.registerTrigger({
    type: "durable:subscriber",
    function_id: "event::observation",
    config: { topic: "agentmemory.observation" },
  });

  sdk.registerFunction("event::session::stopped", async (data: { sessionId: string; skipConsolidation?: boolean }) => {
    const summary = await sdk.trigger({ function_id: "mem::summarize", payload: data });
    const fireVoid = (function_id: string, payload: unknown) =>
      sdk
        .trigger({ function_id, payload, action: TriggerAction.Void() })
        .catch((err) =>
          logger.warn(function_id + " trigger failed", {
            sessionId: data.sessionId,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
    if (isReflectEnabled()) {
      fireVoid("mem::slot-reflect", { sessionId: data.sessionId });
    }
    // #1238: GRAPH_EXTRACTION_ENABLED=false is the master switch for graph
    // writes. The structural (heuristic) pass used to run regardless, so the
    // graph kept growing on session stop even with the flag off. Explicit
    // calls to mem::graph-extract / api::graph-extract still work for
    // operators who want a one-off import.
    if (isGraphExtractionEnabled()) {
      try {
        await extractGraphSessionTail(sdk, kv, data.sessionId);
      } catch (err) {
        logger.warn("graph-extract trigger failed", {
          sessionId: data.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Crystals + lessons consolidation. The stop lifecycle is the single
    // source of truth: event::session::stopped fires for ALL agents (the
    // client-side session-end hook no longer drives consolidation directly).
    // Gated so keyless/zero-LLM users don't fire no-op LLM calls.
    //
    // skipConsolidation suppresses the fan-out when this handler is driven
    // by eviction's stale-session recovery: evict calls session::stopped
    // once per recovered session, then runs ONE final consolidation pass.
    // Without this guard, N recovered sessions launch N concurrent forced
    // full-corpus consolidations plus N crystallizations.
    //
    // Debounce: /session/end is posted by the per-turn Stop hook, so this
    // handler fires on every agent turn. consolidate-pipeline + auto-crystallize
    // are full-corpus LLM work with no internal "nothing changed" guard, so
    // firing them every turn is a cost/latency storm for connected agents.
    // Bound the global corpus consolidation to once per cooldown window.
    if (isConsolidationEnabled() && !data.skipConsolidation) {
      if (await consolidationDue(kv)) {
        fireVoid("mem::consolidate-pipeline", { tier: "all", force: true });
        fireVoid("mem::auto-crystallize", { olderThanDays: 0 });
      }
    }
    return summary;
  });
  sdk.registerTrigger({
    type: "durable:subscriber",
    function_id: "event::session::stopped",
    config: { topic: "agentmemory.session.stopped" },
  });

  sdk.registerFunction(
    "event::session::ended",
    async (data: { sessionId: string }) => {
      await kv.update(KV.sessions, data.sessionId, [
        { type: "set", path: "endedAt", value: new Date().toISOString() },
        { type: "set", path: "status", value: "completed" },
      ]);
      return { success: true };
    },
  );
  sdk.registerTrigger({
    type: "durable:subscriber",
    function_id: "event::session::ended",
    config: { topic: "agentmemory.session.ended" },
  });

  // React to observation count changes and emit a lightweight live event for dashboards/viewer.
  sdk.registerFunction(
    "event::session::observation-count-changed",
    async (payload: {
      key: string;
      event_type: string;
      old_value?: Session;
      new_value?: Session;
    }) => {
      if (payload.event_type === "delete") return { skipped: true };
      const oldCount = payload.old_value?.observationCount ?? 0;
      const newCount = payload.new_value?.observationCount ?? 0;
      if (newCount <= oldCount) return { skipped: true };

      await sdk.trigger({
        function_id: "stream::send",
        payload: {
          stream_name: STREAM.name,
          group_id: STREAM.viewerGroup,
          id: `session-activity-${payload.key}-${Date.now()}`,
          type: "session.activity",
          data: {
            sessionId: payload.key,
            observationCount: newCount,
            delta: newCount - oldCount,
            updatedAt: payload.new_value?.updatedAt ?? new Date().toISOString(),
          },
        },
        action: TriggerAction.Void(),
      });

      return { emitted: true };
    },
  );
  sdk.registerTrigger({
    type: "state",
    function_id: "event::session::observation-count-changed",
    config: { scope: KV.sessions },
  });
}
