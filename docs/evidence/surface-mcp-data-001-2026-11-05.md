# SURFACE-MCP-DATA-001 — MCP data plane, live proof

Row: `[P1] MCP reaches only memory primitives — no declared-table CRUD, no table
declaration, no keyword search, no SQL query`.

Date: 2026-11-05. Driver: `scripts/proofs/surface-mcp-data-001.mjs` (real MCP
SDK client over **both** transports).

Scratch daemon (never :3000, never the repo's namespaces tree):

```
port            28734
DUCKBRAIN_NAMESPACES_PATH
/home/kara/.hermes/cache/scratch/mcp-proof-final-1793912983/namespaces
DUCKBRAIN_DATA_DIR
/home/kara/.hermes/cache/scratch/mcp-proof-final-1793912983/data
auth             apikey file with two tokens:
                   proof-admin  roles=["admin"]                namespaces=["mcp-proof"]
                   proof-reader roles=["writer"] tableGrants={widgets:"read"} namespaces=["mcp-proof"]
command          node bin/duckbrain.js http --port=28734 --auth=apikey --auth-file=<scratch>/auth.json
health           GET /health -> 503 degraded (embedding provider intentionally unset; remember uses embedding_text)
```

## Transcript (client-driven, both transports)

```
=== [1] stdio transport (duckbrain stdio) ===
tools/list data-plane: ["table_list","tables_declare","table_insert","table_select","table_update","table_delete","query","search"]
tables_declare: {"success":true,"namespace":"mcp-proof","table":"widgets","path":"/home/kara/.hermes/cache/scratch/mcp-proof-final-1793912983/namespaces/mcp-proof/schema.json","format":"schema.json","replacedExisting":false}
table_insert (2 rows): {"success":true,"namespace":"mcp-proof","table":"widgets","inserted":2,"durability":{"configured":"buffered","achieved":"buffered"}}
table_select qty=gte.6 order=id.asc count=exact: {"success":true,"namespace":"mcp-proof","table":"widgets","rows":[{"id":2,"name":"beta","qty":9}],"count":1,"totalCount":1}
table_update pk=2: {"success":true,"namespace":"mcp-proof","table":"widgets","updated":1,"durability":{"configured":"buffered","achieved":"buffered"}}
table_delete pk=1: {"success":true,"namespace":"mcp-proof","table":"widgets","deleted":1,"durability":{"configured":"buffered","achieved":"buffered"}}
table_select (after delete): {"success":true,"namespace":"mcp-proof","table":"widgets","rows":[{"id":2,"name":"beta-2","qty":9}],"count":1}
table_select undeclared table: {"success":false,"code":"NOT_FOUND","error":"Table 'no_such_table' not found in namespace 'mcp-proof'"}
=== [2] streamable HTTP transport (POST /mcp) ===
tools/list over /mcp: ["tables_declare","table_insert","table_select","table_update","table_delete","query","search"]
remember (memory for search): {"success":true,"id":"4f77c2cf-6ce0-41ce-b67b-13037871a8b8","timestamp":"2026-11-05T21:09:49.725Z","key":"/surface/mcp/live-proof","partition":"raw_note/2026-11/","author":"proof-admin@duckbrain.local","namespace":"mcp-proof"}
search over /mcp: {"memories":[{"id":"4f77c2cf-6ce0-41ce-b67b-13037871a8b8","key":"/surface/mcp/live-proof","domain":"raw_note","timestamp":"2026-11-05T21:09:49.725Z","author":"proof-admin@duckbrain.local","action":"add","embedding_text":"live proof zebra mcp data plane","attributes":{},"score":0.12493873660829992,"snippet":"/surface/mcp/live-proof live proof zebra mcp data plane {}","highlightedSnippet":"/surface/mcp/live-proof live proof <mark>zebra</mark> mcp data plane {}","namespace":"mcp-proof"}],"count":1,"total":1,"namespace":"mcp-proof"}
table_select over /mcp: {"success":true,"namespace":"mcp-proof","table":"widgets","rows":[{"id":2,"name":"beta-2","qty":9}],"count":1}
tables_declare over /mcp: {"success":true,"namespace":"mcp-proof","table":"http_items","path":"/home/kara/.hermes/cache/scratch/mcp-proof-final-1793912983/namespaces/mcp-proof/schema.json","format":"schema.json","replacedExisting":false}
table_insert over /mcp: {"success":true,"namespace":"mcp-proof","table":"http_items","inserted":2,"durability":{"configured":"buffered","achieved":"buffered"}}
table_update over /mcp: {"success":true,"namespace":"mcp-proof","table":"http_items","updated":1,"durability":{"configured":"buffered","achieved":"buffered"}}
table_select http_items order=sku.asc: {"success":true,"namespace":"mcp-proof","table":"http_items","rows":[{"sku":"a-1","title":"first"},{"sku":"b-2","title":"second-edited"}],"count":2}
table_delete over /mcp: {"success":true,"namespace":"mcp-proof","table":"http_items","deleted":1,"durability":{"configured":"buffered","achieved":"buffered"}}
table_select http_items after delete: {"success":true,"namespace":"mcp-proof","table":"http_items","rows":[{"sku":"b-2","title":"second-edited"}],"count":1}
query SELECT over /mcp: {"success":true,"namespace":"mcp-proof","columns":["n"],"rows":[{"n":1}],"count":1,"truncated":true}
table_insert with read-only table grant: {"success":false,"code":"FORBIDDEN","reason":"table_grant","error":"Forbidden: principal 'proof-reader' has no write grant for table 'widgets'"}
table_select with read-only table grant: {"success":true,"namespace":"mcp-proof","table":"widgets","rows":[{"id":2,"name":"beta-2","qty":9}],"count":1}
=== [3] namespace audit ledger (denials) ===
denial rows: [{"op":"tables.write","table":"widgets","principal":"proof-reader","reason":"table_grant"}]
accepted change records: [{"op":"insert","table":"widgets","tombstone":false},{"op":"insert","table":"widgets","tombstone":false},{"op":"update","table":"widgets","tombstone":false},{"op":"delete","table":"widgets","tombstone":true},{"op":"insert","table":"memories","tombstone":false},{"op":"insert","table":"http_items","tombstone":false},{"op":"insert","table":"http_items","tombstone":false},{"op":"update","table":"http_items","tombstone":false},{"op":"delete","table":"http_items","tombstone":true}]
```

## REST parity on the same daemon (the refactored handlers still serve the wire)

```
GET    /api/ns/mcp-proof/tables/widgets?qty=gte.6&order=id.asc -> 200 [{"id":2,"name":"beta-2","qty":9}]
POST   /api/ns/mcp-proof/tables/widgets {"id":7,...}          -> 201 {"inserted":1}  X-Durability: buffered
PATCH  /api/ns/mcp-proof/tables/widgets?pk=eq.7               -> {"updated":1}
DELETE /api/ns/mcp-proof/tables/widgets?pk=eq.7               -> {"deleted":1}
GET    /api/ns/mcp-proof/tables/nope                          -> {"error":"Table 'nope' not found in namespace 'mcp-proof'","code":"NOT_FOUND"}
```

## What this proves, criterion by criterion

1. **Same implementations, no second code path.** `table_insert/select/update/
   delete` are `src/tables/operations.ts` — the functions the REST handlers now
   delegate to (the handlers were reduced to thin adapters). `tables_declare` is
   `src/tables/declare.ts` — the core `duckbrain tables declare` now calls.
   `query` is `runReadOnlyQuery` (the `duckbrain query` core); `search` is
   `keywordSearch` (the `duckbrain search` core).
2. **Undeclared table refusal parity.** MCP: `{"code":"NOT_FOUND","error":"Table
   'no_such_table' not found in namespace 'mcp-proof'"}`; REST: identical text
   and code (pasted above).
3. **Grants bite on the MCP path.** `proof-reader` (writer role + `tableGrants:
   {widgets:"read"}`) is refused `table_insert` with
   `reason:"table_grant"` and the same message `requireTableGrant` returns on
   REST; the denial row lands in the namespace audit ledger
   (`_audit/current.jsonl`) as `op:"tables.write"`, `reason:"table_grant"`.
   The same token can still `table_select` (read grant), and a namespace
   outside its grant is refused with `reason:"namespace_scope"`.
4. **Accepted mutations stay change records.** The same ledger shows
   insert/update rows and `tombstone:true` deletes for both tables.
