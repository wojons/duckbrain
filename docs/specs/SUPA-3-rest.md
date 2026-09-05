# SUPA-3 — PostgREST-Equal Resource Layer: Generic Table→REST Derivation

- **Board row:** DB-SUPA-3 (P1, complexity 3)
- **Spec row:** DB-SUPA-9 (SPEC SET A)
- **Status:** pending implementation — contract for the build
- **Reference:** mallard-prd-v14.html §03 (resource-oriented API, PostgREST-style); owner directive 2026-09-03
- **Companion specs:** `docs/specs/SUPA-1-write-durability.md`, `docs/specs/SUPA-2-serialization.md`, `docs/specs/SUPA-4-auth.md`

## Problem Statement

DuckBrain's HTTP surface is memory-specific: `createMemoryRoutes` is mounted at `/api/memories` (`src/cli/http.ts:331`) alongside keys/namespaces/events/compaction routes, and every handler is hand-written against the memory schema. Meanwhile the namespace store already proves arbitrary tabular JSONL: `namespaces/routing/snapshots/*/*.jsonl` hold positional-array tables (e.g. each line of `namespaces/routing/snapshots/2026-09-01/benchmarks.jsonl` is a JSON array like `["MiniMax-M3","code_gen",0.59,...]`) with no generic read or write surface. A consumer who wants those rows must either read raw files or hand-roll per-table code — the exact gap the PRD's "schema in, API out — zero hand-written endpoints" clause targets.

SUPA-3 derives a generic REST resource from every declared table and view in a namespace, pinned to a PostgREST-compatible query grammar subset so that PostgREST-conventions clients (`postgrest-js`, `postgrest-py`) work against DuckBrain with no adapter. Memory routes stay; this layer is additive. Column shape comes from the **declared schema registry** — never per-query auto-detection, because `read_json_auto`-style inference is the SIGABRT class of failure on hostile/irregular input.

## Acceptance Criteria

### Contract: route surface

New module `src/http/routes/tables.ts` exporting `createTableRoutes`; mounted in `createHttpServer` (`src/cli/http.ts:243`) as `app.use("/api/ns", createTableRoutes)`, behind the existing middleware order (DNS rebinding → rate limit → auth → body parser, `src/cli/http.ts:258-298`).

| Route | Method | Purpose |
|---|---|---|
| `/api/ns/:ns/tables` | GET | List declared tables and views in the namespace (name, kind: `table`\|`view`, column names/types from the registry). |
| `/api/ns/:ns/tables/:table` | GET | Filtered/sorted/paginated row read (grammar below). |
| `/api/ns/:ns/tables/:table` | POST | Insert one JSON object (`Content-Type: application/json`) or a batch (`Content-Type: application/x-ndjson`). Returns `201` with the created rows as a JSON array. |
| `/api/ns/:ns/tables/:table` | PATCH / DELETE | Row update/delete — only when the table declares key columns in the registry; otherwise `405 METHOD_NOT_ALLOWED`. |
| `/api/ns/:ns/views/:view` | GET | Read-only view resource (embed-free joins). POST/PATCH/DELETE → `405`. |
| `/api/openapi.json` | GET | Generated OpenAPI document (rules below). |

Namespace resolution uses `resolveNamespacePath` (`src/mcp/tools/shared.ts:27`); a missing namespace maps to `404 NOT_FOUND` via the existing remap in `errorHandler` (`src/http/middleware/errorHandler.ts:92-102`).

### Contract: query grammar (pinned exactly)

PostgREST-style querystring operators. **Only these are supported; any other operator or shape returns `400 UNSUPPORTED_QUERY` with the operator named in `fields`** — never silent ignore.

| Feature | Syntax | Rules |
|---|---|---|
| Column selection | `?select=a,b,c` | Comma-separated declared columns. Unknown column → `400 UNKNOWN_COLUMN`. Absent → all columns. |
| Equality | `?col=eq.val` | Exact match; JSON scalar semantics (string/number/boolean). |
| Inequality | `?col=neq.val` | Negation of `eq`. |
| Range | `?col=gte.val` / `?col=lte.val` | Numbers, or ISO-8601 datetime strings (same-format lexicographic comparison). |
| Membership | `?col=in.(a,b,c)` | Comma-separated list. `in.()` matches zero rows. |
| Ordering | `?order=col.asc` / `?order=col.desc` (PostgREST also accepts `-col`), comma-separated multi-key | Ties keep file order (stable sort). |
| Pagination | `?limit=N` / `?offset=N` | Default `limit` 100 (precedent: `MAX_LIMIT` handling in `src/http/routes/memories.ts:85-90`). |
| Count | `?count=exact` | Adds `Content-Range: <start>-<end>/<total>` to the response; without it the range total is `*`. |

