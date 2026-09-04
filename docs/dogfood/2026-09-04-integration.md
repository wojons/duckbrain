# DuckBrain Dogfood Integration — 2026-09-04 (cron pick `duckbrain-pm`)

**Run type:** verification dogfood. The 2026-08-26 run filed DOGFOOD-025..031; all seven
were closed **complete** by the foreman. This run re-used the system for real and
independently re-verified each fix as a checker (the builder is biased to call it good).

- **Workdir:** `/home/kara/duckbrain` (branch `feat/native-s3`; picker workdir
  `~/.hermes/stand-in/pm/duckbrain` is an EMPTY registration stub — see findings)
- **Scratch environment:** daemon `:3777`, isolated via `DUCKBRAIN_NAMESPACES_PATH`,
  `DUCKBRAIN_CONFIG_PATH` (scratch config, dead-embedder variant for one leg),
  `--auth-file=/tmp/…/auth.json`. Production `~/.duckbrain/auth.json` checksummed
  before/after the token test — byte-identical.
- **Install leg:** ephemeral bunker agent on las-bunker-03 (destroyed after).

## Promise vs reality

> "AI agents get persistent, queryable, version-controlled memory — MCP server
> (stdio/HTTP), REST API, CLI, Web UI; JSONL + DuckDB + vector search + git history;
> optional native S3 tier; hardened deployments behind `--auth=apikey`."

**Reality: the engine delivers.** Every 08-26 P1 fix held up under independent
re-verification, and the system degraded gracefully under a dead embedding provider.
But the run found one fresh P1 bug (CLI forget), one install blocker on `main`
(phantom express dep — fresh users cannot even boot the server), and the picker
registration for `duckbrain-pm` points at an empty directory.

## Verified-fixed (regression checks that PASSED)

| Task | What was fixed | How verified this run |
|---|---|---|
| DOGFOOD-025 | MCP remember stamps token author, not host git | MCP `remember` via `:3777` → recall shows `author: dogfood-top@duckbrain.local` (the token name) |
| DOGFOOD-026 | `duckbrain token` honors `DUCKBRAIN_AUTH_FILE`/`--auth-file` | token minted into scratch store (visible in its `apiKeys`); prod `~/.duckbrain/auth.json` sha256 unchanged |
| DOGFOOD-027 | `recall --namespace <ns>` space-form parsing | `node bin/duckbrain.js recall --namespace dogfood-0904 --prefix=/mcp/` → `Validated input: { namespace: 'dogfood-0904' }`, 2 memories |
| DOGFOOD-029 | `search --all-namespaces` skips unindexed ns | code shipped (commit cd6e9c5); not re-driven live this run (low risk, P3) |
| DOGFOOD-030 | `s3 status` endpoint resolution | code shipped (4f001c1); not re-driven live this run (P3) |
| DOGFOOD-031 | SQL `memories` view applies validity | wrote expired (`valid_until` yesterday) + future (`valid_from` Dec) rows → REST current view hid both, `query` returned 0 rows, `recall --historical` showed the expired row |
| GAP-030 | `/health` returns 503 when degraded | pointed scratch config embedding at dead `127.0.0.1:9999` → restarted → `/health` = **HTTP 503**, `status:degraded`, writes still 201 |

## New findings → board

- **DOGFOOD-0904-01 (P1)** — CLI `forget` hardcodes `namespace:"default"`
  (`src/cli/human.ts:636`) and never parses `--namespace`; fails with
  `Namespace 'default' not found` for every other namespace. MCP forget works.
- **DOGFOOD-0904-02 (P1)** — **INSTALL BLOCKER on `main`**: fresh clone + clean
  `pnpm install --frozen-lockfile` (32s, no errors) → `node bin/duckbrain.js http`
  crashes: `Cannot find module 'express'`. express is only a transitive dep in the
  lockfile (via `express-rate-limit`); pnpm's isolated layout hides it from app code.
  Dev boxes work off stale root-level `node_modules/express`. Bunker-proven fix:
  declare `express` in dependencies (one line) + add a boot-from-clean-install smoke test.
- **DOGFOOD-0904-03 (P2)** — README quickstart assumes node ≥ 22 + pnpm exist; a bare
  machine has neither (measured: nvm+node22 ≈ 11s, corepack pnpm instant). Also no
  copy-paste smoke sequence to prove install worked.
