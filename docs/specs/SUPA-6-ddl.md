# SUPA-6 — Declared DDL: Persistent Namespace Schemas and Safe Evolution

- **Board row:** DB-SUPA-6 (P2, complexity 2)
- **Spec row:** DB-SUPA-10 (SPEC SET B)
- **Status:** pending implementation — contract for the build
- **Companion specs:** `docs/specs/SUPA-2-serialization.md`, `docs/specs/SUPA-3-rest.md`, `docs/specs/SUPA-4-auth.md`, and `docs/specs/SUPA-5-realtime.md`

## Problem Statement

The serializer has a registry seam but no durable DDL. `TableSchemaRegistry` is an in-memory `Map`, exposes only `register` and `get`, and returns the built-in `MemorySchema` for `memories` (`src/serialization/registry.ts:4-25`). Its own comment reserves additional table registration for DB-SUPA-6. As a result, a restarted process loses arbitrary registrations and SUPA-3 cannot safely expose a generic table API from persistent declarations.

Namespace metadata already has a distinct job. `Manifest` in `src/storage/manifest.ts:14-26` tracks only active partition paths plus `lastUpdated`; `writeManifestAtomic` writes `manifest.json.tmp` and atomically renames it (`:70-93`). It must not be silently overloaded into a schema catalog. `schema.json` is a new, separate namespace artifact at `namespaces/<ns>/schema.json`: it declares logical resources and their physical layout; `manifest.json` remains the live physical-partition index used by storage and historical reads.

SUPA-3 explicitly depends on this row for declared tables, views, key columns, and positional headers, and rejects per-query inference (`docs/specs/SUPA-3-rest.md:13-14, 59-67, 106-112`). This specification makes that interface durable. It permits one-time inference only while creating a declaration, under a bounded migration window; every read after declaration uses declared columns and row shape. It does not change the current memory APIs or claim that generic REST routes already exist.

## Acceptance Criteria

### Contract: `schema.json` v1

`schema.json` is UTF-8 JSON, formatted deterministically with a final newline, and validated before use. Its top-level `schemaVersion` is the document-format version, initially integer `1`. A namespace has at most one active schema document. The planned loader is `src/serialization/schemaRegistry.ts`; it loads this file on first namespace access, caches by file identity, and revalidates when the atomic replacement changes. It registers Zod validators into the existing `TableSchemaRegistry` only after the complete document validates.

```json
{
  "schemaVersion": 1,
  "tables": {
    "scores": {
      "schemaVersion": 1,
      "storage": { "path": "tables/scores/current.jsonl" },
      "rowShape": "object",
      "keyColumns": ["id"],
      "columns": [
        { "name": "id", "type": "string", "nullable": false },
        { "name": "score", "type": "float64", "nullable": false, "default": 0 },
        { "name": "note", "type": "string", "nullable": true }
      ]
    },
    "benchmarks": {
      "schemaVersion": 1,
      "storage": { "path": "snapshots/benchmarks.jsonl" },
      "rowShape": "positional",
      "keyColumns": ["model", "workload"],
      "columns": [
        { "name": "model", "type": "string", "nullable": false },
        { "name": "workload", "type": "string", "nullable": false },
        { "name": "score", "type": "float64", "nullable": false }
      ]
    }
  },
  "views": {
    "top_scores": {
      "schemaVersion": 1,
      "dependsOn": ["scores"],
      "query": "SELECT id, score FROM scores WHERE score >= 90"
    }
  }
}
```

Names match `^[a-z][a-z0-9_]{0,62}$`, are case-sensitive, and may not be `_audit`, `schema`, `manifest`, or `memories`. `memories` remains an internal built-in compatibility table backed by `MemorySchema`; it is not serialized into a namespace `schema.json` in v1. A generic DDL request naming a reserved name fails `409 RESERVED_RESOURCE`. Unknown top-level keys and unknown object fields fail validation: schema files are closed-world contracts, not an extensible bag of metadata.