Explicitly unsupported (return `400 UNSUPPORTED_QUERY`): `like`, `ilike`, `is`, `not.`, `or.`, `and.`, `select` computed/aliased columns, embedded resources (`select=table(*)`), full-text, casts. **Joins are embed-free**: cross-table queries are declared as view resources (DB-SUPA-6), read-only, listed alongside tables.

**Pagination caps:** `limit` ∈ [1, 1000]; `limit > 1000` or `limit < 1` → `400 PAGINATION_LIMIT_EXCEEDED`. `offset` ∈ [0, 100_000]; beyond → `400 PAGINATION_LIMIT_EXCEEDED`. Each GET scans the table's JSONL from the head (same cost model as `readFromJsonl`, `src/storage/jsonl.ts:195`), filters/sorts in memory, then slices; `count=exact` forces a full scan and is documented as such in `docs/api/http-api.md`.

**Responses:**

- Default `Accept: application/json`: body is a **bare JSON array** of row objects (PostgREST wire shape, so `postgrest-js` list handling works); pagination in `Content-Range: items <start>-<end>/<total>`; empty result → `200` with `[]`.
- `Accept: text/csv`: header row from declared columns, then rows.
- `Accept: application/vnd.apache.arrow.stream`: Arrow IPC stream via the DuckDB query path (`src/duckdb/`); same caps apply.
- `Content-Type: application/x-ndjson` on POST: batch insert; rows validated **before** enqueue (SUPA-2 AC-8) so a batch with any invalid row is refused whole with `400 VALIDATION_ERROR` and the failing line index in `fields.line`.
- Write responses carry `X-Durability` (SUPA-1) resolved for the namespace.

**Typed responses:** every row is validated against the table's registered Zod schema before serialization. A stored line that violates the declared schema (legacy or externally-written garbage) fails the read with `500 ROW_SCHEMA_VIOLATION` and the error message names the file and line number — corrupt rows surface loudly, never pass through. Positional-array tables (registry-declared tuple schemas with header names, per DB-SUPA-6) are returned as objects keyed by their declared headers.

**OpenAPI generation rules** (`GET /api/openapi.json`):

1. One schema object per declared table and view, derived from the registry Zod schema (zod → JSON Schema conversion: `z.object` → `object` with `properties`; `z.array`/tuple with headers → object; enums → `enum`).
2. One path per resource: `GET/POST/PATCH/DELETE /api/ns/{ns}/tables/{table}` with the operator parameters (`eq/neq/gte/lte/in` per column, `order`, `limit`, `offset`, `count`) declared as query parameters.
3. Security scheme reflects the active auth type (`src/auth/middleware.ts:33`): `apikey` → `X-API-Key` header API key; `basic` → HTTP basic; `none` → no security schemes.
4. Only declared schemas appear; no per-query inferred columns, no resources for undeclared files.
5. `info.version` from `package.json`; `openapi: "3.0.3"`.

**Error envelope:** all failures use the existing `ApiError`/`ValidationError` envelope (`src/http/middleware/errorHandler.ts`): `{ error, code, fields? }`.

### Behavioral acceptance criteria

