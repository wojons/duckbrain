---
name: duckbrain-usage
description: >-
  How to USE DuckBrain — the git-backed agent memory system in this repo — as a
  real user: entry points, run commands, the working API/MCP/CLI recipes,
  and the pitfalls that will bite you (dead ?q= search, silent semantic
  failures, content-less CLI remember, non-deleting delete_namespace,
  implicit namespaces without git). Load this before integrating DuckBrain
  into anything or answering "does DuckBrain work?".
version: 1.0.0
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
# remember/recall via tools/call; remember REQUIRES "attributes": {} at minimum
```

Full transcript, error table, and copy-paste recipes: `docs/dogfood/2026-08-07-integration.md`.

## Pitfalls that WILL bite you (all verified live)

1. **REST `?q=` search is dead** — `GET /api/memories?q=anything` returns the FULL list; the
   route parses `q` and drops it. Don't build on REST search (DOGFOOD-001). Use MCP `recall`
   with `query` for semantic search.
2. **Semantic recall fails silently** — when the embedding model is unloaded (LM Studio idle
   unload), `recall(query=...)` returns 200 with `memories: []` and an error string inside the
   payload. No fallback to ollama happens. If results look empty, check the payload for
   `"error": "Embedding generation failed..."` (DOGFOOD-002).
3. **CLI remember stores NO content** — `--content`/stdin are ignored; the memory text becomes
   the key. Use REST/MCP for content-bearing memories (DOGFOOD-003).
4. **delete_namespace doesn't delete** — success + mapping removed, files stay on disk. Remove
   the dir manually if you need the data gone (DOGFOOD-004).
5. **Implicit namespaces have no git** — writing to a namespace that wasn't created via
   `POST /api/namespaces` (or `create_namespace`) leaves you without versioning/auto-commit
   (DOGFOOD-005).
6. **Default namespace is NOT `default`** — it's `defaultNamespace` in the config. Always pass
   `--namespace` / `?namespace=`.
7. **Domain enum** — `person|event|concept|message|config|raw_note` everywhere; the docs'
   `architecture` example 400s verbatim.
8. **One shared pidfile** — don't run a second `http` instance against the same data dir; it
   clobbers `/tmp/duckbrain-http.pid` and can make `server_status` lie.

## Testing your changes safely

```bash
mkdir -p /tmp/db-test && DUCKBRAIN_NAMESPACES_PATH=/tmp/db-test node bin/duckbrain.js http --port 3999
# then point every curl/CLI call at :3999 and /tmp/db-test. Never write to the live :3000 daemon's
# namespaces — other fleet agents' memories live there (80+ namespaces in production use).
```
