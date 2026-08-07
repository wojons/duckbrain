# DuckBrain Integration Report — 2026-08-07

Real-use run: integrate an AI agent's persistent memory into a workflow using DuckBrain's three
agent-facing surfaces (REST, MCP-over-HTTP, CLI). Everything below was executed against the live
daemon (`node bin/duckbrain.js http --port 3000`) plus an isolated scratch instance; no code was
changed. All example payloads use placeholder values.

## 1. What DuckBrain actually is (after using it)

- **Storage:** each namespace is a directory (`namespaces/<ns>/`) with append-only JSONL partitions
  (`<domain>/<YYYY-MM>/current.jsonl`), a `manifest.json`, and its own **git repo** (when created
  explicitly). Memories are JSONL lines: `id, key, domain, timestamp, author, action (add|tombstone),
  embedding_text, attributes`.
- **Write path:** REST `POST /api/memories` and MCP `remember` both work and are equivalent. Updates
  are append-only: `PUT` writes a `tombstone` line for the old id + an `add` line with a NEW id.
- **Git:** batched auto-commit (config `gitBatching`, ~30s window). Commits land with message
  `chore: auto-commit namespace data`. Only for explicitly-created namespaces (see pitfalls).
- **Embeddings:** write-time embedding is cached under `.embeddings/<provider>_<model>/` (never in
  git). Semantic recall reads the cache; cache misses call the provider at query time.

## 2. The working recipe (copy this)

### REST (server on :3000)

```bash
# health
curl http://127.0.0.1:3000/health

# create a namespace (this is what git-inits it!)
curl -X POST http://127.0.0.1:3000/api/namespaces \
  -H 'Content-Type: application/json' -d '{"name":"my-project"}'

# write a memory — domain MUST be one of: person|event|concept|message|config|raw_note
curl -X POST "http://127.0.0.1:3000/api/memories?namespace=my-project" \
  -H 'Content-Type: application/json' \
  -d '{"key":"/projects/myapp/database","domain":"concept","content":"PostgreSQL + PgBouncer","attributes":{"confidence":"high"}}'

# read back
curl "http://127.0.0.1:3000/api/memories/key/projects/myapp/database?namespace=my-project"
curl "http://127.0.0.1:3000/api/memories?namespace=my-project&prefix=/projects/&limit=50"
curl "http://127.0.0.1:3000/api/keys?namespace=my-project"     # tree view
```

### MCP-over-HTTP (remote agents)

```bash
# REQUIRED: Accept header — without it tools/list returns an EMPTY list
curl -X POST http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Then the normal JSON-RPC flow: `initialize` → `tools/call` with `name: "remember"|"recall"|...`.
`remember` REQUIRES an `attributes` object (pass `{}`); `recall` supports `key`, `keyPrefix`,
`domain`, `query` (semantic), `namespace`, `limit`.

### CLI (same machine)

```bash
node bin/duckbrain.js remember /projects/myapp/database --domain=concept --attr='{"confidence":"high"}'
node bin/duckbrain.js recall --namespace=my-project --limit=50
node bin/duckbrain.js list-keys --namespace=my-project
```

Note: the default namespace is NOT `default` — it is `defaultNamespace` from
`duckbrain.config.json` (here `eduos.dexdat.com.co`). Always pass `--namespace`.

## 3. Errors hit and their fixes (real transcript)

| What I did | What happened | Fix / workaround |
|---|---|---|
| `POST /api/memories` with `"domain":"architecture"` (docs example) | `400 VALIDATION_ERROR: Invalid domain 'architecture'. Must be one of: person, event, concept, message, config, raw_note` | Use an enum domain. Docs are wrong (DOGFOOD-006). |
| MCP `remember` without `attributes` | `MCP error -32602: expected record, received undefined at attributes` | Always pass `"attributes": {}` — undocumented requirement (DOGFOOD-006). |
| `tools/list` without Accept header (docs example) | `{"result":{"tools":[]}}` — silent empty | Add `Accept: application/json, text/event-stream` (DOGFOOD-007). |
| MCP `recall` with `query` while LM Studio model unloaded | 200 with `memories: []` + error string inside | Retry after model loads, or set `embedding.provider=ollama` (nomic-embed-text works). Failure is silent — watch the payload (DOGFOOD-002). |
| CLI `remember --content="..."` | Flag silently ignored; memory text = the key | CLI cannot store content today; use REST/MCP for content-bearing memories (DOGFOOD-003). |
| `delete_namespace` | `{"success": true}` but all files still on disk | Treat as unregister; remove the dir manually if you truly want data gone (DOGFOOD-004). |
| Write to a brand-new namespace without creating it first | No git repo, no versioning, no auto-commit | Create the namespace via `POST /api/namespaces` first (DOGFOOD-005). |

## 4. The "aha"

- The MCP surface is the real product: `remember`/`recall` with `keyPrefix` + `domain` + semantic
  `query` is exactly the memory primitive an agent needs, and it works over both stdio and HTTP.
- Versioning is genuinely nice when it engages: every update is a tombstone+add pair in JSONL, and
  git gives you the full timeline for free.
- The REST `q=` search being dead (DOGFOOD-001) means the Web UI's search and any REST-based agent
  search silently return everything — a P0 for anyone building on `?q=`.
