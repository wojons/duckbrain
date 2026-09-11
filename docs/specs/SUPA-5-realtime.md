# SUPA-5 — Realtime Change Feed: Committed Append-Log SSE

- **Board row:** DB-SUPA-5 (P1, complexity 2)
- **Spec row:** DB-SUPA-10 (SPEC SET B)
- **Status:** pending implementation — contract for the build
- **Companion specs:** `docs/specs/SUPA-1-write-durability.md`, `docs/specs/SUPA-2-serialization.md`, `docs/specs/SUPA-3-rest.md`, and `docs/specs/SUPA-4-auth.md`

## Problem Statement

DuckBrain has an SSE connection scaffold, not a durable change feed. `createEventsRoutes` in `src/http/routes/events.ts:12-138` keeps a process-local `Map<string, Response[]>`, sends an unversioned `connected` payload, broadcasts caller-supplied data, and explicitly says write publishing remains future work (`:4-6`, `:76-80`). It has no table filter, authorization filter, resume cursor, replay store, bounded queue, or coupling to a successful serializer flush. It must not be represented as DB-SUPA-5 implementation.

The serializer already provides an ordering seam but not a durable cursor. `WriteOperation` is `insert | update | delete` and `WriteRequest` carries namespace, table, operation, row image, principal, and `seq` (`src/serialization/types.ts:3-18`). `NamespaceWriter` assigns `seq` while enqueueing (`src/serialization/namespaceWriter.ts:491-506`), sorts a flush batch by `seq` (`:670-680`), appends data then accepted audit rows (`:763-799`), schedules a namespace git commit (`:801-809`), and returns the accepted sequence (`:811-813`). That `seq` is process-local and resets after restart; it is neither an external cursor nor evidence that a namespace-git commit exists.

DB-SUPA-5 supplies one additive, committed-only change feed. The namespace append/audit log is the changelog; there is no broker, global event database, or best-effort process-memory history. Version 1 is SSE. WebSocket is deferred because the stated requirements are server-to-client ordered notifications and resumable replay, both served by SSE with ordinary HTTP auth, proxy behavior, and `Last-Event-ID` support. A future WebSocket transport may consume the same committed event records and cursor contract only after a separate compatibility decision.

## Acceptance Criteria

### Contract: committed change record and wire event

The implementation extends the accepted audit record written through `src/serialization/audit.ts` and `NamespaceWriter`; it does not treat the current untyped `/api/events/:namespace/broadcast` body as a change record. For each accepted write, the serializer appends one canonical change record to `_audit/current.jsonl` after the data append, in the same namespace flush. The existing data JSONL and its append order remain authoritative; `_audit` is the indexed changelog projection needed to preserve `op`, table, row image, and sequence metadata. A change becomes externally replayable only when the namespace repository contains a commit that includes both its data row and its corresponding accepted audit row.

The SSE data payload is a JSON object with this versioned schema. All field names are lower camel case. Unknown fields must be ignored by v1 consumers; required fields may not be omitted.

| Field | Required | Type and rule |
|---|---:|---|
| `version` | yes | integer literal `1` |
| `cursor` | yes | opaque restart-safe cursor defined below; also sent as SSE `id` |
| `namespace` | yes | namespace name, equal to the route `:ns` |
| `table` | yes | declared table name, including `memories` |
| `op` | yes | `insert`, `update`, or `delete` copied from `WriteRequest.op` |
| `row` | yes | post-operation row image for insert/update; tombstone row image for delete |
| `position` | yes | `{ commit: <40-hex SHA>, ordinal: <positive integer> }`; `ordinal` is the one-based ordered accepted-audit-record index within that commit |
| `committedAt` | yes | ISO-8601 time when the containing namespace commit was created, not client time |
| `tombstone` | yes | `true` only for `delete`; `false` otherwise |
| `schemaVersion` | yes | positive integer copied from the declared table entry in `schema.json`; `1` for the built-in `memories` compatibility entry |
| `key` | yes | object containing every declared key column and value; for `memories`, `{ "id": <id> }` |
| `transaction` | no | reserved opaque batch identifier; absent in v1 because SUPA-2 has only per-table batch atomicity |

A delete is never represented as `row: null`: consumers need a deterministic identity and enough tombstone context to invalidate local state. Its `row` is the tombstone record actually appended, `tombstone` is `true`, and `key` contains the declared key columns. A serializer request for a delete that lacks all declared key columns fails validation before enqueue; it cannot generate an unaddressable deletion event.