- **AC-1 (PostgREST client compatibility):** GIVEN a fixture namespace with a declared table (50 rows, mixed string/number/datetime columns), WHEN `postgrest-js` runs `select("*").eq(col, val).order(col, {ascending:false}).limit(5)` and a row insert against the in-process server, THEN the filtered/ordered rows and the inserted row match the fixture exactly.
- **AC-2 (grammar rejection):** GIVEN a GET using `like`, `not.`, `or.`, or an embedded `select=table(*)`, WHEN processed, THEN `400 UNSUPPORTED_QUERY` names the offending operator in `fields`; no partial results are returned.
- **AC-3 (pagination caps):** GIVEN `limit=5000` or `offset=100001` on any table, WHEN processed, THEN `400 PAGINATION_LIMIT_EXCEEDED`; with no `limit`, exactly 100 rows return and `Content-Range` reports the window.
- **AC-4 (count and content-range):** GIVEN `count=exact` on a 50-row table with `limit=10&offset=20`, WHEN processed, THEN the body has ≤ 10 rows and `Content-Range: items 20-29/50`; without `count=exact`, the total is `*`.
- **AC-5 (insert + batch):** GIVEN a single-object POST and a 3-line NDJSON POST against a declared table, WHEN processed, THEN `201` returns the created rows as an array, and an NDJSON batch containing one schema-violating line returns `400 VALIDATION_ERROR` with `fields.line` and inserts nothing.
- **AC-6 (views are the join surface):** GIVEN a declared view resource, WHEN GET is issued, THEN rows return; a POST to the view returns `405 METHOD_NOT_ALLOWED`.
- **AC-7 (typed reads):** GIVEN a fixture table whose file contains one line violating the declared schema, WHEN GET is issued, THEN `500 ROW_SCHEMA_VIOLATION` names the file and line, and the remaining valid rows are not silently served around it.
- **AC-8 (positional-array round-trip):** GIVEN a fixture positional-array table with declared headers (shape of `namespaces/routing/snapshots/*/benchmarks.jsonl`), WHEN GET and POST are issued, THEN rows return as header-keyed objects and inserted arrays round-trip byte-identically.
- **AC-9 (OpenAPI):** GIVEN a fixture namespace with two declared tables and one view, WHEN `GET /api/openapi.json`, THEN the document declares exactly those resources, the per-column operators, the pagination parameters, and the security scheme matching the configured auth type.
- **AC-10 (auth and grants):** GIVEN a principal whose SUPA-4 grants allow `tables.read` but not `tables.write` on the namespace, WHEN GET then POST are issued, THEN GET succeeds and POST returns `403 FORBIDDEN` (grant middleware from SUPA-4, denial audited).

## Edge Cases

- **Empty table:** `200 []`, `Content-Range: items 0-0/0` with `count=exact`.
- **Unknown namespace:** `404 NOT_FOUND` through the existing remap (`src/http/middleware/errorHandler.ts:92-102`).
- **Unknown table/view:** `404 TABLE_NOT_FOUND` / `404 VIEW_NOT_FOUND`.
- **Malformed operator value** (`col=in.(unterminated`, `col=eq.` empty): `400 QUERY_PARSE_ERROR` naming the column.
- **Unknown column in select/filter/order:** `400 UNKNOWN_COLUMN`; the request is refused whole — no silent column drop.
- **Column typed comparisons:** comparing a string column with a numeric literal or vice versa is a schema mismatch → `400 QUERY_PARSE_ERROR` (comparison uses the declared column type, never JS coercion).
- **Row larger than page:** caps are row-count based; a single multi-MB row is returned whole. Documented memory bound: limit × largest row; Arrow/CSV streaming for large pulls.
- **Keyless tables:** no declared key columns → POST/GET only; PATCH/DELETE return `405 METHOD_NOT_ALLOWED` (append-only by construction).
- **`count=exact` cost on large tables:** full scan per request; documented in `docs/api/http-api.md`; the Arrow path streams the scan.
- **Registry schema absent for a table that exists on disk** (SUPA-6 not yet registered): the table is not listed and reads return `404 TABLE_NOT_FOUND` — undeclared files are never auto-inferred into resources.

## Non-Goals

- No full PostgREST grammar parity: embedding, `or.`/`and.` logic trees, `like`/`ilike`, casts, computed columns, `rpc`, and PostgREST's JWT-role-switching semantics are out of scope and explicitly rejected (AC-2), not silently accepted.
- No raw SQL surface: that is the SUPA-4 opt-in flag with caps, on a separate endpoint.
- No schema definition or evolution (registry content, view creation, key-column declaration): DB-SUPA-6 owns declared DDL. SUPA-3 consumes the registry interface only.
- No realtime/change feed: DB-SUPA-5 owns that contract.
- No changes to the existing memory/keys/namespaces/events/compaction routes; this layer is additive.
- No per-query column auto-detection in any form (`read_json_auto` class).

## Dependencies