`type` is one of `string`, `int64`, `float64`, `boolean`, `timestamp`, `json`, or `bytes`. `nullable` is required. `default`, when present, is a JSON literal validated against `type`; `null` is allowed only for nullable columns. Defaults are values, not SQL or JavaScript expressions. Each table has non-empty `columns`, unique column names, one existing `storage.path` relative to the namespace root ending in `.jsonl`, and `keyColumns` that are a non-empty unique subset of non-nullable columns. A table with no stable key is outside generic PATCH/DELETE and must not be declared through this v1 DDL surface.

### Normative v1 type representation

The declared type governs the JSONL representation, API representation, defaults, validation, and comparison input. There is no implicit string/number/boolean coercion anywhere in DDL, serializer validation, or generic REST. Object rows reject undeclared properties; positional rows require exactly the declared column count. A missing historical field is handled only by the pinned `null`/`default` compatibility adapter, never by a coercion.

| Declared type | On-disk JSONL and API representation | Validation and normalization |
|---|---|---|
| `string` | JSON string | any Unicode string; number, boolean, object, array, and null are rejected unless the column is nullable and the value is null |
| `int64` | canonical base-10 JSON string, for example `"9223372036854775807"` | must match `-?(0|[1-9][0-9]*)` and parse within signed 64-bit range; leading `+`, leading zeroes, exponent notation, JSON number values, and JS `number` inputs are rejected so precision never crosses the JavaScript safe-integer boundary |
| `float64` | JSON number | finite IEEE-754 number only; `NaN`, `Infinity`, `-Infinity`, string numerals, and integer/string coercion are rejected; `-0` is normalized to `0` on write |
| `boolean` | JSON `true` or `false` | only JSON booleans; strings such as `"true"`, and numeric `0`/`1`, are rejected |
| `timestamp` | canonical UTC JSON string `YYYY-MM-DDTHH:mm:ss.sssZ` | input must be an ISO-8601/RFC 3339 instant string with timezone; it is parsed and normalized to millisecond UTC form on write; date-only strings, local-time strings without an offset, and numeric epochs are rejected |
| `json` | any RFC 8259 JSON value, including object, array, string, number, boolean, or null | value is preserved structurally with no string parsing or coercion; JSON `null` is valid only when `nullable: true`, and v1 intentionally does not distinguish a JSON typed null from a nullable-column null |
| `bytes` | JSON string `base64url:<unpadded-base64url>` | prefix is required; payload uses URL-safe base64 without padding and decodes successfully; raw binary, standard padded base64, and arbitrary strings are rejected |

Defaults use the identical representation: an `int64` default is a canonical decimal string, a `timestamp` default is canonical UTC, and a `bytes` default carries `base64url:`. Key columns additionally forbid null, `json`, and `bytes`; their equality uses the canonical stored representation.

For `rowShape: "object"`, disk lines are JSON objects whose declared property names map to columns. For `rowShape: "positional"`, disk lines are JSON arrays whose index order is exactly the `columns` array; the columns array is the positional header contract consumed by SUPA-3. HTTP/API rows are objects in both cases. Positional insertion maps object values to the declared index order; it never guesses headers from a data line.

A view is read-only and declarative. `dependsOn` lists declared table/view names; `query` is a restricted DuckDB SELECT expression validated at declaration. It may reference only declared dependencies and their declared columns; no file-reading functions, DDL/DML, semicolon, parameter, external path, or undeclared table is permitted. A view definition does not materialize data or add a storage path.

### Contract: schema and manifest coexistence

| Artifact | Owner and contents | Update rule | Read use |
|---|---|---|---|
| `schema.json` | DB-SUPA-6 logical schema: tables, column contract, keys, row shape, storage path, views, document/table versions | planned `writeSchemaAtomic`: write same-directory unique temp file, fsync file and directory when durability mode requires it, rename; validation precedes replacement | schema loading, serializer validation, SUPA-3 resources/OpenAPI, SUPA-5 key/schemaVersion metadata |
| `manifest.json` | existing storage index: `partitions` and `lastUpdated` only (`src/storage/manifest.ts:16-21`) | existing `writeManifestAtomic` logic after data append; no schema fields added | partition discovery, DuckDB/legacy memory reads, `src/git/asof.ts` historical manifest traversal |

