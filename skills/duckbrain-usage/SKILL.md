---
name: duckbrain-usage
description: >-
  How to USE DuckBrain — the git-backed agent memory system in this repo — as a
  real user: entry points, run commands, the working API/MCP/CLI recipes,
  and the pitfalls that will bite you (?q= semantic search is safe now but
  ranks with a 0.25 score floor, MCP remember needs embedding_text + attributes,
  forget takes a UUID, delete_namespace needs {name, confirm:true}, sticky
  active namespace, compaction stats/status still instance-blind). Load this
  before integrating DuckBrain into anything or answering "does DuckBrain work?".
version: 1.2.0
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
| HTTP daemon | `node bin/duckbrain.js http --port 3000` | REST on `/api/*`, MCP on `POST /mcp`; `--unix-socket` also supported |
| MCP stdio | `node bin/duckbrain.js stdio` | for Claude/Cursor-style clients |
| CLI | `node bin/duckbrain.js <cmd>` | remember, recall, list-keys, forget, namespace(s), squash, embeddings, status |
| Config | `duckbrain.config.json` | `defaultNamespace`, `namespaceMappings`, `embedding`, `gitBatching` |
| Env override | `DUCKBRAIN_NAMESPACES_PATH=/path` | point a scratch instance at isolated data (never touch real namespaces for tests) |
| Env override | `DUCKBRAIN_CONFIG_PATH=/path` | redirect the config FILE location (GAP-022); env overrides are never persisted back into the file |

## The right way (verified 2026-08-16/17)

```bash
# 1. CREATE the namespace first — this is what git-inits it (versioning!)
curl -X POST http://127.0.0.1:3000/api/namespaces -H 'Content-Type: application/json' \
  -d '{"name":"my-project"}'

# 2. Write — domain MUST be one of: person|event|concept|message|config|raw_note
curl -X POST "http://127.0.0.1:3000/api/memories?namespace=my-project" \
  -H 'Content-Type: application/json' \
  -d '{"key":"/projects/myapp/db","domain":"concept","content":"PostgreSQL + PgBouncer","attributes":{"confidence":"high"}}'

# 3. Read — exact key, prefix list, key tree, semantic search
curl "http://127.0.0.1:3000/api/memories/key/projects/myapp/db?namespace=my-project"
curl "http://127.0.0.1:3000/api/memories?namespace=my-project&prefix=/projects/&limit=50"
curl "http://127.0.0.1:3000/api/keys?namespace=my-project"
curl "http://127.0.0.1:3000/api/memories?namespace=my-project&q=postgres"   # semantic; items carry .score

# 4. MCP-over-HTTP — the Accept header is REQUIRED or tools/list returns empty
curl -X POST http://127.0.0.1:3000/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# remember/recall via tools/call; remember REQUIRES "attributes": {} AND the
# content field is "embedding_text" (NOT "content") — see pitfall #1
```

MCP stdio (`node bin/duckbrain.js stdio`) works with any SDK client
(`@modelcontextprotocol/sdk`); a full working client session (create ns →
remember → recall → semantic recall → forget by UUID → delete ns with
`confirm: true`) is in `docs/dogfood/2026-08-16-integration.md`.

Full transcript, error table, and copy-paste recipes: `docs/dogfood/2026-08-07-integration.md`.

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
   silently (the remember response does not echo the namespace). ALWAYS pass
   `namespace` explicitly to every write/read (DOGFOOD-017 open).
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
10. **Default namespace is NOT `default`** — it's `defaultNamespace` in the
    config. Always pass `--namespace` / `?namespace=` / `namespace:`.
11. **Domain enum** — `person|event|concept|message|config|raw_note` everywhere.
12. **Temp-file hygiene** — every daemon spawn/crash leaves
    `/tmp/duckbrain-<pid>-*.db` files (DOGFOOD-016, open); they accumulate.
    Harmless but untidy.

## Testing your changes safely

```bash
mkdir -p /tmp/db-test && DUCKBRAIN_NAMESPACES_PATH=/tmp/db-test node bin/duckbrain.js http --port 3999
# then point every curl/CLI call at :3999 and /tmp/db-test. Never write to the live :3000 daemon's
# namespaces — other fleet agents' memories live there (80+ namespaces in production use).
# For semantic-search work, point embeddings at a loaded model, e.g. copy the config to
# /tmp/db-test-config.json with embedding.provider=ollama / model=nomic-embed-text and add
# DUCKBRAIN_CONFIG_PATH=/tmp/db-test-config.json (DUCKBRAIN_NAMESPACES_PATH still isolates data).
```
