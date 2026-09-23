import type { ISdk } from "../iii.js";
import type {
  CompressedObservation,
  SessionSummary,
  SummaryChunkPartial,
  SummaryPartialCache,
  MemoryProvider,
  Session,
} from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import {
  SUMMARY_SYSTEM,
  buildSummaryPrompt,
  REDUCE_SYSTEM,
  buildReducePrompt,
} from "../prompts/summary.js";
import { getXmlTag, getXmlChildren } from "../prompts/xml.js";
import { SummaryOutputSchema } from "../eval/schemas.js";
import { validateOutput } from "../eval/validator.js";
import { scoreSummary } from "../eval/quality.js";
import type { MetricsStore } from "../eval/metrics-store.js";
import { safeAudit } from "./audit.js";
import { logger } from "../logger.js";

// Per-chunk observation budget when a session is too large to fit in one
// LLM call. Default ≈ 50k input tokens per chunk at ~110 tok/obs — fits
// comfortably in 128k-window models. Override via SUMMARIZE_CHUNK_SIZE.
const CHUNK_SIZE_DEFAULT = 400;
// Concurrent in-flight chunk calls. 6 keeps a 100-chunk session under
// iii's 180s function-invocation timeout at ~8s/call while staying
// inside generous-but-not-unlimited provider rate limits (well below
// OpenAI free tier's 500 RPM). High-throughput providers
// (Novita / DeepInfra / DeepSeek) typically allow 100+ concurrent — set
// SUMMARIZE_CHUNK_CONCURRENCY higher to cover ~1000+ chunk sessions.
const CHUNK_CONCURRENCY_DEFAULT = 6;
// Bail on the merged summary if more than this fraction of chunks fail
// to parse — a half-blind narrative is worse than a clean error.
const MAX_SKIP_RATIO = 0.5;
// R2: minimum uncovered observations before a refresh rewrites the stored
// summary. Per-turn Stop events otherwise re-summarize a growing session for
// a handful of new observations, paying cost proportional to session size.
const MIN_NEW_OBSERVATIONS_DEFAULT = 10;

function getMinNewObservations(): number {
  const raw = process.env.SUMMARIZE_MIN_NEW_OBSERVATIONS;
  if (!raw) return MIN_NEW_OBSERVATIONS_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : MIN_NEW_OBSERVATIONS_DEFAULT;
}

function getChunkSize(): number {
  const raw = process.env.SUMMARIZE_CHUNK_SIZE;
  if (!raw) return CHUNK_SIZE_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : CHUNK_SIZE_DEFAULT;
}

function getChunkConcurrency(): number {
  const raw = process.env.SUMMARIZE_CHUNK_CONCURRENCY;
  if (!raw) return CHUNK_CONCURRENCY_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : CHUNK_CONCURRENCY_DEFAULT;
}

type ReducePartialInput = {
  title: string;
  narrative: string;
  keyDecisions: string[];
  filesModified: string[];
  concepts: string[];
  obsRangeStart: number;
  obsRangeEnd: number;
};

type ProduceSummaryResult = {
  response: string;
  mode: "single" | "chunked" | "incremental";
  chunks: number;
  skipped?: number;
  partialConcepts?: string[];
  chunkSize: number;
  entries: SummaryChunkPartial[];
  coveredCount: number;
};