A table storage path is not automatically a manifest partition. On create-table, the DDL coordinator adds the table's parent partition path to `manifest.json` only if it conforms to the storage partition layout and only after its first data file exists; otherwise table readers use the declared storage path directly. This preserves manifest's meaning as an index of active physical partitions rather than duplicating an empty declared table. DDL never deletes or rebuilds manifest entries merely because a schema is re-declared.

### Contract: operations, fencing, and evolution

The planned DDL coordinator is `src/serialization/ddl.ts`. Its internal operations are `createTable`, `addColumn`, `retypeColumn`, `declareView`, and `redeclareView`. An HTTP/admin surface, if added, is owned by SUPA-3 routing and must use the same coordinator; direct file edits are unsupported production DDL. Each operation requires SUPA-4 `admin` for the namespace, obtains the namespace serializer lock, prevents new table writes, drains in-flight writes for that namespace, records a migration journal under `.duckbrain-ddl/<operation-id>.json`, performs data/schema work, atomically replaces `schema.json`, schedules one namespace git commit, then releases the fence. Existing `NamespaceWriter` lock/fencing behavior (`src/serialization/namespaceWriter.ts:706-850`) is the exclusion primitive; DDL must not invent a parallel cross-process lock.

`createTable` is idempotent only when an existing table declaration is byte-equivalent after canonicalization. Same name with any different contract is `409 TABLE_ALREADY_DECLARED`; callers must choose an explicit evolution operation. It creates no data row. `addColumn` accepts a new, unique column and one pinned backfill policy below. It increments that table's `schemaVersion` by one. `retypeColumn` accepts only the policy table below; it increments schema version and records both old and new declarations in the migration journal. DDL operation idempotency key is `Idempotency-Key`; same key plus same normalized request returns the original completed result, while same key plus different request returns `409 IDEMPOTENCY_CONFLICT`.

| Operation / condition | Allowed policy | Old-row read semantics | Physical rewrite |
|---|---|---|---|
| add nullable column without default | `null` | absent property/array cell reads as `null` | none |
| add column with a JSON-compatible default | `default` | absent property/array cell reads as declared default | none; new writes materialize the supplied/default value |
| add required column without default | rejected | none; return `400 BACKFILL_POLICY_REQUIRED` | none |
| add column requiring historical physical presence | `materialize` | rows read only after the schema switch points at a fully valid immutable generation | write a new versioned generation path; do not rename over the old path |
| retype `int64 -> float64`, `string -> json`, or `string -> timestamp` with validated conversion | `materialize` only | no mixed interpretation; old schema/path remains live until the single schema switch | write a new versioned generation path; do not rename over the old path |
| all other retypes, including lossy numeric narrowing, key-column retype, or row-shape change | rejected in v1 | none | none |

`null` and `default` are logical-read compatibility policies, not silent mutation. The table validator accepts absent old values only through the declared compatibility adapter, injects null/default into the API row, and rejects a new write that omits a newly non-nullable column. The raw JSONL line stays unchanged.

`materialize` has exactly one reader-visible switch: atomic replacement of `schema.json`. The coordinator (1) fences/drains the namespace and journals the old schema hash, old immutable `storage.path`, proposed schema hash, and a fresh immutable target such as `tables/scores/generations/<operation-id>.jsonl`; (2) writes, validates, and fsyncs the complete new generation at that **new path**, leaving the old generation untouched; (3) writes and validates a temporary full replacement schema whose table version and `storage.path` point to the new generation; and (4) atomically renames that temporary file over `schema.json`. Readers resolve a table path only from their fully parsed schema snapshot, so they see old schema + old path before step 4 and new schema + complete new path after step 4. There is no data-file rename over the old path and no second reader-visible metadata switch.

`manifest.json` cannot create an earlier visibility point. It is not consulted for declared-table path resolution; if a materialized path also needs a partition index entry, that manifest adjustment is written only after step 4 and is bookkeeping, not the table reader selector. The namespace git commit stages the old/new schema evidence, immutable generation, journal finalization, and any post-switch manifest adjustment together for history, but the git commit is not claimed to make prior filesystem writes atomic or to be the visibility switch. Only after a successful commit and a separately specified retention audit may a later maintenance operation garbage-collect an unreferenced old generation; the migration itself never deletes, truncates, or overwrites it.

