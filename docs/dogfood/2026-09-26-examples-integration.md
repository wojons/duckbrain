# DuckBrain Integration Report — Run 12 (2026-09-26): the examples/ on-ramp

**Angle (never driven by runs 1–11):** the repository's own documented examples —
`examples/http-api`, `examples/mcp-client`, `examples/custom-storage` — plus the
README's "Multi-Agent Ready" concurrency contract. This is what a brand-new
integrator touches first, before any API doc.

**Environment:** scratch daemon on `:3821`, isolated by `DUCKBRAIN_CONFIG_PATH` +
`DUCKBRAIN_NAMESPACES_PATH` pointing into `/tmp/dogfood-duckbrain-0926/`; prod
`duckbrain-http.service` (:3000, apikey) untouched — auth.json md5 verified
unchanged before/after (`9762a11e…`). HEAD `b06db45`, branch `feat/native-s3`.

## Verdict summary

The engine behind the examples is solid — but every one of the three example
directories is broken in some load-bearing way, and two documented env vars are
inert. A new user following the repo's own on-ramp hits a wall at step 1, then a
second wall, then a 500. Once you know the real API (from `docs/api/http-api.md`
+ the server's own error strings), everything works, fast.

## What happened, step by step (the real integrator's path)

| Step | What the docs say | What actually happened |
|---|---|---|
| Start HTTP API example | `pnpm start -- http --port=3000` | `pnpm start -- X` forwards a literal `--` → CLI: `Unknown command: --`, exit 1. **Both** example READMEs' pnpm invocations fail verbatim under the repo's pinned pnpm. |
| Run the example client | `node examples/http-api/client.js` | SyntaxError: `import.meta` in a `.js` file in a CommonJS repo (no `"type": "module"`). Must copy to `.mjs` — or the README should say to. |
| `client.remember(...)` | POST `/api/memories` `{key, content}` | 400 `Missing required fields: key, domain, content` — example never sends `domain`. |
| Add `domain: "example"` | — | 400 listing the real enum: `person, event, concept, message, config, raw_note`. |
| Content as object (per example + http-api README curl) | `{message: …}` | 400 `content must be a string`. |
| Key `examples/http/test` (per example) | — | **HTTP 500** `Key must be a filesystem-style path starting with /` — validation failure must be 400. |
| Corrected: `/examples/http/test`, domain `concept`, string content | — | **201**, full row back. |
| `client.recall({key})` → `GET /api/memories?key=…` | example implies key lookup | `?key=` is not in the documented query table and is **silently ignored** — returns the whole list (discriminator-proven with 2 distinct memories). |
| `client.search({query})` → `?query=hello` | example's search | `?query=` silently ignored too. Real params: `q` (semantic), `contains` (keyword), `prefix`. |
| `GET /api/memories/key/:key` | documented | Works, returns the row. |
| `?contains=hello` on content "Hello from HTTP API!" | keyword search | **0 results** — deterministic per-term FTS miss. `"zebra"`, `"API"`, `"content"` hit; `"Hello"`, `"from"`, `"different"` never hit even after the documented `search-index rebuild` (rowCount 2) and after the 30s commit debounce. Case-insensitive in both directions where it works (`zebra`/`Zebra`). |
| `?q=hello` without an embedding provider | docs | **200 with ranked results** (keyword fallback) — graceful degradation works. Docs' 503 path applies to full semantic mode. |
| MCP example env (`DUCKBRAIN_NAMESPACE`, `DUCKBRAIN_DATA_DIR`) | examples/mcp-client README + ai-configure.md (6 config blocks) | Real stdio MCP session: **both env vars are inert**. Writes landed in `default` with `DUCKBRAIN_NAMESPACE=dogfood-examples` set; recall echoed `"namespace":"default"`. `DUCKBRAIN_DATA_DIR` only relocates the PID file. Every agent configured per those docs shares namespace `default`. |
| MCP `remember {key, content}` (per example conversation) | — | 2× zod -32602: needs `domain` (enum) + `attributes` + `embedding_text`. Same schema drift as HTTP. |
| Corrected MCP lifecycle | — | remember → `switch_namespace {name}` → remember in ns2 → recall back: all succeed; on-disk namespaces confirm per-ns partitioning. |
| custom-storage example | `--verify-config` flag, `--config=<file>`, `storage.dataDir` | **None exist.** `--verify-config` → `Unknown command` (0 hits in src). `--config=` is silently ignored by the `http` parser (flags: port/bind-all/auth/auth-file/rate-limit/unix-socket*). The annotated `dataDir` never appeared on disk; the boot log even claimed `HTTP server started at http://127.0.0.1:3000` — the compiled-in default, prod's port. Config schema has `namespacesPath`, not `storage.dataDir`. |
| Concurrency (README "Multi-Agent Ready") | http-api.md:321: N concurrent same-key writes = N versions, never LWW | **Contract holds exactly:** 12/12 concurrent POSTs to one key → 12 distinct ids, 12/12 visible via list, `/key/:key` returns one of them. 120ms total. |
| Perf (Step 2b) | — | POST 13.9ms avg warm (p50 14.0 / p90 15.5, n=20); GET list 9.7ms avg (p50 10.4 / p90 11.0). Fast enough that no PERF row is warranted. |
| Fresh-machine install (bunker, dedi-2 agent c667cb35, destroyed) | README quickstart verbatim | **PASSED: 18s** clone→nvm→corepack→`pnpm install --frozen-lockfile`; boot + write/read-back smoke with id match, 21s total. Note: first `nvm install 22` failed with a transient CDN error (retry succeeded) — the README's nvm one-liner has no retry hint. DF-0919-01/02 remain fixed. |

## What a new user needs that nothing documents

1. The **real POST schema**: `{key: "/path", domain: <enum>, content: <string>, attributes: {}, embedding_text: "<text>"}`.
2. The **real search params**: `contains` / `q` / `prefix`, not `query`/`key`.
3. `node examples/http-api/client.js` must be run as `.mjs` (or the file renamed).
4. Namespace selection is per-process `--namespace`/config `defaultNamespace` — not env.
5. Port defaults to 3000 (prod's port on any dev box that also runs prod).

## Board rows filed by this run

DF-0926-01 (P0 example-launcher + import.meta + port-3000 default),
DF-0926-02 (P1 silently-ignored `?key=`/`?query=`),
DF-0926-03 (P1 FTS contains per-term misses),
DF-0926-04 (P1 inert DUCKBRAIN_NAMESPACE/DUCKBRAIN_DATA_DIR),
DF-0926-05 (P2 custom-storage example fiction),
DF-0926-06 (P3 500-on-validation). See `dogfood-log.md` and the board.