// R7: the cache is derived state — anything unrecognized or inconsistent with
// the current observation list discards it and forces a full recompute. A
// boundary mismatch means observations were deleted or reordered, so every
// range after the shift is untrustworthy; reject the whole record rather than
// silently reusing prefix entries.
function validatePartialCache(
  cache: SummaryPartialCache | null | undefined,
  compressed: CompressedObservation[],
  chunkSize: number,
  sessionId: string,
): SummaryChunkPartial[] | null {
  if (!cache || typeof cache !== "object") return null;
  if (cache.sessionId !== sessionId) return null;
  if (cache.chunkSize !== chunkSize) return null;
  if (!Number.isInteger(cache.coveredCount) || cache.coveredCount <= 0) {
    return null;
  }
  if (cache.coveredCount > compressed.length) return null;
  if (!Array.isArray(cache.chunks) || cache.chunks.length === 0) return null;
  let expectedStart = 1;
  for (const entry of cache.chunks) {
    if (!entry || typeof entry !== "object") return null;
    if (entry.rangeStart !== expectedStart) return null;
    if (!Number.isInteger(entry.rangeEnd) || entry.rangeEnd < entry.rangeStart) {
      return null;
    }
    if (entry.rangeEnd > cache.coveredCount) return null;
    if (!entry.partial || typeof entry.partial !== "object") return null;
    const boundary = compressed[entry.rangeEnd - 1];
    if (!boundary || boundary.id !== entry.boundaryObservationId) return null;
    expectedStart = entry.rangeEnd + 1;
  }
  if (cache.coveredCount !== expectedStart - 1) return null;
  return cache.chunks;
}

function toReduceInput(
  summary: SessionSummary,
  obsRangeStart: number,
  obsRangeEnd: number,
): ReducePartialInput {
  return {
    title: summary.title,
    narrative: summary.narrative,
    keyDecisions: summary.keyDecisions ?? [],
    filesModified: summary.filesModified ?? [],
    concepts: dedupeConcepts(summary.concepts ?? []),
    obsRangeStart,
    obsRangeEnd,
  };
}

