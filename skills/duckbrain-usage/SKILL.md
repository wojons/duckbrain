---
name: duckbrain-usage
description: >-
  How to USE DuckBrain — the git-backed agent memory system in this repo — as a
  real user: entry points, run commands, the working API/MCP/CLI recipes,
  and the pitfalls that will bite you (semantic ?q= CRASHES the live daemon,
  no relevance threshold, MCP remember needs embedding_text, forget takes a
  UUID, delete_namespace needs confirm, sticky active namespace, stale tool
  claims). Load this before integrating DuckBrain into anything or answering
  "does DuckBrain work?".
version: 1.1.0
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

## The right way (verified 2026-08-07)

```bash
# 1. CREATE the namespace first — this is what git-inits it (versioning!)
curl -X POST http://127.0.0.1:3000/api/namespaces -H 'Content-Type: application/json' \
  -d '{"name":"my-project"}'

# 2. Write — domain MUST be one of: person|event|concept|message|config|raw_note
curl -X POST "http://127.0.0.1:3000/api/memories?namespace=my-project" \
  -H 'Content-Type: application/json' \
  -d '{"key":"/projects/myapp/db","domain":"concept","content":"PostgreSQL + PgBouncer","attributes":{"confidence":"high"}}'

# 3. Read — exact key, prefix list, key tree
curl "http://127.0.0.1:3000/api/memories/key/projects/myapp/db?namespace=my-project"
curl "http://127.0.0.1:3000/api/memories?namespace=my-project&prefix=/projects/&limit=50"
curl "http://127.0.0.1:3000/api/keys?namespace=my-project"

# 4. MCP-over-HTTP — the Accept header is REQUIRED or tools/list returns empty
curl -X POST http://127.0.0.1:3000/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# remember/recall via tools/call; remember REQUIRES "attributes": {} AND the
# content field is "embedding_text" (NOT "content") — see pitfalls #3/#4
```

MCP stdio (`node bin/duckbrain.js stdio`) works with any SDK client
(`@modelcontextprotocol/sdk`); a full working client session (create ns →
remember → recall → semantic recall → forget by UUID → delete ns with
`confirm: true`) is in `docs/dogfood/2026-08-16-integration.md`.

Full transcript, error table, and copy-paste recipes: `docs/dogfood/2026-08-07-integration.md`.

## Pitfalls that WILL bite you (all verified live 2026-08-07 and 2026-08-16)

1. **REST `?q=` / MCP `query=` semantic search CRASHES the live daemon on real
   data (DOGFOOD-010, P0, open).** Every `GET /api/memories?q=` against a
   namespace with real-world JSONL kills the process:
   `duckdb::InvalidInputException "Map keys must be unique."` → SIGABRT → systemd
   restart (verified 5 restarts in ~2 min on hermes-memory AND dexdat-core;
   `journalctl --user -u duckbrain-http` shows `status=6/ABRT`). A scratch
   daemon with 155 simple memories instead hangs >60s. Until DOGFOOD-010 lands:
   **do NOT use `?q=` / `query=` on the live daemon.**
2. **Semantic search has NO relevance threshold (DOGFOOD-011, open).**
   `?q=zzznothing` returns ALL memories (ranked, never filtered) — on small
   namespaces every query returns everything. Ranking works (true matches score
   0.74–0.77), filtering doesn't.
3. **MCP `remember` content field is `embedding_text`, NOT `content`**
   (REST uses `content` — same field, two names). Passing `content:` fails with
   `-32602 ... expected string, received undefined at embedding_text`.
   `attributes` is required (`{}` ok). `forget` takes the memory **UUID** (from
   recall), not the key. `delete_namespace` requires `confirm: true` and DOES
   delete files + git repo now (DOGFOOD-004 fixed).
4. **Active namespace is sticky ACROSS processes.** A `switch_namespace` in one
   stdio session redirects later separate sessions' namespace-less writes —
   silently (the remember response does not echo the namespace). ALWAYS pass
   `namespace` explicitly to every write/read (DOGFOOD-017).
5. **`server_http_start` is broken in the standard setup (DOGFOOD-013, open)** —
   it resolves the project root from cwd (`..`/`..` from the repo root = `/`),
   spawns a nonexistent binary with stderr discarded, and reports
   "spawned ... but port not listening within 5s". Start HTTP daemons yourself.
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
   fix verified: failures now surface as `isError=true` with detail.
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
```