A failed conversion before step 4 leaves the previous schema, previous immutable data generation, and manifest state live; recovery removes only the unpublished new generation or marks it failed. A crash after step 4 sees a valid new schema pointing to an already fsynced immutable generation; recovery verifies the journal hashes/path, finalizes the journal and commit, or fails closed for new generic-table operations if evidence is missing. It does not automatically roll schema back after the visibility switch, because that would create a second ambiguous switch. A concurrent write waits behind the DDL fence; it never writes into either old or new generation during migration.

### Behavioral acceptance criteria

- **AC-1 (persistent declaration and types):** GIVEN a valid v1 `schema.json` containing object and positional tables across every declared type, WHEN a fresh process loads the namespace, THEN it reconstructs the same declared validators, storage paths, keys, headers, canonical type representations, and table versions in `TableSchemaRegistry` without inferring a data line or coercing a value. **Checks:** `schema-registry.test.ts` / `"loads v1 object and positional declarations after restart"`; `schema-json.test.ts` / `"rejects unknown fields and invalid declarations"`; `schema-types.test.ts` / `"declared types use canonical JSONL and API representations"`.
- **AC-2 (schema/manifest separation):** GIVEN a namespace with both metadata files, WHEN a table is created, a row is written, and a partition is added, THEN `schema.json` contains only logical declarations, `manifest.json` remains only partitions plus `lastUpdated`, and historical manifest reading in `src/git/asof.ts` remains compatible. **Checks:** `ddl-manifest-contract.test.ts` / `"schema and manifest retain separate ownership"`; `asof-ddl-compat.test.ts` / `"historical manifest remains readable"`.
- **AC-3 (atomic authorized create):** GIVEN an admin and a non-admin principal, WHEN both attempt the same create-table request, THEN only the admin can create it; a retry with the same idempotency key and canonical request returns the original declaration, while a different declaration for that name is rejected without modifying either metadata file. **Checks:** `ddl-create.test.ts` / `"admin create is idempotent and conflicts are explicit"`; `ddl-auth.test.ts` / `"non-admin DDL is forbidden"`.
- **AC-4 (add-column compatibility):** GIVEN existing rows and an add-column request using `null` or `default`, WHEN current rows are read after the atomic schema replacement, THEN absent fields resolve to the pinned null/default value, new non-nullable writes require the column, and source JSONL is not rewritten. **Checks:** `ddl-evolution.test.ts` / `"null backfill is logical"`; `"default backfill is logical and new writes materialize"`.
- **AC-5 (single-switch materialized migration and recovery):** GIVEN a permitted add/materialize or retype/materialize operation, WHEN every new-generation row validates and the immutable generation is fsynced, THEN the only reader-visible switch is atomic `schema.json` replacement to that new path, the old generation remains untouched, and the table schema version increments; WHEN a process crashes before that switch, THEN old schema/path/data remain live and recovery removes or quarantines only the unpublished generation; WHEN it crashes after that switch, THEN recovery verifies the new path/hash and finalizes or fails closed without an automatic rollback or overwrite of the old generation. **Checks:** `ddl-migration.test.ts` / `"pre-switch crash preserves old schema and generation"`, `"schema switch exposes complete immutable generation"`, `"post-switch crash verifies and finalizes without rollback"`, `"conversion failure preserves old state"`.
- **AC-6 (serializer fencing and concurrency):** GIVEN a DDL operation in its drain/fence phase and a concurrent write from another process, WHEN the writer attempts to flush, THEN it waits or receives the defined retryable serializer result and writes neither source nor replacement data; after DDL completion, a new write validates against exactly one schema version. **Checks:** `ddl-concurrency.test.ts` / `"DDL fence excludes cross-process write"`, `"post-migration write uses new schema only"`.
- **AC-7 (view re-declaration):** GIVEN a declared view and dependents, WHEN a compatible re-declare changes only the validated query while retaining the same exposed column names/types, THEN its version increments and dependent views validate; WHEN it drops/changes an exposed column or introduces a cycle/undeclared dependency, THEN it is rejected without replacing `schema.json`. **Checks:** `ddl-views.test.ts` / `"compatible view redeclare increments version"`, `"dependency cycle and exposed-shape drift are rejected"`.
- **AC-8 (bounded inference removal):** GIVEN the migration window is active and an operator creates a table with `inferFrom` pointing to one existing JSONL file, WHEN inference succeeds, THEN the generated declaration is shown for confirmation and persisted once; after the configured deadline or first successful declaration, all generic reads use declared types/headers and per-query `read_json_auto` inference is rejected with a migration warning. **Checks:** `ddl-inference-compat.test.ts` / `"create-only inference requires confirmation"`, `"declared read never calls auto inference"`, `"expired compatibility window rejects inference"`.
- **AC-9 (strict value semantics):** GIVEN writes and defaults for every declared v1 type, WHEN values are serialized and read through the generic table path, THEN canonical `int64`, timestamp, and bytes forms round-trip without precision loss, JSON null follows the declared nullable rule, and noncanonical strings/numbers/booleans or implicit coercions are rejected before enqueue. **Checks:** `schema-types.test.ts` / `"int64 precision survives JavaScript boundary"`, `"timestamp and bytes normalize canonically"`, `"json null and nullable rule are explicit"`, `"no implicit primitive coercion"`.

