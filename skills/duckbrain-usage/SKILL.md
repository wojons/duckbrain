---
name: duckbrain-usage
description: >-
  How to USE DuckBrain — the git-backed agent memory system in this repo — as a
  real user: entry points, run commands, the working API/MCP/CLI recipes,
  and the pitfalls that will bite you (?q= semantic search is safe now but
  ranks with a 0.25 score floor, MCP remember needs embedding_text + attributes,
  forget takes a UUID, delete_namespace needs {name, confirm:true}, sticky
  active namespace — remember/recall echo it now, compaction stats/status
  still instance-blind, HTTP omitted-?namespace= means the literal 'default'
  namespace while the CLI defaults to config defaultNamespace, CLI `forget`
  hardcodes namespace 'default' so it fails for every other namespace — use
  MCP forget; as-of time travel verified on all three surfaces 2026-09-24 but
  ABSENT from the stale origin/main, whose server silently answers ?as_of=
  with current-state; Web UI is DOA on hardened deployments — hardcodes ns
  'default' + sends zero credentials, DF-0924-05). Load this
  before integrating DuckBrain into anything or answering "does DuckBrain work?".
version: 1.8.0
category: software-development
---

# DuckBrain Usage — for agents and integrators

DuckBrain gives AI agents persistent, queryable, version-controlled memory.
Append-only JSONL per namespace + DuckDB query layer + per-namespace git repos
+ optional embeddings (vector search). Interfaces: **MCP server (stdio/HTTP),
REST API, CLI, Web UI**.

## Entry points