- **DB-SUPA-6 (declared DDL surface) — required, do not assume it exists.** SUPA-3 consumes the SUPA-6 schema registry (declared tables, views, key columns, positional-array headers) and the `/api/ns/:ns/tables` surface is only meaningful once SUPA-6 registers namespaces. Ordering: SUPA-6's registry contract lands first (or in lockstep); until then SUPA-3's own test fixtures provide an in-memory registry implementing the same interface, and the shipped routes are not mounted. SUPA-3 does not define, infer, or migrate schemas itself.
- **DB-SUPA-2 (serialization layer)** — every POST/PATCH/DELETE enqueues through the per-namespace `NamespaceWriter` (`src/serialization/namespaceWriter.ts`), inheriting validate-at-append, role checks before enqueue, audit rows, and batch atomicity.
- **DB-SUPA-1 (write durability)** — insert responses carry `X-Durability` and, on fsync/direct namespaces, resolve only after the durability barrier.
- **DB-SUPA-4 (roles + auth)** — per-table grants (`tables.read`/`tables.write`, SUPA-4 matrix) gate every route via middleware; denials audited.
- **Existing code referenced:** `createHttpServer` middleware order and route mounts (`src/cli/http.ts`), `resolveNamespacePath` (`src/mcp/tools/shared.ts:27`), `readFromJsonl` scan model (`src/storage/jsonl.ts:195`), `MAX_LIMIT` pagination precedent (`src/http/routes/memories.ts:85-90`), error envelope (`src/http/middleware/errorHandler.ts`), DuckDB query path for Arrow (`src/duckdb/`), `AuthConfig`/`AuthPrincipal` (`src/auth/middleware.ts`).

## Test Plan

New suites (runnable individually via `pnpm test <file>` or together via `pnpm test`):

`src/http/routes/tables-grammar.test.ts`:
- "eq/neq/gte/lte/in filters return the exact matching row set from the fixture".
- "in.() matches zero rows; in.(a,b) matches both".
- "order=col.desc and -col are equivalent; ties keep file order".
- "limit default is 100; limit=5000 and offset=100001 return PAGINATION_LIMIT_EXCEEDED" (AC-3).
- "like, not., or., and embedded select return UNSUPPORTED_QUERY naming the operator" (AC-2).
- "unknown column in select/filter/order returns UNKNOWN_COLUMN".
- "malformed operator value returns QUERY_PARSE_ERROR".
- "count=exact emits Content-Range 0-9/50; absent count emits total *" (AC-4).
- "missing namespace → 404; unknown table → TABLE_NOT_FOUND; GET empty table → 200 []".

`src/http/routes/tables-crud.test.ts`:
- "single-object POST returns 201 with the created row array".
- "NDJSON 3-line batch inserts all three and returns them".
- "NDJSON batch with one invalid line returns VALIDATION_ERROR with fields.line and inserts nothing" (AC-5).
- "PATCH/DELETE on a key-declared table update/delete the addressed row; on a keyless table → 405".
- "POST to a declared view → 405 METHOD_NOT_ALLOWED" (AC-6).
- "row violating the declared schema on disk → 500 ROW_SCHEMA_VIOLATION naming file and line" (AC-7).
- "positional-array fixture round-trips as header-keyed objects over GET and POST" (AC-8).
- "insert response carries X-Durability matching the namespace mode".

`src/http/routes/tables-auth.test.ts`:
- "writer role: GET passes, POST passes; analyst role: GET passes, POST → 403; denial audited" (AC-10).

`src/http/routes/tables-postgrest-client.test.ts` (postgrest-js against the in-process server, or fetch-level grammar mirror when the client dependency is not added — the mirror is named `tables-postgrest-grammar.test.ts`):
- "postgrest-js select with eq + order + limit returns the expected rows" (AC-1).
- "postgrest-js insert returns the created row".
- "postgrest-js count=exact surfaces Content-Range".

`src/http/routes/tables-csv-arrow.test.ts`:
- "Accept: text/csv returns a header row plus rows".
- "Accept: application/vnd.apache.arrow.stream returns a parseable Arrow stream under the same caps".
- "Accept: application/x-ndjson on GET is refused (400)".

`src/http/routes/tables-openapi.test.ts`:
- "openapi.json declares exactly the registered tables and views with column schemas" (AC-9).
- "per-column eq/neq/gte/lte/in and order/limit/offset/count parameters are declared".
- "security scheme matches auth type apikey/basic/none".
- "undeclared on-disk files never appear in the document".

Run the full set with `pnpm test`; targeted runs: `pnpm test tables-grammar`, `pnpm test tables-crud`, `pnpm test tables-auth`, `pnpm test tables-openapi`, `pnpm test tables-csv-arrow`.