## Edge Cases

- **Missing `schema.json`:** legacy namespaces remain usable by existing memory-specific routes. Generic SUPA-3 routes return `404 TABLE_NOT_FOUND` for undeclared resources rather than generating schemas from disk. The `memories` compatibility registry entry remains available exactly as in `src/serialization/registry.ts:15-17`.
- **Corrupt or half-written schema:** the loader keeps the last successfully validated in-memory snapshot for already open operations, refuses new generic table requests with `500 SCHEMA_INVALID`, and never treats a parse failure as an empty schema. Atomic temp-file rename prevents a normal writer from exposing partial JSON.
- **Manual edit while server runs:** a valid atomically replaced file reloads as a new declaration; an invalid manual edit fails closed. Manual edits bypass the journal and are unsupported for production migrations; operators must use the DDL coordinator for changes requiring a rewrite.
- **Schema switch versus git evidence:** `schema.json` atomic replacement is the only reader-visible migration switch; the old generation remains intact before and after it. The subsequent namespace git commit records evidence and enables historical inspection but cannot make earlier filesystem writes atomic. A crash pre-switch retains old visibility; post-switch recovery verifies immutable new-generation evidence and fails closed rather than manufacturing a second rollback switch.
- **Type boundaries:** `int64` is a canonical decimal string to avoid JavaScript precision loss; timestamp parsing always requires an offset and normalizes UTC; bytes require the `base64url:` envelope; and `json` null is allowed only for nullable columns. No parser converts `"1"` to a number, `1` to an `int64`, `"true"` to boolean, a date-only string to timestamp, or arbitrary string data to bytes.
- **Key semantics:** key columns cannot be nullable, defaulted via an unstable expression, removed, reordered for positional storage, or retyped in v1. Duplicate keys during a materialized rewrite abort the migration.
- **View query changes:** re-declaration requires explicit full replacement, not patching. A view has no automatic compatibility layer because consumers may depend on its columns.
- **`read_json_auto` compatibility window:** current raw-SQL/query-surface code uses `read_json_auto` with explicit all-VARCHAR columns for the legacy `memories` view (`src/duckdb/query-surface.ts:23-35, 403-421`). DB-SUPA-6 does not remove that memory-specific safety override immediately. For generic declared tables, it is prohibited on day one. The compatibility window is two minor releases or 90 days after DB-SUPA-6 ships, whichever is later, with one startup warning per undeclared generic-file access and a counter `duckbrain_schema_inference_compat_total`. At expiry, generic inferred reads fail `409 SCHEMA_DECLARATION_REQUIRED`; no silent extension is allowed.

## Non-Goals

- No SQL `CREATE TABLE`, arbitrary `ALTER TABLE`, stored procedures, migrations imported from another database, or per-query schema inference.
- No replacement of `manifest.json`; it remains a physical partition index with its existing atomic writer.
- No generic tables without stable keys in v1, no rename/drop-column/drop-table operation, no key migration, and no row-shape conversion between object and positional layouts.
- No automatic repair of malformed JSONL, duplicate keys, or manually corrupted migration journals.
- No complete DuckDB type system, SQL defaults, computed columns, foreign keys, triggers, indexes, or transaction semantics beyond the stated namespace DDL fence.
- No implementation claim for `src/serialization/schemaRegistry.ts`, `ddl.ts`, or generic DDL HTTP routes; these are planned modules named for the build.

