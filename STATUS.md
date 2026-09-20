# agentmemory — work status

Last updated: 2026-09-20 · branch `fix/major-bugs` (fork: `neriamosgionata/agentmemory`, pushed)

## Engine / runtime

- Native engine pin: **iii v0.24.0**, run through the `iii compose` worker model.
- Docker path: still **v0.22.1** (legacy `iii-config.docker.yaml`; 0.23+ rejects it).
- SDK: `iii-sdk@0.24.0` (single import surface `src/iii.ts`).
- Private binary: `~/.agentmemory/bin/iii` is **0.24.0** (0.11.2 backup: `iii-0.11.2.bak`).
- PATH `iii`: user-managed **0.23.0**, untouched.

## Run it

```bash
# native, instance 9 example; foreground supervisor by design
node dist/cli.mjs --instance 9 --data-dir /tmp/am
# background + poll from another shell (do not wait on the launcher)
setsid --fork sh -c 'node dist/cli.mjs --data-dir ~/.agentmemory/data > /tmp/am.log 2>&1 < /dev/null'
curl -s localhost:3111/agentmemory/livez
```

Compose mode is automatic for engine >= 0.23, or force with `AGENTMEMORY_III_COMPOSE=true`.
Generated per instance: `worker-compose.yaml` + `compose.env` in the data dir.

## Verification (all green)

- `npm test`: **1954 passed / 1 skipped**.
- `npm run build`: clean.
- Live on 0.24.0 compose: livez ~5 s, `remember` + `search` return data, state store lands in the configured data dir.
- Engine 0.22.1-era bugs verified fixed by the upgrade: CJK/multibyte ingest (#969), REST routes after engine-only restart (#1013), RSS/shutdown (#1312).

## Fixed in this branch (summary)

Top-8 blockers, plus ~80 issues total across three drain rounds. Highlights:

- Index durability: rebuild/save interlock, vector-coverage rebuild gate, live-write save scheduling, evict index sync (#1372/#1335).
- Oversized payloads: leaf-walking byte measure, export 413, graph view snapshot ceiling (#1124/#1142/#1334).
- XML extraction anchored, validator-rejected responses no longer committed (#1271/#1240 partial).
- Governance delete works on observations (#1273); recompress recovery endpoint (#1228).
- Embedding dimension auto-detect (#1373); `mem::summarize` skips unchanged sessions (#1244).
- PreToolUse hook envelope + 8 s budget (#1278); hooks/MCP shim load `~/.agentmemory/.env` (#1331).
- `graph/build` resumable (#1339); `mem::patterns` bounded (#1226); async vector scan (#195).
- Viewer reload storm, memory totals, object summaries (#1340/#1279/#1229); health heap + CPU fixes (#1223/#1235).
- OpenClaw: typed `before_prompt_build` hook, project basename, agentId, session close (#1161/#1058/#596).
- MCP response bounds (#1360), export pagination (#1142), agentId plumbing (#1159/#1197), circuit breaker (#1276), CLIP text tower (#1249).

## Caveats / remaining

- `agentmemory.service` (user systemd) is **stopped**; it runs old installed code and will fail against 0.24. Repoint `ExecStart` at `node /home/amos-neri/Projects/agentmemory/dist/cli.mjs` or leave stopped.
- Docker/deploy templates need their own compose-model pass.
- Open: #1240 `response_format` wire change; #1377 (not reproducible); #1124 legacy graph with no snapshot degrades but cannot be enumerated safely.
- CLI foreground behavior: in compose mode the launcher stays attached to `iii compose`; background launches look "stuck" in wrappers that wait for process exit — the server is up within seconds.

## Key files

- `src/iii.ts` — SDK 0.24 import surface.
- `src/cli/compose-config.ts` — `worker-compose.yaml` + compose env generation.
- `src/cli.ts` — engine pin, compose mode detection/launch.
- `src/state/index-persistence.ts`, `src/functions/search.ts` — index durability.
- `test/compose-config.test.ts` — compose schema/versions regression.
