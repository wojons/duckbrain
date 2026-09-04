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
  MCP forget). Load this
  before integrating DuckBrain into anything or answering "does DuckBrain work?".
version: 1.5.0
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
| CLI | `node bin/duckbrain.js <cmd>` | remember, recall, search, search-index, query, token, list-keys, forget (⚠ broken outside the 'default' ns — see pitfall #14), namespace(s), squash, embeddings, status, s3 |
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
  content, key, and attributes. Requires the index: `duckbrain
  search-index rebuild` first. Hits print a **highlighted snippet**
  (`highlightedSnippet`), not just the raw row. `--limit=<n>` (default 10).
- **`duckbrain search --all-namespaces "<query>"`** (RETR-007) — union of
  keyword hits over every namespace with a rebuilt index; each hit shows its
  source namespace. Namespaces without an index are **skipped with a stderr
  warning** (single-namespace mode keeps the hard error — run
  `search-index rebuild` for them).
- **`duckbrain search-index <rebuild|status|install-hooks>`** — manage the
  keyword index.
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
  as of a git ref or ISO date.
- **`duckbrain recall --attr=<name>=<value>`** (repeatable) — filter rows by
  attribute, e.g. `--attr=domain=config --attr=tick=403`.

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
    `eduos.dexdat.com.co`). An agent omitting `?namespace=` on HTTP reads/
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
14. **CLI `forget` is broken outside the 'default' namespace (DOGFOOD-0904-01,
    open as of 09-04):** `duckbrain forget <id> --namespace=<ns>` hardcodes
    `namespace:"default"` internally (src/cli/human.ts:636) — the flag is
    never parsed, and usage text doesn't document it. Every non-default
    namespace errors with `Namespace 'default' not found`. Use the MCP
    `forget` tool (`{"id":"<uuid>","namespace":"<ns>"}` — verified working)
    or the REST route until the fix lands.
15. **Fresh clones of `main` crash on first boot (DOGFOOD-0904-02, open as of
    09-04):** `Cannot find module 'express'` after a clean `pnpm install` —
    express is a phantom dep (present only transitively in the lockfile).
    Dev checkouts with an older node_modules work. If booting a fresh clone,
    `pnpm add express@5.2.1` unblocks (one-liner fix tracked on the board).

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
