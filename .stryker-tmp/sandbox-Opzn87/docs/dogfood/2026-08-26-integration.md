# DuckBrain Dogfood — 2026-08-26 Integration Report

Real-use field test. Engine: hardened live daemon (:3000, `--auth=apikey`) +
full lifecycle on an isolated scratch daemon (:3126). All recipes below were
executed and returned the stated results on 2026-08-26.

Verdict: 🟡 **PROMISING-BUT-ROUGH** — the engine delivers on its promise (see
the 08-16 → 08-26 trajectory: every 08-16 P0/P1 crash-class finding is fixed),
but agent-facing docs/CLI have real friction (3 P1s filed, DOGFOOD-025..027).

## Setting up an isolated scratch instance (the right way, as of 2026-08-26)

```bash
# 1. Isolate EVERYTHING: config file, data dir, auth store.
mkdir -p /tmp/db-test/ns
cp duckbrain.config.json /tmp/db-test/config.json   # then edit: defaultNamespace, s3.enabled=false
# scratch auth store with one scoped token:
cat > /tmp/db-test/auth.json <<'JSON'
{"users":[],"apiKeys":[{"key":"scratch-key-1","name":"scratch-user","namespaces":["scratch-ns"]}]}
JSON

# 2. Start the daemon (DB-GAP-043's --auth-file keeps PROD ~/.duckbrain/auth.json untouched — verified).
DUCKBRAIN_CONFIG_PATH=/tmp/db-test/config.json \
DUCKBRAIN_NAMESPACES_PATH=/tmp/db-test/ns \
node bin/duckbrain.js http --port 3126 --auth=apikey \
  --auth-file=/tmp/db-test/auth.json --rate-limit 600
```

⚠️ **Pitfall (DOGFOOD-026):** `duckbrain token` IGNORES `DUCKBRAIN_AUTH_FILE`
and has no `--auth-file` — it writes to `~/.duckbrain/auth.json` (prod!)
unconditionally. Never mint tokens in a scratch workflow until fixed; use a
hand-made auth.json like above (or an isolated HOME).

## Hardened-daemon auth (verified live)

| Request | Result |
|---|---|
| `GET /health` no key | 200 (health is open) |
| `GET /api/keys` no key | **401** |
| `GET /api/keys` bad key | **401** |
| `GET /api/keys` scoped key, granted ns | 200 |
| `GET /api/memories?namespace=<other>` scoped key | **403** |
| `POST /api/memories` scoped key | 201, `author: <token-name>@duckbrain.local` |

Token provenance: REST writes stamp `author` from the token name
(`dogfood-hunter@duckbrain.local`); client-supplied `?author=` is ignored.

⚠️ **Pitfall (DOGFOOD-025):** MCP-over-HTTP `tools/call remember` with the
SAME authenticated key stamps the host git identity
(`totalwindupflightsystems@gmail.com`) instead of the token name — the
DB-GAP-031 provenance fix covers REST only.

⚠️ **Pitfall (DOGFOOD-028):** omitting `?namespace=` on HTTP routes resolves
to the literal **`default`** namespace (README documents this), NOT the config
`defaultNamespace` (e.g. `eduos.dexdat.com.co`). Verified live: no-ns
`/api/memories` returns `default` data. Always pass `?namespace=` on HTTP.

## Full lifecycle (REST, all verified)

```bash
B=http://127.0.0.1:3126; K='X-API-Key: scratch-key-1'; H='Content-Type: application/json'

# create namespace (git-inits it)
curl -X POST $B/api/namespaces -H "$K" -H "$H" -d '{"name":"scratch-ns"}'

# write: attributes + temporal validity (RETR-011)
curl -X POST "$B/api/memories?namespace=scratch-ns" -H "$K" -H "$H" -d '{
  "key":"/proj/db","domain":"concept","content":"PostgreSQL + PgBouncer",
  "attributes":{"confidence":"high"},
  "valid_from":"2026-08-01T00:00:00Z","valid_until":"2026-08-21T00:00:00Z"}'

# current view hides expired/future-dated rows; &historical=true shows all
curl "$B/api/memories?namespace=scratch-ns&limit=50" -H "$K"
curl "$B/api/memories?namespace=scratch-ns&historical=true" -H "$K"

# attribute filter (RETR-006)
curl "$B/api/memories?namespace=scratch-ns&attr.tick=403" -H "$K"

# semantic search — old DOGFOOD-010 crash is GONE; ranked results with .score
curl "$B/api/memories?namespace=scratch-ns&q=connection+pooling" -H "$K"

# soft delete (tombstone) — DELETE /api/memories/:id → 204; NO POST /forget route
curl -X DELETE "$B/api/memories/<uuid>?namespace=scratch-ns" -H "$K"

# namespace delete guards: 400 no-confirm, 400 if active/default, 200 + dir gone with confirm
curl -X DELETE $B/api/namespaces/scratch-ns -H "$K" -H "$H" -d '{"confirm":true}'
```

## Keyword search + SQL surface (CLI, RETR-007/008/009/010)

```bash
export DUCKBRAIN_CONFIG_PATH=/tmp/db-test/config.json DUCKBRAIN_NAMESPACES_PATH=/tmp/db-test/ns

duckbrain search-index rebuild --namespace=scratch-ns   # index is a gitignored cache; REQUIRED first
duckbrain search "pgbouncer" --namespace=scratch-ns      # <mark>highlight</mark> + BM25 score
duckbrain search "pgbouncer" --all-namespaces            # cross-ns, [ns: ...] facet per hit
duckbrain query "SELECT key, domain FROM memories LIMIT 5" --namespace=scratch-ns  # read-only view
duckbrain query --template incidents-by-day --namespace=scratch-ns                  # saved templates
duckbrain query "DELETE FROM memories"                    # rejected: 'strictly read-only' (verified)
```

Notes: the SQL view is `latest record per id, tombstones excluded` — it does
NOT apply the valid_from/valid_until window that recall applies (DOGFOOD-031).
Direct `read_json_auto(...)` in `query` is blocked by the namespace-scope
guard with a clear message — query the `memories` view instead.

## MCP-over-HTTP

```bash
curl -X POST $B/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -H "$K" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# tools/call remember: content field is "embedding_text" (NOT "content"), "attributes" REQUIRED
# tools/call forget: takes the memory UUID (from recall), not the key
```

## CLI pitfalls confirmed live (2026-08-26)

- **`recall --namespace scratch-ns` (space form) silently runs with
  namespace='true' → "No memories found".** Use `--namespace=scratch-ns`
  (equals form). Same class: `--as-of 2026-08-10` → 'true' (CLI-FIX-001,
  pending). `search` was fixed (RETR-008) but `recall` was not (DOGFOOD-027).
- `recall` with no flags uses config `defaultNamespace` (correctly).
- Semantic recall degrades gracefully when the keyword index is missing
  ("Keyword leg unavailable for hybrid — degrading ..." then vector results).

## What a new user needs that isn't documented (→ board)

DOGFOOD-025 (MCP author provenance), 026 (token mint isolation), 027 (recall
space-form), 028 (skill v1.3.0 stale: claims no --auth-file; no RETR commands;
HTTP-vs-CLI namespace default), 029 (--all-namespaces unindexed = hard error
not skip-warning), 030 (s3 status shows placeholder endpoint), 031 (SQL view
ignores validity).

## Artifacts

- Board: `.coding-hermes/board/tasks.jsonl` (DOGFOOD-025..031)
- Diagnostics trail: `docs/dogfood/diagnostics.md`
- Log: `.coding-hermes/dogfood-log.md`