// One chunk call with retry-once. Returns null when both attempts fail —
// whether by parse failure, provider 4xx (content rejected by upstream
// filters), or transient network/5xx errors that didn't recover on retry.
// All failure modes are equivalent at this layer: the chunk is unusable,
// skip it and let the caller decide via the skip-ratio bailout whether
// the overall summary is still trustworthy. Errors that affect every
// chunk (auth, model down) will trip the bailout naturally.
async function summarizeChunkWithRetry(
  provider: MemoryProvider,
  chunk: CompressedObservation[],
  sessionId: string,
  project: string,
  idx: number,
  total: number,
): Promise<SessionSummary | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const xml = await provider.summarize(
        SUMMARY_SYSTEM,
        buildSummaryPrompt(chunk),
      );
      const parsed = parseSummaryXml(xml, sessionId, project, chunk.length);
      if (parsed) return parsed;
      logger.warn("Summarize chunk parse failed", {
        sessionId,
        chunk: `${idx + 1}/${total}`,
        attempt,
      });
    } catch (err) {
      logger.warn("Summarize chunk LLM call failed", {
        sessionId,
        chunk: `${idx + 1}/${total}`,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return null;
}

// Returns the final summary XML string. Sessions with a valid partial cache
// reuse every covered chunk and send only the uncovered tail to the LLM, then
// fold the prior stored summary with the new partials (KTD2). Sessions with no
// reusable derived state take the legacy paths: one call when the session fits
// in a chunk, otherwise a parallel map-reduce over all chunks.
async function produceSummaryXml(
  provider: MemoryProvider,
  compressed: CompressedObservation[],
  sessionId: string,
  project: string,
  priorSummary: SessionSummary | null,
  partialCache: SummaryPartialCache | null | undefined,
): Promise<ProduceSummaryResult> {
  const chunkSize = getChunkSize();
  const validated = priorSummary
    ? validatePartialCache(partialCache, compressed, chunkSize, sessionId)
    : null;
  const reuseCount =
    validated && validated.length > 0
      ? validated[validated.length - 1].rangeEnd
      : 0;
  const canReuse = reuseCount > 0 && reuseCount < compressed.length;

  if (!canReuse && compressed.length <= chunkSize) {
    const response = await provider.summarize(
      SUMMARY_SYSTEM,
      buildSummaryPrompt(compressed),
    );
    return {
      response,
      mode: "single",
      chunks: 1,
      chunkSize,
      entries: [],
      coveredCount: 0,
    };
  }

  const reusedChunks = canReuse ? validated! : [];
  const tailStart = canReuse ? reuseCount : 0;
  const chunkRanges: Array<{ start: number; end: number }> = [];
  for (let i = tailStart; i < compressed.length; i += chunkSize) {
    chunkRanges.push({
      start: i + 1,
      end: Math.min(i + chunkSize, compressed.length),
    });
  }
  const concurrency = getChunkConcurrency();
  logger.info(
    canReuse
      ? "Summarize reusing chunk partials"
      : "Summarize chunking session",
    {
      sessionId,
      chunks: chunkRanges.length,
      chunkSize,
      concurrency,
      totalObservations: compressed.length,
      reusedChunks: reusedChunks.length,
      coveredCount: tailStart,
    },
  );

  // Sparse array preserves chunk → index mapping after parallel resolution,
  // so the reduce step sees partials in chronological order even when some
  // were skipped.
  const partialByIdx: Array<SessionSummary | null> = new Array(
    chunkRanges.length,
  ).fill(null);
  for (
    let batchStart = 0;
    batchStart < chunkRanges.length;
    batchStart += concurrency
  ) {
    const batch = chunkRanges.slice(batchStart, batchStart + concurrency);
    await Promise.all(
      batch.map(async (range, j) => {
        const idx = batchStart + j;
        partialByIdx[idx] = await summarizeChunkWithRetry(
          provider,
          compressed.slice(range.start - 1, range.end),
          sessionId,
          project,
          idx,
          chunkRanges.length,
        );
      }),
    );
  }

  const skipped = partialByIdx.filter((p) => p === null).length;

  if (skipped > Math.floor(chunkRanges.length * MAX_SKIP_RATIO)) {
    throw new Error(
      `too_many_chunks_skipped: ${skipped}/${chunkRanges.length} chunks failed to parse after retry`,
    );
  }
  if (skipped > 0) {
    logger.warn("Summarize chunks partially skipped", {
      sessionId,
      skipped,
      total: chunkRanges.length,
    });
  }

  // Truncate the cache at the first skipped chunk: without a partial for that
  // range, later ranges cannot be marked covered without leaving a gap.
  const newEntries: SummaryChunkPartial[] = [];
  for (let idx = 0; idx < chunkRanges.length; idx++) {
    const partial = partialByIdx[idx];
    if (!partial) break;
    const range = chunkRanges[idx];
    newEntries.push({
      rangeStart: range.start,
      rangeEnd: range.end,
      boundaryObservationId: compressed[range.end - 1].id,
      partial,
    });
  }
  const coveredCount =
    newEntries.length > 0
      ? newEntries[newEntries.length - 1].rangeEnd
      : tailStart;

  // KTD2: fold the previous stored summary with only the new tail partials so
  // per-refresh reduce input stays bounded by the tail, not the session size.
  const reduceInputs: ReducePartialInput[] = [];
  if (canReuse && priorSummary) {
    reduceInputs.push(toReduceInput(priorSummary, 1, reuseCount));
  }
  for (let idx = 0; idx < chunkRanges.length; idx++) {
    const partial = partialByIdx[idx];
    if (!partial) continue;
    const range = chunkRanges[idx];
    reduceInputs.push(toReduceInput(partial, range.start, range.end));
  }

  // #1114: dedupe the union of concepts across the fold inputs and keep it as
  // a fallback for a reduce pass that emits an empty <concepts> block.
  const partialConcepts = dedupeConcepts(
    reduceInputs.flatMap((p) => p.concepts),
  );
  const response = await provider.summarize(
    REDUCE_SYSTEM,
    buildReducePrompt(reduceInputs),
  );
  return {
    response,
    mode: canReuse ? "incremental" : "chunked",
    chunks: chunkRanges.length,
    skipped,
    partialConcepts,
    chunkSize,
    entries: [...reusedChunks, ...newEntries],
    coveredCount,
  };
}

function dedupeConcepts(concepts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const concept of concepts) {
    const trimmed = concept.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

// #783: many LLMs (DeepSeek, GPT variants, some Anthropic responses)
// wrap structured XML in markdown code fences or add conversational
// text before/after. Strip those wrappers before the tag regex so a
// well-formed summary doesn't get silently dropped as parse_failed.
function stripXmlWrappers(raw: string): string {
  if (!raw) return "";
  let cleaned = raw.trim();
  // ```xml ... ``` or ``` ... ``` fences (anywhere in the payload).
  cleaned = cleaned.replace(/```\s*xml\s*\n?/gi, "");
  cleaned = cleaned.replace(/```/g, "");
  cleaned = cleaned.trim();
  // If preamble / postamble surrounds the XML root, peel it off.
  const rootMatch = cleaned.match(
    /(<[a-zA-Z_][a-zA-Z0-9_-]*>[\s\S]*<\/[a-zA-Z_][a-zA-Z0-9_-]*>)/,
  );
  if (rootMatch && rootMatch[1]) return rootMatch[1].trim();
  return cleaned;
}

function parseSummaryXml(
  xml: string,
  sessionId: string,
  project: string,
  obsCount: number,
): SessionSummary | null {
  const cleaned = stripXmlWrappers(xml);
  const title = getXmlTag(cleaned, "title");
  if (!title) return null;

  return {
    sessionId,
    project,
    createdAt: new Date().toISOString(),
    title,
    narrative: getXmlTag(cleaned, "narrative"),
    keyDecisions: getXmlChildren(cleaned, "decisions", "decision"),
    filesModified: getXmlChildren(cleaned, "files", "file"),
    concepts: getXmlChildren(cleaned, "concepts", "concept"),
    observationCount: obsCount,
  };
}

export function registerSummarizeFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
  metricsStore?: MetricsStore,
): void {
  sdk.registerFunction(
    "mem::summarize",
    async (data: { sessionId: string; force?: boolean } | undefined) => {
      const startMs = Date.now();
      if (!data || typeof data.sessionId !== "string" || !data.sessionId.trim()) {
        return { success: false, error: "sessionId is required" };
      }
      const sessionId = data.sessionId.trim();

      // KTD6: duplicate Stop events for one session arrive concurrently. The
      // lock makes read → summarize → write atomic so the second caller sees
      // the first caller's stored summary and skips, instead of double-running
      // the provider or interleaving partial-cache writes.
      return withKeyedLock(`summarize:${sessionId}`, async () => {
        const session = await kv.get<Session>(KV.sessions, sessionId);
        if (!session) {
          logger.warn("Session not found for summarize", {
            sessionId,
          });
          return { success: false, error: "session_not_found" };
        }

        const observations = await kv.list<CompressedObservation>(
          KV.observations(sessionId),
        );
        const compressed = observations.filter((o) => o.title);

        if (compressed.length === 0) {
          logger.info("No observations to summarize", {
            sessionId,
          });
          return { success: false, error: "no_observations" };
        }

        const force = data.force === true;
        const existing = await kv
          .get<SessionSummary>(KV.summaries, sessionId)
          .catch(() => null);

        // #1244: session stop fires on every turn, so the same session was
        // re-summarised hundreds of times (954x on one reported session) for
        // no new material. Skip when a summary already covers the current
        // observation count; `force: true` re-runs on demand.
        if (!force) {
          if (
            existing &&
            typeof existing.title === "string" &&
            existing.title.length > 0 &&
            (existing.observationCount ?? 0) >= compressed.length
          ) {
            logger.info("Summarize skipped — summary already covers session", {
              sessionId,
              summarizedObservations: existing.observationCount,
              currentObservations: compressed.length,
            });
            return {
              success: true,
              skipped: "already_summarized",
              summary: existing,
            };
          }
        }

        // createProvider() wraps every base provider ("resilient(noop)"), so
        // an exact name match never fires; match by substring as graph.ts does.
        if (provider.name.includes("noop")) {
          logger.info("Summarize skipped — no LLM provider configured", {
            sessionId,
          });
          return {
            success: false,
            error: "no_provider",
            reason:
              "No LLM provider key set; Summarize is a no-op. Set ANTHROPIC_API_KEY (or GEMINI/OPENROUTER/MINIMAX) in ~/.agentmemory/.env to enable.",
          };
        }

        const priorSummary =
          existing &&
          typeof existing.title === "string" &&
          existing.title.length > 0
            ? existing
            : null;

        // R2: refresh floor. A refresh only replaces the stored summary once
        // the uncovered tail reaches the configured minimum, so per-turn Stop
        // events don't re-summarize the whole session for a few observations.
        // `force: true` bypasses the floor; the already-covered skip above
        // still wins at floor 0. A session whose row is `completed` bypasses
        // the floor so the final tail is summarized: a host that re-arms a
        // session per turn pays one bounded tail call per end rather than a
        // full re-summarization.
        const minNewObservations = getMinNewObservations();
        const uncoveredCount =
          compressed.length - (priorSummary?.observationCount ?? 0);
        if (
          !force &&
          priorSummary &&
          session.status !== "completed" &&
          uncoveredCount < minNewObservations
        ) {
          logger.info("Summarize skipped — below refresh floor", {
            sessionId,
            summarizedObservations: priorSummary.observationCount,
            currentObservations: compressed.length,
            minNewObservations,
          });
          return {
            success: true,
            skipped: "below_refresh_floor",
            summary: priorSummary,
          };
        }

        // R7: a forced refresh recomputes everything and never reuses the
        // derived cache.
        const partialCache = force
          ? null
          : await kv
              .get<SummaryPartialCache>(KV.summaryPartials, sessionId)
              .catch(() => null);

        try {
          // #783: chunk-level produceSummaryXml retries internally, but
          // the final merge used to parse once and bail. Wrap the
          // produce-and-parse pair in the same 2-attempt loop so a
          // markdown-wrapped or otherwise wrapped response gets a
          // second roll-of-the-dice instead of dropping the summary.
          let summary: SessionSummary | null = null;
          let response = "";
          let mode: "single" | "chunked" | "incremental" = "single";
          let chunks = 1;
          let partialConcepts: string[] = [];
          let producedEntries: SummaryChunkPartial[] = [];
          let producedCoveredCount = 0;
          let producedChunkSize = 0;
          for (let attempt = 1; attempt <= 2; attempt++) {
            const produced = await produceSummaryXml(
              provider,
              compressed,
              sessionId,
              session.project,
              priorSummary,
              partialCache,
            );
            response = produced.response;
            mode = produced.mode;
            chunks = produced.chunks;
            partialConcepts = produced.partialConcepts ?? [];
            producedEntries = produced.entries;
            producedCoveredCount = produced.coveredCount;
            producedChunkSize = produced.chunkSize;
            if (!response || !response.trim()) {
              logger.warn("Empty provider response on summarize", {
                sessionId,
                provider: provider.name,
                mode,
                chunks,
                observationCount: compressed.length,
                attempt,
              });
              continue;
            }
            summary = parseSummaryXml(
              response,
              sessionId,
              session.project,
              compressed.length,
            );
            if (summary) {
              // #1114: keep the union of chunk concepts so a reduce pass that
              // emitted an empty <concepts> block (or dropped some) cannot
              // erase them, and duplicates never reach the stored summary.
              summary.concepts = dedupeConcepts([
                ...summary.concepts,
                ...partialConcepts,
              ]);
              // #1240: a schema failure (e.g. narrative under the length floor)
              // used to end the call after one attempt, so the retry loop never
              // saw it. Validate inside the loop and let attempt 2 fix it.
              const candidate = {
                title: summary.title,
                narrative: summary.narrative,
                keyDecisions: summary.keyDecisions,
                filesModified: summary.filesModified,
                concepts: summary.concepts,
              };
              const attemptValidation = validateOutput(
                SummaryOutputSchema,
                candidate,
                "mem::summarize",
              );
              if (attemptValidation.valid) break;
              logger.warn("Summary validation failed", {
                sessionId,
                attempt,
                errors: attemptValidation.result.errors,
              });
              summary = null;
              continue;
            }
            logger.warn("Failed to parse summary XML", { sessionId, attempt });
          }

          if (!response || !response.trim()) {
            const latencyMs = Date.now() - startMs;
            if (metricsStore) {
              await metricsStore.record("mem::summarize", latencyMs, false);
            }
            return { success: false, error: "empty_provider_response" };
          }

          if (!summary) {
            const latencyMs = Date.now() - startMs;
            if (metricsStore) {
              await metricsStore.record("mem::summarize", latencyMs, false);
            }
            return { success: false, error: "parse_failed" };
          }

          const summaryForValidation = {
            title: summary.title,
            narrative: summary.narrative,
            keyDecisions: summary.keyDecisions,
            filesModified: summary.filesModified,
            concepts: summary.concepts,
          };
          const validation = validateOutput(
            SummaryOutputSchema,
            summaryForValidation,
            "mem::summarize",
          );

          if (!validation.valid) {
            const latencyMs = Date.now() - startMs;
            if (metricsStore) {
              await metricsStore.record("mem::summarize", latencyMs, false);
            }
            logger.warn("Summary validation failed", {
              sessionId,
              errors: validation.result.errors,
            });
            return { success: false, error: "validation_failed" };
          }

          const qualityScore = scoreSummary(summaryForValidation);

          // R3: the stored summary is replaced only after a fully validated
          // refresh; the derived partial cache follows it. Any failure above
          // leaves both the prior summary and the prior cache untouched.
          await kv.set(KV.summaries, sessionId, summary);

          const cacheEntries: SummaryChunkPartial[] =
            mode === "single"
              ? [
                  {
                    rangeStart: 1,
                    rangeEnd: compressed.length,
                    boundaryObservationId:
                      compressed[compressed.length - 1].id,
                    partial: summary,
                  },
                ]
              : producedEntries;
          const cacheCovered =
            mode === "single" ? compressed.length : producedCoveredCount;
          if (cacheEntries.length > 0) {
            const partialsRecord: SummaryPartialCache = {
              sessionId,
              chunkSize: producedChunkSize,
              coveredCount: cacheCovered,
              chunks: cacheEntries,
              updatedAt: new Date().toISOString(),
            };
            await kv.set(KV.summaryPartials, sessionId, partialsRecord);
          } else {
            // No contiguous prefix could be cached (an early chunk was
            // skipped); drop any stale record rather than let it claim
            // coverage the new summary does not match.
            await kv.delete(KV.summaryPartials, sessionId);
          }

          await safeAudit(kv, "compress", "mem::summarize", [sessionId], {
            title: summary.title,
            observationCount: compressed.length,
          });

          const latencyMs = Date.now() - startMs;
          if (metricsStore) {
            await metricsStore.record(
              "mem::summarize",
              latencyMs,
              true,
              qualityScore,
            );
          }

          logger.info("Session summarized", {
            sessionId,
            title: summary.title,
            decisions: summary.keyDecisions.length,
            qualityScore,
            valid: validation.valid,
          });

          return { success: true, summary, qualityScore };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const latencyMs = Date.now() - startMs;
          if (metricsStore) {
            await metricsStore.record("mem::summarize", latencyMs, false);
          }
          logger.error("Summarize failed", {
            sessionId,
            error: msg,
          });
          return { success: false, error: msg };
        }
      });
    },
  );
}
