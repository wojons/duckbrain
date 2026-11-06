# Decision: which declaration shape is canonical (ADOPT-DECLARED-001)

**Status:** decided (2026-11-06) — legacy stays canonical for the tables that
already use it; `schema.json` is the path every NEW table must take.
**Row:** ADOPT-DECLARED-001. **Follow-up:** DECLARE-MIGRATE-001 (owner-gated).

## The measurement

Re-measured on the production store on 2026-11-06 (read-only):

```
find namespaces -maxdepth 2 -name schema.json   → 0
find namespaces -name '*.table.json'            → 949  (across 71 namespaces)
find namespaces -maxdepth 1 -mindepth 1 -type d  → 297 namespace directories
```

The same 0 / 949 split was measured by the 2026-11-04 bakeoff. Nothing had
adopted the SUPA-6 persistent schema in production, while every real table was
declared the legacy way. That is the gap ADOPT-DECLARED-001 exists to close —
and the first half of closing it was the missing network surface: declaration
was reachable only from a shell on the box (CLI) and, since SURFACE-MCP-DATA-001,
over MCP; `POST /api/ns/:ns/tables/:table/declare` now exposes the same core to
any HTTP agent.

## Decision

1. **New tables declare `schema.json`** (the default for the CLI verb, the MCP
   `tables_declare` tool and the new HTTP route). Their inserts ride the SUPA-2
   serializer: validation → ordered write → audit + DB-SUPA-5 change record →
   commit, with the DDL fence honoured for declaration changes.
2. **The 949 existing legacy declarations are NOT migrated here.** Migration is
   a rewrite of live namespace declarations and is owner-gated (the hardening
   loop may not touch production namespaces). It is filed as
   DECLARE-MIGRATE-001 with the recipe below.
3. **Legacy is not deprecated on paper before it is empty in practice.** The
   docs now name the recommended path instead of implying `schema.json` is what
   production already runs.

## Why a partial migration is worse than none

`src/schema/table-registry.ts`: *"Legacy declarations are unchanged by DB-SUPA-6
and always win on a name conflict."* So writing a `schema.json` entry for a table
that still has `tables/<table>.table.json` does nothing visible — the table
keeps serving from the legacy file and the `schema.json` entry is dead weight
that makes a namespace look migrated. A real migration is therefore two steps
per table (declare in `schema.json`, then delete the legacy file) and the
switch happens at the delete. Doing that partially across 71 namespaces produces
a store where "which path is this table on?" can only be answered by reading the
filesystem, which is exactly the ambiguity this row set out to remove.

## What the legacy shape costs (sourced)

| Cost | Where it is visible |
|---|---|
| No DB-SUPA-5 change record on inserts — no change event for realtime/replay consumers | `docs/api/http-api.md`, "Legacy table declaration … no `schema.json` serializer involvement" |
| No SUPA-2 ordering/commit barrier; durability is the direct append + fsync, not the serializer's audit trail | same table; `docs/specs/SUPA-1-write-durability.md` |
| No declared relations (`columns[].references`), so `?embed=` cannot be used | REST-ATOMICITY-001 surface, `GET /api/ns/:ns/tables/:table?embed=…` |
| No composite `keyColumns`, no per-table `schemaVersion`, no views | `docs/specs/SUPA-6-ddl.md` |
| Declaration collisions resolve to the legacy file, silently | `src/schema/table-registry.ts` |

## Migration recipe (DECLARE-MIGRATE-001)

Per namespace, per table, with the daemon serving:

1. `POST /api/ns/<ns>/tables/<table>/declare` with the table's exact columns,
   primary key and row shape (no `legacy`) — `force` only where the contract
   genuinely must change.
2. Prove parity BEFORE deleting anything: `GET /api/ns/<ns>/tables/<table>` and
   `Prefer: count=exact` must match the pre-change response row-for-row.
3. Delete `namespaces/<ns>/tables/<table>.table.json` — this is the switch: the
   table now resolves from `schema.json` and its writes ride the serializer.
4. Re-prove (1)-(2), then insert one probe row and confirm the write went
   through the namespace writer rather than the legacy direct append: the
   SUPA-6 branch in `insertTableRows` (`src/tables/operations.ts`) enqueues on
   the NamespaceWriter, which is what writes the DB-SUPA-5 change record and
   the audit entry the legacy branch never produces.
5. Rollback at any point: restore the deleted legacy file — legacy wins again.

## How adoption stays visible

`GET /metrics` now carries `duckbrain_table_declaration_namespaces{format}` and
`duckbrain_table_declarations{format}` (`format="schema.json"|"legacy"`),
sampled from the namespaces root at scrape time. Current values on this store:
`schema.json` = 0 namespaces / 0 tables, `legacy` = 71 namespaces / 949 tables.
The migration's progress is those two numbers converging, not a checklist.