## Dependencies

- **DB-SUPA-2 serialization — required.** `NamespaceWriter` owns validation, locking, ordered writes, accepted audit rows, and commit scheduling (`src/serialization/namespaceWriter.ts:584-634, 670-850`). DB-SUPA-6 extends the registry; it does not bypass the writer.
- **DB-SUPA-3 REST — consumer.** Its generic routes, OpenAPI generation, positional object mapping, key-gated PATCH/DELETE, and view resources consume these declarations (`docs/specs/SUPA-3-rest.md:17-67, 106-112`). No correction to that interface is needed.
- **DB-SUPA-4 auth — required.** DDL is namespace-admin-only; generic table reads/writes continue to use table grants.
- **DB-SUPA-1 durability — required for materialized rewrites.** File and directory barriers follow its selected namespace mode before schema visibility is swapped.
- **DB-SUPA-5 realtime — consumer.** Realtime reads `key` and `schemaVersion` from the durable declaration and publishes only committed change records.
- **Existing source touchpoints, all planned changes:** `src/serialization/registry.ts` (persistent loader/register seam), `src/serialization/types.ts` (`targetPath` and `partitionPath` carry physical targets), `src/storage/manifest.ts` (unchanged manifest owner), `src/git/asof.ts` (historical manifest reader), `src/duckdb/query-surface.ts` (bounded legacy inference removal), `src/http/middleware/errorHandler.ts` (structured errors), and `src/config/index.ts` (compatibility deadline and migration settings).

## Test Plan

All listed suites are planned Vitest suites run by `pnpm test`; no test file is created by this documentation change.

| Suite and named check | Acceptance criteria |
|---|---|
| `src/serialization/schema-json.test.ts` — `rejects unknown fields and invalid declarations` | AC-1 |
| `src/serialization/schema-registry.test.ts` — `loads v1 object and positional declarations after restart` | AC-1 |
| `src/serialization/schema-types.test.ts` — `declared types use canonical JSONL and API representations`; `int64 precision survives JavaScript boundary`; `timestamp and bytes normalize canonically`; `json null and nullable rule are explicit`; `no implicit primitive coercion` | AC-1, AC-9 |
| `src/serialization/ddl-manifest-contract.test.ts` — `schema and manifest retain separate ownership` | AC-2 |
| `src/git/asof-ddl-compat.test.ts` — `historical manifest remains readable` | AC-2 |
| `src/serialization/ddl-create.test.ts` — `admin create is idempotent and conflicts are explicit` | AC-3 |
| `src/serialization/ddl-auth.test.ts` — `non-admin DDL is forbidden` | AC-3 |
| `src/serialization/ddl-evolution.test.ts` — `null backfill is logical`; `default backfill is logical and new writes materialize` | AC-4 |
| `src/serialization/ddl-migration.test.ts` — `pre-switch crash preserves old schema and generation`; `schema switch exposes complete immutable generation`; `post-switch crash verifies and finalizes without rollback`; `conversion failure preserves old state` | AC-5 |
| `src/serialization/ddl-concurrency.test.ts` — `DDL fence excludes cross-process write`; `post-migration write uses new schema only` | AC-6 |
| `src/serialization/ddl-views.test.ts` — `compatible view redeclare increments version`; `dependency cycle and exposed-shape drift are rejected` | AC-7 |
| `src/serialization/ddl-inference-compat.test.ts` — `create-only inference requires confirmation`; `declared read never calls auto inference`; `expired compatibility window rejects inference` | AC-8 |

The migration tests must use a real temporary namespace git repository, restart a new process after every crash point, and inspect schema plus both immutable generations. They must prove that a crash before the `schema.json` switch leaves the old schema/path/generation readable, while a crash after it finds the new path complete and verifies/finalizes without rolling back. They must also verify `git show HEAD:schema.json` plus the selected generation after the evidence commit. A unit-only Zod test cannot prove the required single-switch filesystem and recovery ordering.