| Surface | How to start | Notes |
|---|---|---|
| HTTP daemon | `node bin/duckbrain.js http --port 3000 --auth=apikey` | REST on `/api/*`, MCP on `POST /mcp`; `--unix-socket` also supported; auth REQUIRED on hardened deployments — every request sends `-H 'X-API-Key: <token>'` (401 without it); mint tokens with `duckbrain token --namespace=<ns>` |
| MCP stdio | `node bin/duckbrain.js stdio` | for Claude/Cursor-style clients |
| CLI | `node bin/duckbrain.js <cmd>` | remember, recall, search, search-index, query, token, list-keys, forget (⚠ broken outside the 'default' ns — see pitfall #14), namespace(s), squash, embeddings, status, s3, consolidate |
| Config | `duckbrain.config.json` | `defaultNamespace`, `namespaceMappings`, `embedding`, `gitBatching` |
| Env override | `DUCKBRAIN_NAMESPACES_PATH=/path` | point a scratch instance at isolated data (never touch real namespaces for tests) |
| Env override | `DUCKBRAIN_CONFIG_PATH=/path` | redirect the config FILE location (GAP-022); env overrides are never persisted back into the file |

## The right way (verified 2026-08-16/17)

```bash
# 1. CREATE the namespace first — this is what git-inits it (versioning!)
curl -X POST http://127.0.0.1:3000/api/namespaces -H 'Content-Type: application/json' -H 'X-API-Key: <token>' \
  -d '{"name":"my-project"}'

# 2. Write — domain MUST be one of: person|event|concept|message|config|raw_note
curl -X POST "http://127.0.0.1:3000/api/memories?namespace=my-project" \
  -H 'Content-Type: application/json' -H 'X-API-Key: <token>' \
  -d '{"key":"/projects/myapp/db","domain":"concept","content":"PostgreSQL + PgBouncer","attributes":{"confidence":"high"}}'

# 3. Read — exact key, prefix list, key tree, semantic search
curl -H 'X-API-Key: <token>' "http://127.0.0.1:3000/api/memories/key/projects/myapp/db?namespace=my-project"
curl -H 'X-API-Key: <token>' "http://127.0.0.1:3000/api/memories?namespace=my-project&prefix=/projects/&limit=50"
curl -H 'X-API-Key: <token>' "http://127.0.0.1:3000/api/keys?namespace=my-project"
curl -H 'X-API-Key: <token>' "http://127.0.0.1:3000/api/memories?namespace=my-project&q=postgres"   # semantic; items carry .score

# 4. MCP-over-HTTP — the Accept header is REQUIRED or tools/list returns empty
curl -X POST http://127.0.0.1:3000/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -H 'X-API-Key: <token>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# remember/recall via tools/call; remember REQUIRES "attributes": {} AND the
# content field is "embedding_text" (NOT "content") — see pitfall #1
```

## Authentication

Hardened deployments run the daemon with `--auth=apikey`; then EVERY request
above must carry `-H 'X-API-Key: <token>'` — omitting it returns **401**.
Credentials live in `~/.duckbrain/auth.json` as an `apiKeys` array of
`{key, name, namespaces?}` objects. Mint a scoped token with
`duckbrain token --namespace=<ns>[,<ns>...]`: when `namespaces` is present the
token may ONLY touch those namespaces (**403** otherwise); absent =
unrestricted. With `--auth=apikey` the API stamps the `author` of every memory
write from the token `name` (client-supplied `?author=` is ignored).
Authoritative reference: `docs/guide/configuration.md` (Authentication
Configuration).

**Auth-store override (DB-GAP-043, shipped 2026-08-25):** both `http` and
`token` accept `--auth-file=<path>` (env fallback `DUCKBRAIN_AUTH_FILE`).
The daemon reads users/apiKeys from that file instead of
`~/.duckbrain/auth.json`; `token` writes new tokens there. An explicit
auth-file that is missing or unparseable is a FATAL startup error — never a
silent fallback to the production store. Use this for every scratch/test
daemon so it can never clobber the real auth store (see "Testing your
changes safely").

MCP stdio (`node bin/duckbrain.js stdio`) works with any SDK client
(`@modelcontextprotocol/sdk`); a full working client session (create ns →
remember → recall → semantic recall → forget by UUID → delete ns with
`confirm: true`) is in `docs/dogfood/2026-08-16-integration.md`.

Full transcript, error table, and copy-paste recipes: `docs/dogfood/2026-08-07-integration.md`.

## RETR query surface (shipped 2026-08-18/19)

The CLI beyond remember/recall — verified against `--help` on 2026-08-26:

- **`duckbrain search "<query>"`** — offline full-text keyword search over
  content, key, and attributes. The index refreshes itself when it is missing
  or older than the newest write (bounded + single-flight, DB-GAP-047), so a
  read never needs a manual rebuild first. Hits print a **highlighted snippet**
  (`highlightedSnippet`), not just the raw row. `--limit=<n>` (default 10).
- **`duckbrain search --all-namespaces "<query>"`** (RETR-007) — union of
  keyword hits over every namespace with a rebuilt index; each hit shows its
  source namespace. Namespaces without an index are **skipped with a stderr
  warning** — the union never rebuilds them (only single-namespace reads
  auto-refresh), so run `search-index rebuild` to pull one into the union.
- **`duckbrain search-index <rebuild|status|install-hooks>`** — manage the
  keyword index. `rebuild` is the escape hatch for a namespace the bounded
  auto-build refuses (`DUCKBRAIN_SEARCH_AUTOBUILD_MAX_ROWS`, default 5000).
- **`duckbrain query "SELECT ..." [--namespace=<ns>] [--limit=<n>]`** — read-only
  SQL over a `memories` view (latest record per id, tombstones excluded;
  mutating statements rejected; results auto-capped at 1000 rows). Templates:
  `--template incidents-by-day|per-project-status|cost-series`. ⚠️ The view is
  the RAW latest-record-per-id store — **no validity window is applied**
  (expired `valid_until` / future `valid_from` rows ARE visible via SQL, where
  the recall layer and REST current view hide them). Validity filtering is a
  recall-layer feature; see `--historical` below.
- **`duckbrain token`** — `--name=<name>` (author identity), `--namespace=<ns>`
  grants, `--auth-file=<path>` override (DB-GAP-043).
- **`duckbrain recall --historical`** (RETR-011) — include ALL rows regardless
  of validity window. Default = current view only. Paired with
  `valid_from`/`valid_until` on writes: a memory written with a validity
  window is hidden from the current view before `valid_from` or after
  `valid_until`; `--historical` shows it. `--as-of=<ref>` reads the namespace
  as of a git ref or ISO date (see the as-of section below — verified
  end-to-end 2026-09-24).
- **`duckbrain recall --attr=<name>=<value>`** (repeatable) — filter rows by
  attribute, e.g. `--attr=domain=config --attr=tick=403`.

### As-of time travel (verified end-to-end 2026-09-24, all three surfaces)

Read the namespace state **at a git ref or instant** — ref forms: full/short
commit SHA, branch, tag, or ISO-8601 date/datetime (date-only = that day's
end-of-day UTC bound; datetime = second-level precision). Works on HTTP
(`?as_of=`), CLI (`recall --as-of=<ref>`; space form `--as-of <ref>` also
parses), and MCP (`recall` argument `asOf` — implemented and verified, but
un-raw-documented in docs/api/mcp-tools.md as of this date; DF-0924-03).

```bash
# HTTP — tag, short SHA, date all resolve
curl "http://127.0.0.1:3000/api/memories?namespace=<ns>&as_of=v1-point"
curl "http://127.0.0.1:3000/api/memories?namespace=<ns>&as_of=2026-09-24T10:04:41Z"
# CLI
node bin/duckbrain.js recall --namespace=<ns> --as-of=v1-point
# MCP-over-HTTP (works today)
tools/call recall {"namespace":"<ns>","asOf":"v1-point"}
```

Verified semantics (dogfood 2026-09-24, scratch daemon): commit/tag/branch/
date/instant all resolve correctly; instant precision is genuine (a probe
between two commits 20s apart returned exactly the pre-commit-2 state);
`as_of` before the first commit → clean 400 `No commit found at or before`;
unknown ref → clean 400; worktree untouched (true no-checkout); the
**forget-then-time-travel recovery** works: DELETE a memory, then
`as_of=<pre-forget commit>` returns the deleted row. `as_of` combined with
`q=`/`contains=` is rejected — currently with a 500 (DF-0924-04), treat any
5xx there as client error and fix your query. Cost: ~30ms warm as-of vs ~6ms
current on a small namespace — no reason to avoid it.

⚠️ **Availability warning (DF-0924-02):** as-of exists only on current HEAD —
origin/main is months stale and its server answers `?as_of=` with **200 +
current-state** (silently wrong) instead of an error. Verify your daemon has
`src/git/asof.ts` (or that `as_of=<date-before-first-commit>` returns 400)
before trusting any as-of answer.

## Namespace deletion lifecycle (shipped 2026-09-22, e3a9852 — verified live 2026-09-23)

Two DIFFERENT operations — never conflate them:

- **`duckbrain namespace delete-disk <ns> --force [--requested-by=<who>] [--reason=<why>]`**
  removes the LOCAL namespace (dir + config mapping + the per-ns S3 sync
  manifest `<namespaces>/.s3state/<ns>.json`) and STOPS scheduled pushes. S3
  objects are KEPT and retrievable (pull / git clone). Requires --force;
  refuses while a push is in flight (live sync lock or git-remote-s3 helper);
  active-namespace guard; writes one who/why JSONL line to
  `<namespaces>/.s3state/lifecycle.log`. Legacy alias:
  `namespace delete <ns> --force --purge` = same code path. NOTE: plain
  `namespace delete` now means DISK-ONLY — old scripts expecting purge
  semantics must move to `clear-s3`.
- **`duckbrain s3 clear <ns> --dry-run` / `--yes --requested-by=<who> --reason=<why>`**
  (also `duckbrain namespace clear-s3 <ns>`) DESTROYS the namespace's remote
  S3 objects. Never touches disk; dry-run lists what would go; refuses
  without --yes; audited.
- **`duckbrain s3 ghosts [--sweep --yes --requested-by=<who>]`** — detects
  manifests/mappings whose namespace dir is gone (ghost-push class); sweep
  prunes them, S3 untouched. (Known wart: sweep logs TWO audit lines.)

CAVEATS (live-proven 2026-09-23, rows DF-0923-01/02): the in-flight-push
guard and the lifecycle audit are CLI-only. REST
`DELETE /api/namespaces/:name` (body `{"confirm":true}`) and MCP
`delete_namespace {name, confirm:true}` use the shared core WITHOUT the push
guard and WITHOUT audit — avoid those two surfaces while a push may be in
flight; use the CLI delete-disk for operator deletions.

## Daily consolidation (`duckbrain consolidate`, CONSOLIDATE-001)

Cross-namespace daily pass — verified against `consolidate --help` and a
live dry run:

- **`duckbrain consolidate [--date=YYYY-MM-DD]`** — scans the target UTC
  day's JSONL deltas across every namespace under `namespaces/` (only the
  target month's partition is read per namespace), dedupes repeated content
  (content-hash of `embedding_text`), and prints per-namespace
  `rows | unique | duplicates` stats plus capped `HH:MM author: text`
  previews, then a digest block. `--date` defaults to **yesterday UTC**;
  an invalid day (`2026-02-30`) exits 1 with a usage line.
- **`--write-digest`** — POST the digest to the DuckBrain HTTP API as a
  memory in namespace `duckbrain` (key
  `/project/duckbrain/digest/<date>`, domain `config`). Requires
  `DUCKBRAIN_API_KEY` — and is ALSO triggered implicitly whenever
  `DUCKBRAIN_API_KEY` is set in the environment. Without it the command is
  read-only: the digest prints under a `# digest (dry-run — …)` line and
  nothing is written.
- **`--digest-content=FILE`** — use FILE's text as the digest content
  instead of the auto-built digest (the cron agent's summarized version).
- **`--help, -h`** — full usage. Environment: `DUCKBRAIN_API_KEY`
  (X-API-Key for the digest write), `DUCKBRAIN_API_URL` (default
  `http://127.0.0.1:3000`).

⚠ Running with `DUCKBRAIN_API_KEY` exported flips the command into write
mode even without `--write-digest` — unset it when you want a dry run.

Real dry run in this repo (empty store — 0 namespaces with deltas):

```bash
$ env -u DUCKBRAIN_API_KEY node bin/duckbrain.js consolidate
# duckbrain consolidate 2026-09-19 (UTC): 0 namespace(s) with deltas, 0 delta rows (0 unique, 0 duplicates)
# digest (dry-run — set DUCKBRAIN_API_KEY or pass --write-digest to post):
# duckbrain consolidate digest 2026-09-19 (UTC)
namespaces scanned: 0
total delta rows: 0 (0 unique, 0 duplicates)
```

## Realtime change feed (SUPA-5)

Subscribe to **committed** changes for one namespace via SSE — `GET
/api/ns/<ns>/changes`. A change appears only after its namespace git commit
lands (pending writes are never published), events are `duckbrain.change.v1`
with an opaque `dbch1.<…>` cursor (also the SSE `id`), and a
`duckbrain.ready.v1` frame (no `id`) opens every stream. Heartbeat comment
every 15 s. SSE-only in v1 — the legacy `/api/events/:namespace` route is a
different, unversioned contract with no resume; do not confuse them.

```bash
# 1. The namespace MUST already exist (404 otherwise) — create it if needed
#    (see "The right way" above), then subscribe:
curl -N "http://127.0.0.1:3000/api/ns/my-project/changes" -H 'X-API-Key: <token>'

# 2. Optional filters: tables (comma list, all readable tables if omitted),
#    ops (subset of insert,update,delete)
curl -N "http://127.0.0.1:3000/api/ns/my-project/changes?tables=memories&ops=insert,update" \
  -H 'X-API-Key: <token>'

# 3. Persist the last `id:` line verbatim, then RESUME strictly after it
#    (?cursor=… or the SSE-standard Last-Event-ID header — equivalent):
curl -N "http://127.0.0.1:3000/api/ns/my-project/changes?cursor=dbch1.<stored>" \
  -H 'X-API-Key: <token>'

# 4. Cursor expired (pruned / >7-day / >10k-event window) → HTTP 410
#    CHANGE_CURSOR_GONE. Reconnecting alone does NOT recover: resync =
#    reconnect WITHOUT a cursor (live-only from now) + fresh snapshot from
#    GET /api/memories?namespace=<ns> + reconcile by declared key.
```

Guarantees: committed-only, ordered within the namespace subscription,
**at-least-once** — dedupe by `cursor` (or `position.commit`+`ordinal`) and
apply rows idempotently; no exactly-once promise. A subscriber that stops
reading is overflow-disconnected alone (`duckbrain.overflow.v1` + last
cursor); a revoked grant ends the stream (`duckbrain.revoked.v1`). Full wire
schema, error table, and grammar: see
[Realtime Change Feed (SUPA-5)](../../docs/api/http-api.md#realtime-change-feed-supa-5).

## Pitfalls that WILL bite you (verified live 2026-08-16/17 against source + scratch daemon)

1. **MCP `remember` content field is `embedding_text`, NOT `content`**
   (REST uses `content` — same field, two names). Passing `content:` fails with
   `-32602 ... expected string, received undefined at embedding_text`.
   `attributes` is required (`{}` ok) — omitting it gives
   `-32602 expected record, received undefined at attributes`.
   `forget` takes the memory **UUID** (from recall), not the key —
   `{"id":"<uuid>","namespace":"..."}` tombstones the memory.
   `delete_namespace` takes **`name`** (not `namespace`) plus `confirm: true`
   and DOES delete files + git repo (DOGFOOD-004 fixed).
2. **REST `?q=` / MCP `query=` semantic search is SAFE now (DOGFOOD-010
   fixed)** — the old crash (`duckdb::InvalidInputException "Map keys must be
   unique."` → SIGABRT) is gone: reads use an explicit all-VARCHAR `read_json`
   schema + `ignore_errors`, so duplicate keys in real-world JSONL can no
   longer abort the daemon. A scratch-daemon `?q=` battery returned 200 /
   clean errors and never aborted. If `?q=` errors, the message is an
   embedding-provider problem (model unloaded / not pulled), not a crash.
3. **Semantic search RANKS with a score floor, it does not hard-filter
   (DOGFOOD-011 fixed):** results carry `score` (`items[].score` on REST,
   `score` per hit in MCP recall), and candidates below `DEFAULT_MIN_SCORE`
   (0.25, `>=` inclusive) are dropped; `DUCKBRAIN_SEARCH_MIN_SCORE` env
   overrides it, `0` disables filtering. With some embedding models (e.g.
   ollama nomic-embed-text) unrelated text can still score 0.36–0.38, so a
   garbage query can return hits on small namespaces — treat scores as the
   ranking signal, don't assume 0 hits for nonsense.
4. **Active namespace is sticky ACROSS processes.** A `switch_namespace` in one
   stdio session redirects later separate sessions' namespace-less writes —
   it persists `defaultNamespace` into `duckbrain.config.json`, so every
   later process resolves omitted-namespace calls to the switched namespace.
   **FIXED in DOGFOOD-017: remember/recall responses now echo the namespace
   actually used, and remember adds a `warning` when the write lands outside
   the `'default'` namespace.** Still ALWAYS pass `namespace` explicitly to
   every write/read if the destination matters — the echo is a guardrail,
   not a replacement for intent.
5. **`server_http_start` WORKS now (DOGFOOD-013 fixed)** — projectRoot is
   derived from the module path (bounded walk-up for `bin/duckbrain.js`)
   instead of `cwd/..`, and child stderr is captured and surfaced, so failures
   report the real error. Start HTTP daemons yourself anyway for
   production use; the tool is for on-demand scratch servers.
6. **`get_compaction_stats` always returns zeros** in any configured deployment
   (DOGFOOD-014, open) — it hardcodes the legacy `cwd/.duckbrain/namespaces/default`
   instead of the active namespace. Don't trust its numbers.
7. **`server_status` is instance-blind (DOGFOOD-015, open)** — it reports the
   default port 3000 + a shared pidfile path, so a scratch-config process
   describes the LIVE daemon. Not "my instance" status.
8. **Semantic recall on a cold cache is slow/fragile** — first query embeds up
   to 50 candidates on the fly (LM Studio timeout aborts at ~10s when the model
   is cold). Run `duckbrain embeddings rebuild --namespace=<ns>` first; warm
   semantic recall then takes ~1.5–4s and returns `score` per hit. DOGFOOD-002
   fix verified: failures now surface as `isError=true` / HTTP 500 with detail
   (provider fallback: auto tries lmstudio → ollama → … on embed failure).
9. **CLI `remember --content=` WORKS now** (DOGFOOD-003 fixed): content is
   persisted as `embedding_text` and recalled correctly. `list-keys` prints a
   readable tree (DOGFOOD-009 fixed).
10. **Default namespace: HTTP and CLI resolve it DIFFERENTLY.** The CLI
    (`--namespace` omitted) uses `defaultNamespace` from the config — NOT
    `'default'`. The **HTTP API** (`?namespace=` omitted) uses the literal
    **`'default'`** namespace (README: "Namespace-scoped routes default to
    `default` when `?namespace=` is omitted") — regardless of config
    `defaultNamespace` (verified live 2026-08-26: no-ns `/api/memories`
    returned `default` data while config `defaultNamespace` was
    `my-project`). An agent omitting `?namespace=` on HTTP reads/
    writes the real `'default'` namespace while believing it uses the config
    default — ALWAYS pass `namespace` explicitly on HTTP.
11. **Domain enum** — `person|event|concept|message|config|raw_note` everywhere.
12. **Temp-file hygiene** — every daemon spawn/crash leaves
    `/tmp/duckbrain-<pid>-*.db` files (DOGFOOD-016, open); they accumulate.
    Harmless but untidy.
13. **All-embedding-providers-down degraded state (recurred 3+× Aug 21-23):**
    `/health` shows `embedding.healthy:false` for lmstudio ("No models
    loaded"), ollama ("model not in /api/tags"), openai ("missing
    DUCKBRAIN_EMBEDDING_API_KEY"). Writes + exact/prefix recall keep working
    (JSONL path); only VSS/semantic recall misses new entries. Recovery is
    HOST-side: `lms load` the configured model in LM Studio (it does not
    auto-reload after host reboot/daemon restart), `ollama pull <model>`, and
    export DUCKBRAIN_EMBEDDING_API_KEY before daemon start. Verify with
    `curl -s localhost:3000/health` until `healthy:true`.
    **GAP-030 (shipped, verified 09-04):** degraded `/health` now returns HTTP
    **503** (200 only when healthy), so code-level monitors can watch the
    status code. The probes are 30s-TTL cached — give a state change ~30s to
    show up. In the degraded window writes still 201 and semantic `?q=` still
    returns results (RETR-002 fusion falls back to the keyword/BM25 leg;
    those scores are keyword ranks, NOT cosine similarities — don't compare
    them to healthy-mode scores). Cold-boot race: for the first seconds
    `keys_error` can read `Namespace 'undefined' does not exist`, then
    self-clears; harmless but ugly.
14. **CLI `forget` outside 'default' namespaces — FIXED (verified live
    09-19):** the hardcoded `namespace:"default"` was replaced by
    `flags.namespace || getDefaultNamespace()` in `forgetCommand`
    (src/cli/human.ts); `duckbrain forget <id> --namespace=<ns>` now
    tombstones in the right namespace.
15. **Fresh clone boot (re-verified 09-19, DF-0919-01/02 open):** two breakers
    now stand between a fresh user and a running daemon. (a) On an empty
    store, `pnpm install --frozen-lockfile` RC=0 but leaves express (and ~30
    others) unlinked -> boot dies with `Cannot find module 'express'`;
    `pnpm add express@5.2.1` relinks and the daemon then boots. (b)
    `pnpm build` fails: `packages/ui/tsconfig.json:18` still has `baseUrl`,
    removed in TypeScript 7 (TS5102); the backend runs from src via tsx, so
    skip the UI build. Also README says pnpm 11+ but corepack installs 12.4.2,
    and bare `corepack enable pnpm` needs sudo — use
    `corepack enable pnpm --install-directory ~/.local/bin` (DF-0919-03).
    The daemon is otherwise fully functional fresh: quickstart passes, but
    expect `/health` 503 while lmstudio+ollama are healthy because the
    keyless openai provider counts as unhealthy (DF-0919-04).
16. **The Web UI cannot complete a real task as shipped (verified 09-24,
    DF-0924-05..08):** it hardcodes namespace `default` (ui-store.js:23),
    sends no credentials at all (api-client.js has no auth header and there
    is no token input), and every panel 404s/401s forever behind permanent
    "Loading..." skeletons. Do not demo the UI against an auth=apikey
    daemon or a non-default namespace — it will look broken because it is.
    The API underneath those panels works (verified same-run over REST).
17. **`--auth-file` does NOT enable auth by itself (DF-0924-07):** a daemon
    started with `--auth-file=<store>` but WITHOUT `--auth=apikey` accepts
    no-key and wrong-key requests with 200/201. The flag only relocates the
    store; enforcement requires `--auth=apikey`. Always pass both on scratch
    daemons that handle anything sensitive.
18. **GET /api/namespaces and /switch see only config namespaceMappings
    (DF-0924-06):** a namespace that exists on disk (created by direct
    writes) is invisible to the list and returns 404 from switch — while
    writes to the same name succeed. On a fresh install the list shows a
    phantom `default` with `directoryMissing:true`. Trust the write path's
    answer over the list.

## Testing your changes safely

```bash
mkdir -p /tmp/db-test /tmp/db-test-home && cp ~/.duckbrain/auth.json /tmp/db-test-home/ 2>/dev/null || true
# Scratch daemon with ISOLATED auth store (DB-GAP-043): --auth-file redirects
# the auth store, so the scratch daemon can NEVER clobber the production
# ~/.duckbrain/auth.json. The file must pre-exist with users/apiKeys.
DUCKBRAIN_NAMESPACES_PATH=/tmp/db-test node bin/duckbrain.js http --port 3999 \
  --auth=apikey --auth-file=/tmp/db-test-home/auth.json
# Mint tokens for the scratch daemon into its own store:
node bin/duckbrain.js token --name=scratch --namespace=dogfood-ns --auth-file=/tmp/db-test-home/auth.json
# Env alternative: DUCKBRAIN_AUTH_FILE=/tmp/db-test-home/auth.json (both http and token honor it).
# Then point every curl/CLI call at :3999 and /tmp/db-test (with -H 'X-API-Key: <token>' — auth is ON).
# Never write to the live :3000 daemon's
# namespaces — other fleet agents' memories live there (80+ namespaces in production use).
# ⚠️ ALWAYS also set DUCKBRAIN_CONFIG_PATH=/tmp/db-test-config.json (a copy of the repo config):
# create_namespace / namespace registration PERSISTS the mapping into the config file even when
# DUCKBRAIN_NAMESPACES_PATH redirects the data dir (GAP-007 class; proven tick #410 — scratch
# instance leaked a dogfood012 mapping into the repo duckbrain.config.json).
# For semantic-search work, point embeddings at a loaded model, e.g. copy the config to
# /tmp/db-test-config.json with embedding.provider=ollama / model=nomic-embed-text and add
# DUCKBRAIN_CONFIG_PATH=/tmp/db-test-config.json (DUCKBRAIN_NAMESPACES_PATH still isolates data).
```
