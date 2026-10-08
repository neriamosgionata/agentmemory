import type { ProjectSessionIndexEntry, Session } from "../types.js";
import { KV } from "./schema.js";
import { StateKV } from "./kv.js";
import { withKeyedLock } from "./keyed-mutex.js";
import { logger } from "../logger.js";

const PROJECT_SESSION_INDEX_CAP = 50;
const MIN_ENTRIES_PER_AGENT = 10;
const REBUILD_WRITE_CONCURRENCY = 8;

type RebuildChanges = {
  added: Map<string, ProjectSessionIndexEntry>;
  removed: Set<string>;
};

const activeRebuilds = new Set<Map<string, RebuildChanges>>();

function recordRebuildChange(
  project: string,
  apply: (changes: RebuildChanges) => void,
): void {
  for (const rebuild of activeRebuilds) {
    let changes = rebuild.get(project);
    if (!changes) {
      changes = { added: new Map(), removed: new Set() };
      rebuild.set(project, changes);
    }
    apply(changes);
  }
}

function toIndexEntry(s: Session): ProjectSessionIndexEntry {
  return {
    id: s.id,
    startedAt: s.startedAt,
    ...(s.agentId ? { agentId: s.agentId } : {}),
  };
}

function capWithAgentFairness(
  entries: ProjectSessionIndexEntry[],
): ProjectSessionIndexEntry[] {
  const decorated = entries.map((entry) => ({
    entry,
    t: Date.parse(entry.startedAt),
  }));
  decorated.sort((a, b) => b.t - a.t);
  if (decorated.length <= PROJECT_SESSION_INDEX_CAP) {
    return decorated.map(({ entry }) => entry);
  }

  const perAgentSeen = new Map<string, number>();
  const kept: typeof decorated = [];
  const overflow: typeof decorated = [];
  for (const item of decorated) {
    if (kept.length >= PROJECT_SESSION_INDEX_CAP) {
      overflow.push(item);
      continue;
    }
    const agentKey = item.entry.agentId ?? "";
    const seen = perAgentSeen.get(agentKey) ?? 0;
    if (seen < MIN_ENTRIES_PER_AGENT) {
      kept.push(item);
      perAgentSeen.set(agentKey, seen + 1);
    } else {
      overflow.push(item);
    }
  }

  const remainingSlots = PROJECT_SESSION_INDEX_CAP - kept.length;
  if (remainingSlots > 0) kept.push(...overflow.slice(0, remainingSlots));
  kept.sort((a, b) => b.t - a.t);
  return kept.map(({ entry }) => entry);
}

async function loadStoredProjectSessionEntries(
  kv: StateKV,
  project: string,
): Promise<ProjectSessionIndexEntry[]> {
  const sessions = await kv.list<Session>(KV.sessions);
  return sessions
    .filter((s) => s.project === project)
    .map((s) => toIndexEntry(s));
}

export async function getProjectSessionIndex(
  kv: StateKV,
  project: string,
): Promise<ProjectSessionIndexEntry[] | null> {
  return kv
    .get<ProjectSessionIndexEntry[]>(KV.projectSessionsIndex, project)
    .catch(() => null);
}

export async function addSessionToProjectIndex(
  kv: StateKV,
  project: string,
  entry: ProjectSessionIndexEntry,
): Promise<void> {
  await withKeyedLock(`project-session-index:${project}`, async () => {
    const existing = await getProjectSessionIndex(kv, project);
    const base = existing ?? (await loadStoredProjectSessionEntries(kv, project));
    const merged = base.filter((e) => e.id !== entry.id);
    merged.push(entry);
    recordRebuildChange(project, (changes) => {
      changes.removed.delete(entry.id);
      changes.added.set(entry.id, entry);
    });
    try {
      await kv.set(KV.projectSessionsIndex, project, capWithAgentFairness(merged));
    } catch (err) {
      await kv.delete(KV.projectSessionsIndex, project).catch(() => {});
      throw err;
    }
  });
}

export async function removeSessionFromProjectIndex(
  kv: StateKV,
  project: string,
  sessionId: string,
): Promise<void> {
  await withKeyedLock(`project-session-index:${project}`, async () => {
    recordRebuildChange(project, (changes) => {
      changes.added.delete(sessionId);
      changes.removed.add(sessionId);
    });
    const existing = await getProjectSessionIndex(kv, project);
    if (!existing) return;
    const next = existing.filter((e) => e.id !== sessionId);
    if (next.length === existing.length) return;
    await kv.set(KV.projectSessionsIndex, project, next);
  });
}

export function buildProjectSessionIndex(
  sessions: ProjectSessionIndexEntry[],
): ProjectSessionIndexEntry[] {
  return capWithAgentFairness(sessions);
}

export async function ensureProjectSessionIndex(
  kv: StateKV,
  project: string,
  fallbackSessions: ProjectSessionIndexEntry[],
): Promise<ProjectSessionIndexEntry[]> {
  return withKeyedLock(`project-session-index:${project}`, async () => {
    const existing = await getProjectSessionIndex(kv, project);
    if (existing !== null) return existing;
    const next = buildProjectSessionIndex(fallbackSessions);
    try {
      await kv.set(KV.projectSessionsIndex, project, next);
    } catch (err) {
      logger.warn("session index persist failed, returning unpersisted index", {
        project,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return next;
  });
}

export async function rebuildAllProjectSessionIndexes(
  kv: StateKV,
): Promise<{ projects: number; sessions: number }> {
  const changesSinceListing = new Map<string, RebuildChanges>();
  activeRebuilds.add(changesSinceListing);
  try {
    const sessions = await kv.list<Session>(KV.sessions);
    const byProject = new Map<string, ProjectSessionIndexEntry[]>();
    for (const session of sessions) {
      if (!session.project) continue;
      const entry = toIndexEntry(session);
      const bucket = byProject.get(session.project);
      if (bucket) bucket.push(entry);
      else byProject.set(session.project, [entry]);
    }
    let indexed = 0;
    const writes = [...byProject];
    for (let i = 0; i < writes.length; i += REBUILD_WRITE_CONCURRENCY) {
      const batch = writes.slice(i, i + REBUILD_WRITE_CONCURRENCY);
      await Promise.all(
        batch.map(([project, entries]) =>
          withKeyedLock(`project-session-index:${project}`, () => {
            const changes = changesSinceListing.get(project);
            const next = changes
              ? [
                  ...entries.filter(
                    (e) => !changes.removed.has(e.id) && !changes.added.has(e.id),
                  ),
                  ...changes.added.values(),
                ]
              : entries;
            const capped = buildProjectSessionIndex(next);
            indexed += capped.length;
            return kv.set(
              KV.projectSessionsIndex,
              project,
              capped,
            );
          })
        ));
      }
    return { projects: byProject.size, sessions: indexed };
  } finally {
    activeRebuilds.delete(changesSinceListing);
  }
}

const SESSION_INDEX_GENERATION_KEY = "session-index-generation";
const SESSION_INDEX_GENERATION = 1;

export async function rebuildSessionIndexIfStale(
  kv: StateKV,
): Promise<{ projects: number; sessions: number } | null> {
  return withKeyedLock("session-index-generation", async () => {
    const marker = await kv.get<number>(KV.config, SESSION_INDEX_GENERATION_KEY);
    if (marker === SESSION_INDEX_GENERATION) return null;
    const result = await rebuildAllProjectSessionIndexes(kv);
    await kv.set(KV.config, SESSION_INDEX_GENERATION_KEY, SESSION_INDEX_GENERATION);
    return result;
  });
}