- **(infra note, not a repo task)** — scheduler project `duckbrain-pm` has
  `workdir=~/.hermes/stand-in/pm/duckbrain`, which is EMPTY (created 08-31, never
  populated, ticked 09-01/04 by the pm-standin). Real repo is `~/duckbrain`. Fix the
  registration (point workdir/repo at the real repo) or delete the row.

## Working end-to-end session (scratch daemon, placeholder values)

```bash
mkdir -p /tmp/dbx/{data,home,config} && cp duckbrain.config.json /tmp/dbx/config/
# edit /tmp/dbx/config/duckbrain.config.json: namespacesPath=/tmp/dbx/data/namespaces
printf '{"users":[],"apiKeys":[{"key":"SCRATCH-TOKEN","name":"me","namespaces":["try"]}]} ' \
  > /tmp/dbx/home/auth.json   # real file must be valid JSON

DUCKBRAIN_NAMESPACES_PATH=/tmp/dbx/data/namespaces \
DUCKBRAIN_CONFIG_PATH=/tmp/dbx/config/duckbrain.config.json \
  node bin/duckbrain.js http --port 3777 --auth=apikey --auth-file=/tmp/dbx/home/auth.json &

curl -s http://127.0.0.1:3777/health                       # 200 healthy (503 = degraded)
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3777/api/memories   # 401 without key
curl -s -X POST http://127.0.0.1:3777/api/namespaces -H 'Content-Type: application/json' \
  -H 'X-API-Key: SCRATCH-TOKEN' -d '{"name":"try"}'        # 201 — this git-inits the ns
curl -s -X POST "http://127.0.0.1:3777/api/memories?namespace=try" \
  -H 'Content-Type: application/json' -H 'X-API-Key: SCRATCH-TOKEN' \
  -d '{"key":"/demo/one","domain":"concept","content":"hello memory","attributes":{}}'  # 201
curl -s "http://127.0.0.1:3777/api/memories?namespace=try&q=hello" \
  -H 'X-API-Key: SCRATCH-TOKEN'                            # 200, items[].score present
```

MCP-over-HTTP remember (required shape — the two classic 422s are missing `domain`
and missing `attributes`):

```bash
curl -s -X POST http://127.0.0.1:3777/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'X-API-Key: SCRATCH-TOKEN' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"remember",
       "arguments":{"namespace":"try","key":"/mcp/x","domain":"raw_note",
                    "embedding_text":"via mcp","attributes":{}}}}'
```

## Degraded-mode behavior (verified live — this is the right way to think about it)

With ALL embedding providers dead (scratch config pointed at `127.0.0.1:9999`):

- `/health` → **503**, `status:degraded` (GAP-030 contract).
- Writes stay **201** (JSONL path, no embedding needed).
- Semantic `?q=` **still returns results** — RETR-002 hybrid fusion silently falls
  back to the keyword/BM25 leg. `score` values come from keyword ranking, not
  cosine similarity. Not a bug: a resilience feature. Just don't interpret scores
  across a provider outage as comparable to normal ones.
- Recovery is host-side: load/pull the embedding model, or fix
  `DUCKBRAIN_EMBEDDING_API_KEY`, then watch `/health` return to 200.

## Timing summary (fresh machine, las-bunker-03 bunker agent)

| Step | Time | Result |
|---|---|---|
| nvm + node 22 | 11s | OK (undocumented prerequisite) |
| `pnpm install --frozen-lockfile` (main @ ce936ae) | 32s | OK |
| `node bin/duckbrain.js http` | — | **CRASH: Cannot find module 'express'** |
| after `pnpm add express@5.2.1` (diagnosis in bunker only) | +3s | `/health` 200; ns create 201; write 201; read-back OK |

**Time-to-first-success (this host, real use):** ~4 min from scratch daemon start to
first semantic-scored recall. **Friction count this run:** 3 new (forget bug, express
phantom dep, quickstart prereqs) + 1 infra registration stub.

## Verdict

🟡 **PROMISING-BUT-ROUGH** (same label as 08-26, different reasons — the engine's
rough edges from 08-26 are fixed; what's rough now is the fresh-user path).
For the fleet running from the dev checkout: **works, trustworthy, use it**.
For a brand-new user cloning `main`: **blocked at first boot** (DOGFOOD-0904-02).