### Contract: route, grammar, authorization, and transport decision

The planned module is `src/http/routes/realtime.ts`, exported from `src/http/routes/index.ts` and mounted by `createHttpServer` in `src/cli/http.ts` after the existing auth middleware and before `errorHandler`. The current `/api/events/:namespace` route remains legacy during a documented deprecation window but is not the DB-SUPA-5 contract and must not publish DB-SUPA-5 records.

`GET /api/ns/:ns/changes` is the only v1 subscription route. It requires the SUPA-4 namespace grant plus `tables.read` on every selected table. Its query grammar is deliberately small:

| Parameter | Grammar | Semantics |
|---|---|---|
| `tables` | absent, or comma-separated declared table names | absent means every table the principal may read; present selects an allow-list, duplicates are rejected, and an unauthorized or unknown table makes the whole request fail without revealing a partial stream |
| `ops` | absent, or comma-separated subset of `insert,update,delete` | absent means all three; duplicate or unknown token is `400 INVALID_SUBSCRIPTION` |
| `cursor` | one opaque cursor | resume after that committed event; mutually exclusive with a non-identical `Last-Event-ID` |

A successful response is `200 text/event-stream` with `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, and `X-Accel-Buffering: no`. Each change uses `event: duckbrain.change.v1`, `id: <cursor>`, and one `data: <JSON>` line. A successful connection first emits `event: duckbrain.ready.v1` with `{ "version": 1, "namespace": "...", "head": <latest committed cursor or null> }`; that control event is not a data change and has no SSE id. The server emits a comment heartbeat `: heartbeat` every 15 seconds.

WebSocket is **not in v1**. The implementation must not add a WebSocket route, dependency, or dual protocol. A later proposal must prove a client-to-server requirement or materially lower replay/fan-out cost while preserving the exact event JSON and cursor semantics above.

### Contract: cursor, ordering, delivery, and replay

A cursor is opaque ASCII in the form `dbch1.<base64url(payload)>.<mac>`, where the payload contains `{ v:1, ns, commit, ordinal }` and `mac` is an HMAC generated with a server secret. Clients store and replay it verbatim; they must not parse or construct it. The server rejects malformed, bad-MAC, wrong-version, wrong-namespace, or impossible ordinal cursors with `400 INVALID_CURSOR`. A cursor never contains a serializer `seq`.

For a committed namespace revision, the server derives records by reading `_audit/current.jsonl` and required data files at that git ref without checkout, following the established `git show <ref>:<path>` approach in `src/git/asof.ts:171-257`. The committed position is `(commit SHA, ordinal)`. Across commits, order is first-parent namespace git history oldest-to-newest; within a commit it is accepted-audit append order. This defines a total order **within one namespace subscription** only. It makes no ordering claim across namespaces, processes before lock fencing, or a client-issued request order that has not reached the serializer.

No uncommitted accepted write is delivered as a change event. Before the namespace commit, it is an internal pending append with a process-local `seq`; it has no externally resumable cursor and is invisible to subscribers. The ready control event may report the latest committed head only. This intentionally trades immediate process-local notification for restart-safe semantics: every emitted change has `position.commit`, and every reconnect can replay it after process restart. Metrics may count pending writes but must never expose them as `durable`, `committed`, or a cursor.

Delivery is at-least-once. On reconnect, a supplied cursor resumes strictly after that cursor; a disconnect after the server wrote bytes but before the client persisted the id may yield a duplicate. Consumers deduplicate by `cursor` (or `position.commit` plus `position.ordinal`) and apply rows idempotently by declared key. The service does not promise exactly-once delivery, global ordering, or delivery after a client loses its cursor.

### Behavioral acceptance criteria

- **AC-1 (v1 wire shape):** GIVEN an authorized subscriber and a committed insert, update, and delete for one declared table, WHEN it reads the three `duckbrain.change.v1` events, THEN every payload validates against the required v1 schema, each event has an SSE id equal to `cursor`, and the delete contains a tombstone row plus declared key rather than `row: null`. **Checks:** `realtime-wire.test.ts` / `"v1 event schema and tombstone row image"`; `realtime-e2e.test.ts` / `"insert update delete stream"`.
- **AC-2 (SSE-only route and grammar):** GIVEN a v1 server, WHEN a client opens `/api/ns/nsA/changes` with valid `tables`, `ops`, and optional cursor grammar, THEN it receives SSE and the requested subset; WHEN it uses an unknown, duplicate, or malformed token, THEN it receives `400 INVALID_SUBSCRIPTION`; and no WebSocket endpoint exists. **Checks:** `realtime-routes.test.ts` / `"strict subscription grammar"`, `"SSE is the sole v1 transport"`.
- **AC-3 (committed cursor, not sequence):** GIVEN a write accepted by `NamespaceWriter` with a process-local `seq`, WHEN the debounce commit has not yet happened, THEN no change event is emitted and no resumable cursor exists; WHEN the namespace commit including data and accepted audit row completes, THEN the emitted cursor resolves to that commit SHA and positive intra-commit ordinal after a fresh process start. **Checks:** `realtime-cursor.test.ts` / `"does not publish pre-commit sequence"`, `"cursor replays after process restart"`.
- **AC-4 (namespace ordering and at-least-once):** GIVEN two committed changes in one namespace and two independently connected authorized clients, WHEN both subscribe before the changes and one reconnects using the first event id, THEN each live client observes the same commit/ordinal order, and the reconnect receives the second event (with duplicate first-event delivery permitted only if it resumes from an earlier persisted cursor). **Checks:** `realtime-e2e.test.ts` / `"two clients receive identical ordered positions"`, `"reconnect is at-least-once"`.
- **AC-5 (row and authorization filtering):** GIVEN a principal allowed to read only `tableA`, WHEN it subscribes without `tables`, THEN it receives only `tableA` changes; WHEN it requests `tableB` or a mixed authorized/unauthorized list, THEN the request is denied before replay and leaks no `tableB` event, key, cursor, count, or history boundary. **Checks:** `realtime-auth.test.ts` / `"implicit table filter"`, `"explicit unauthorized table is all-or-nothing"`.
- **AC-6 (bounded fan-out and liveness):** GIVEN a subscriber that stops draining and another that continues draining, WHEN the slow subscriber exceeds the configured event or byte queue bound, THEN only that subscriber receives `duckbrain.overflow.v1` containing its last delivered cursor and the connection closes; the healthy subscriber continues in order, heartbeats continue every 15 seconds, and request close removes timer and queue state. **Checks:** `realtime-fanout.test.ts` / `"slow subscriber overflow is isolated"`, `"heartbeat and close cleanup"`.
- **AC-7 (replay boundaries):** GIVEN a valid cursor within retained history, WHEN a subscriber reconnects, THEN replay starts strictly after it and ends before live delivery begins with no gap in committed positions; GIVEN a cursor older than the configured retained history or whose referenced commit is pruned, WHEN it reconnects, THEN the initial request returns `410 CHANGE_CURSOR_GONE` with no partial SSE body and a documented full-resync instruction. **Checks:** `realtime-replay.test.ts` / `"strictly-after replay boundary"`, `"pruned history returns 410"`.

## Edge Cases

- **Commit race:** the broadcaster may inspect only commits reachable from namespace `HEAD`; it must re-read `HEAD` after subscribing to avoid missing a commit between replay and live registration. The implementation uses a per-namespace feed lock: capture `HEAD`, register subscriber, replay through that head, then deliver later heads in order.
- **Audit/data mismatch:** a commit that lacks either the accepted audit row or its referenced data row is corrupt for realtime purposes. Do not invent an event from the data line. Stop that subscription with `500 CHANGELOG_CORRUPT`, log commit/path/ordinal, and require repair; a later commit must not silently skip the bad position.
- **Git commit failure:** `src/git/autocommit.ts:64-124` is currently best-effort and logs a failure. The realtime implementation therefore polls/observes successful reachable `HEAD` movement, not timer execution. A failed commit leaves writes pending and unpublished; this is deliberately observable in metrics and health, not a live event.
- **New namespace first write:** current `commitNamespaceWithParams` synchronously initializes and commits a first namespace write (`src/git/autocommit.ts:144-155`). The change feed may publish only after that resulting commit is readable.
- **Authorization changes during an open stream:** authorize at connection, on every replayed event, and before every live enqueue. A revoked grant ends the stream with `event: duckbrain.revoked.v1` then close; it never continues to leak queued rows.
- **Subscriber limits:** default limits are 100 subscribers per process, 256 queued events and 1 MiB queued payload bytes per subscriber, maximum replay 10,000 events or seven days of first-parent commits, whichever is reached first. Reaching a limit is a specified overflow or `410`, not a memory-growth exception. Configuration is a planned `realtime` block in `DuckBrainConfigSchema`.
- **Row images and PII:** authorization is applied before serialization to a subscriber queue. A change record may be retained in namespace git history for authorized auditors, but row-image redaction is not a v1 feature; table access is the boundary.
- **Legacy events route:** existing `/api/events/:namespace`, its broadcast POST, and stats endpoint are not a compatible resume protocol. They may coexist temporarily but must be marked legacy and cannot share active-connection state with the planned change feed.

## Non-Goals

- No WebSocket, Supabase Realtime protocol, Phoenix channels, client broadcast, presence, or client-to-client messaging in v1.
- No exactly-once delivery, cross-namespace transaction ordering, global sequence number, or guarantee that a write becomes visible before its namespace git commit.
- No separate Kafka/Redis/NATS/event-store dependency; the committed namespace append/audit log is the changelog.
- No best-effort replay from process memory after restart; if a cursor cannot be resolved from committed history, the answer is `410 CHANGE_CURSOR_GONE` and full resync.
- No new row-level security model; this feed consumes SUPA-4 namespace/table grants and does not weaken them.
- No promise that the current `src/http/routes/events.ts` scaffold already provides this contract.

## Dependencies

- **DB-SUPA-2 serialization — required.** The feed consumes `WriteRequest`, ordered accepted audit records, flush fencing, and the per-namespace writer. Its pre-commit `seq` remains internal; the feed must not expose it as a cursor.
- **Namespace git commits — required.** `src/git/autocommit.ts:6-15` distinguishes immediate working-tree writes from debounced history. DB-SUPA-5 needs an observable successful commit boundary and a first-parent traversal helper; the existing `src/git/asof.ts:111-257` proves ref resolution and no-checkout reads but only knows memory manifests today.
- **DB-SUPA-4 auth — required.** `tables.read` and namespace grants gate subscription, replay, and live delivery. The middleware order in `createHttpServer` (`src/cli/http.ts:261-359`) must remain auth before routes.
- **DB-SUPA-6 declared DDL — required for generic tables.** It supplies table keys and schema versions. `memories` may use the built-in compatibility key `id` while generic table changes wait for declared schemas.
- **Existing source touchpoints, all planned changes:** `src/http/routes/events.ts` and `events.test.ts` (legacy behavior to isolate), `src/http/routes/index.ts` (new route export), `src/cli/http.ts` (mount), `src/serialization/audit.ts` (enriched committed change record), `src/serialization/namespaceWriter.ts` (post-commit notifier seam), `src/git/asof.ts` (generic committed-log reader), and `src/config/index.ts` (bounded feed configuration).

## Test Plan

All planned suites run through `pnpm test`; these are proposed tests, not current files.

| Suite and named check | Acceptance criteria |
|---|---|
| `src/http/routes/realtime-wire.test.ts` — `v1 event schema and tombstone row image` | AC-1 |
| `src/http/routes/realtime-routes.test.ts` — `strict subscription grammar`; `SSE is the sole v1 transport` | AC-2 |
| `src/http/routes/realtime-cursor.test.ts` — `does not publish pre-commit sequence`; `cursor replays after process restart` | AC-3 |
| `src/http/routes/realtime-e2e.test.ts` — `insert update delete stream`; `two clients receive identical ordered positions`; `reconnect is at-least-once` | AC-1, AC-4 |
| `src/http/routes/realtime-auth.test.ts` — `implicit table filter`; `explicit unauthorized table is all-or-nothing` | AC-5 |
| `src/http/routes/realtime-fanout.test.ts` — `slow subscriber overflow is isolated`; `heartbeat and close cleanup` | AC-6 |
| `src/http/routes/realtime-replay.test.ts` — `strictly-after replay boundary`; `pruned history returns 410` | AC-7 |
| Existing `src/http/routes/events.test.ts` revised as `legacy events route remains isolated` | Regression proof that current broadcast scaffolding is not accidentally treated as the committed feed |

The E2E fixture must run two actual HTTP SSE clients against one server, write through `NamespaceWriter`, force a namespace commit, collect both streams, restart the server, and resume from the captured first event id. It must also exercise a deliberately slow response sink so queue bounds are verified rather than inferred from unit spies.
