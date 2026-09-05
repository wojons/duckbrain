# SUPA-2 — Serialization Layer: Per-Schema Single-Writer, Fan-In Queue, No Lost Updates

- **Board row:** DB-SUPA-2 (P0, complexity 4)
- **Spec row:** DB-SUPA-9 (SPEC SET A)
- **Status:** pending implementation — contract for the build
- **Reference:** mallard-prd-v14.html §04·B rule 4 (single-writer preserved); 2026-09-03 owner directive (server-owned serialization for multi-user/multi-role writes)
- **Companion specs:** `docs/specs/SUPA-1-write-durability.md` (durability barrier on flush), `docs/specs/SUPA-4-auth.md` (role checks before enqueue), `docs/specs/SUPA-3-rest.md` (primary fan-in consumer)

## Problem Statement

DuckBrain serializes nothing today. The only mutex in the process is `GitQueue`'s `async-mutex Mutex` (`src/git/queue.ts:5`, field at `src/git/queue.ts:20`), which protects the *git operation queue* — not the filesystem appends. Every writer calls `appendToJsonl` (`src/storage/jsonl.ts:136`) directly, and `fs.appendFileSync` (`src/storage/jsonl.ts:182`) is not atomic across processes or interleaving-safe across concurrent async writers within one process: two in-flight writes can interleave at the syscall boundary, and two server processes sharing a `namespacesPath` can produce torn or reordered lines. That is acceptable for single-process cron agents and unacceptable for an API serving many writers (SUPA-3) behind multiple roles (SUPA-4).

The fix is a serialization layer that owns **all** filesystem writes: per-namespace (per-schema) single-writer queues in-process, a cross-process lock file with dead-pid recovery and fencing, validate-at-append against per-table Zod schemas, WAL-first ordering in fsync/direct mode (SUPA-1), debounced git commits, role checks before enqueue (SUPA-4), and an audit row per accepted write. Correctness comes from ordering every write through one writer per namespace — the model already proven at 135-namespace fleet scale. Multi-writer across processes to the same namespace remains mutually exclusive, never concurrent.

## Acceptance Criteria

### Contract: modules and types

New directory `src/serialization/`:

- `src/serialization/types.ts` — `WriteRequest { ns, table, op: "insert" | "update" | "delete", record: unknown, principal: AuthPrincipal | undefined, seq: number }`, `WriteResult { seq, ok: true } | { seq, ok: false, code: string, message: string }`, `FencingToken = string`.
- `src/serialization/registry.ts` — `TableSchemaRegistry`: `register(ns, table, schema: ZodType)`, `get(ns, table): ZodType | undefined`. Ships with a built-in `("memories", MemorySchema)` entry per namespace (`MemorySchema`, `src/schema/memory.ts:50`), so SUPA-2 is usable before DB-SUPA-6 lands. Table names are the registry key; arbitrary tables register through the DB-SUPA-6 declared-DDL flow.
- `src/serialization/namespaceWriter.ts` — `NamespaceWriter` class, one live instance per namespace (module-level `Map<ns, NamespaceWriter>`), with `enqueue(req): Promise<WriteResult>` and `flush(): Promise<void>`. Enqueue assigns a monotonic `seq` under the writer's own in-process mutex; flush executes appends strictly in `seq` order.
- `src/serialization/lock.ts` — cross-process namespace write lock, `acquireNamespaceWriteLock(namespacesPath, ns): { token } | null`, `releaseNamespaceWriteLock(...)`, `tokenStillCurrent(...)`. Extends the dead-pid lock pattern of `acquireLock` (`src/s3/sync.ts:164-195`, stale constant `LOCK_STALE_MS` at `src/s3/sync.ts:161`) and `isPidAlive` (`src/utils/pidfile.ts:33`).
- `src/serialization/audit.ts` — `appendAuditRow(ns, entry)` enqueued on the namespace's own writer.

**Lock file:** `<namespacesPath>/.duckbrain-write/<ns>.lock`, content `{ pid, ts, nonce }` written via `fs.openSync(lockPath, "wx")` (atomic create — exactly one process can win). Placed outside each namespace's git repo (mirroring `.s3state` at the `namespacesPath` root, `src/s3/sync.ts:165`), so `autocommit`'s `git add -A` (`src/git/autocommit.ts:95`) can never stage lock state. Break rules, identical in spirit to `src/s3/sync.ts:170-190`:

1. Lock owner pid is a non-positive/non-integer or unparseable → busy until `LOCK_STALE_MS` elapses.
2. Owner pid dead (`!isPidAlive`) → unlink immediately, retry acquire.
3. Lock older than `LOCK_STALE_MS` (10 min) regardless of pid liveness → unlink, retry acquire. The fencing token makes this safe: the preempted writer's next flush fails its token check and stops writing instead of interleaving.
4. `nonce` is a random 128-bit hex string; the acquire winner's token is the nonce.

**Lock lifecycle:** a `NamespaceWriter` holds the cross-process lock only around each flush batch (acquire → drain queue → append with durability barrier → release), never across idle time. In-process fan-in needs no lock; the cross-process lock exists solely to exclude a second server process from the same namespace.

**Fan-in queue bounds** — configurable block in `DuckBrainConfigSchema` (`src/config/index.ts:7`):

```ts
serialization: z
  .object({
    maxPendingRows: z.number().int().positive().default(10_000),
    maxPendingBytes: z.number().int().positive().default(32 * 1024 * 1024),
  })
  .default({ maxPendingRows: 10_000, maxPendingBytes: 32 * 1024 * 1024 }),
```

When either bound is reached, `enqueue` returns `503 SERIALIZER_QUEUE_FULL` with `Retry-After: 1`; nothing is written, nothing is dropped.

**Stale-writer detection:** every flush validates (a) the writer still owns its fencing token (`tokenStillCurrent` re-reads the lock file) and (b) the enqueued principal is still authorized (re-check per SUPA-4 before each flush batch, not only at enqueue). A writer whose token was broken by rule 3 refuses to flush, returns `503 SERIALIZER_FENCED` for in-flight requests, logs `[serialization] fenced writer for ns <ns>`, and stops enqueueing until the process restarts or the operator clears the writer state.

**Validate-at-append:** `enqueue` runs `registry.get(ns, table).safeParse(record)` synchronously **before** the request enters the queue. Failure maps to the existing `ValidationError` envelope (`src/http/middleware/errorHandler.ts:42-50`, field map per `formatZodErrors` at `:55-64`): `400 VALIDATION_ERROR` with `fields`. Nothing invalid is ever enqueued.

**WAL-first ordering in fsync/direct mode (SUPA-1):** the write pipeline is pinned in this order:

1. Role check (SUPA-4) — 403 before anything is enqueued; denial audit row appended.
2. Schema validation (registry) — 400 before enqueue.
3. Enqueue with monotonic `seq`.
4. Flush: append the record line to the table's JSONL; in fsync/direct mode the SUPA-1 durability barrier (`fdatasync` file + `fsync` dir when a file/dir was created, `docs/specs/SUPA-1-write-durability.md`) runs **before** the waiter promises resolve.
5. Audit row enqueued and flushed behind the data row (same queue, same order).
6. Debounced git commit timer reset for the namespace (existing `gitBatching` machinery, `src/git/autocommit.ts`).

The JSONL append **is** the WAL: no derived state (DuckDB materialization, embedding index) is ever updated before the record is durably in the JSONL, and any derived store replays from the JSONL. There is no second log artifact to get out of order.

**Debounce-commit:** flush schedules the existing per-namespace debounced commit (`commitNamespaceWithParams`, `src/git/autocommit.ts:133`), unchanged cadence. Graceful shutdown drains every `NamespaceWriter` queue before the pending-commit flush (`flushAllCommits`, `src/git/autocommit.ts:195`) runs.

### Behavioral acceptance criteria

- **AC-1 (concurrent writers, no torn lines):** GIVEN M fixture namespaces and N concurrent HTTP writers (N ≥ 32) posting to randomly chosen namespaces through the API, WHEN all requests settle, THEN every touched JSONL file parses line-by-line (`JSON.parse` per non-empty line) with zero interleaved/torn lines, and the total row count equals the number of 2xx responses.
- **AC-2 (zero lost acked writes):** GIVEN an fsync-mode namespace (SUPA-1) under the same N-writer load, WHEN a request returns 2xx, THEN the record is present in the namespace JSONL when re-read from disk after a full process restart (restart-replay).
- **AC-3 (deterministic per-namespace order):** GIVEN two writes to the same namespace issued sequentially by one client, WHEN both ack, THEN the file order equals the issue order; under concurrency, file order equals `seq` order assigned at enqueue.
- **AC-4 (two-writer kill -9, no lost update):** GIVEN two child server processes sharing one `namespacesPath` and distinct API keys, both writing namespace `nsX` (the second receives `503 SERIALIZER_LOCKED` while the first holds a flush lock), WHEN the first child is killed with `SIGKILL` mid-flush and the second retries, THEN the second acquires via the dead-pid break (rule 2), its writes land, and restart-replay shows every row acked by the first child plus every row acked by the second — none lost, file clean.
- **AC-5 (fencing at commit):** GIVEN writer A whose lock is broken by rule 3 (stale, live pid) after writer B acquires, WHEN A's next flush runs, THEN A's `tokenStillCurrent` check fails, A refuses to write, returns `503 SERIALIZER_FENCED`, and no row from A lands at or after B's acquisition point.
- **AC-6 (role check before enqueue):** GIVEN a principal without table-write grant (SUPA-4 matrix) posting to a table, WHEN the request arrives, THEN `403 FORBIDDEN` is returned, the namespace queue length is unchanged (never enqueued), and a denial audit row is appended.
- **AC-7 (queue bounds):** GIVEN a namespace queue at `maxPendingRows` (or `maxPendingBytes`), WHEN another write is enqueued, THEN `503 SERIALIZER_QUEUE_FULL` with `Retry-After: 1` is returned; no row written, no crash, queue intact.
- **AC-8 (validate at append, batch atomicity):** GIVEN a request whose record fails the table's registered Zod schema, WHEN processed, THEN `400 VALIDATION_ERROR` with a `fields` map is returned and the queue is untouched; for an NDJSON batch (SUPA-3) containing one invalid row, the whole batch is refused — no partial batch is ever enqueued because all rows validate before any row enters the queue.
- **AC-9 (audit row per accepted write):** GIVEN any accepted write, WHEN its ack resolves, THEN an `_audit` row (same namespace, same queue) with matching `seq` and `outcome: "accepted"` is present in the namespace's audit table.
- **AC-10 (cross-process exclusion):** GIVEN a second server process writing a namespace whose lock is held by a live first process, WHEN the second attempts a flush, THEN it receives `503 SERIALIZER_LOCKED` and writes nothing; it never queues across the process boundary.

## Edge Cases

- **Lock file corrupt (unparseable):** owner cannot be verified → treated as busy until `LOCK_STALE_MS` elapses, then broken (rule 1/3 semantics, matching `src/s3/sync.ts:191-193`).
- **PID reuse:** a recycled pid can make a dead owner look alive; the 10-minute stale rule is the backstop, and the fencing token prevents any write from a wrongly-preempted live writer.
- **Namespace deleted mid-flight:** a queued write for a namespace removed by `deleteNamespace` (`src/namespaces/delete.ts`) fails with `404 NOT_FOUND`; the writer never recreates the namespace directory.
- **Kill between data append and audit append:** the data row is durable (or page-cached in buffered mode) but its audit row may be lost. Documented crash window; no reconciliation pass in this row. Data loss never occurs — only audit tail loss, bounded by the crash.
- **Audit writes must not be starved or rejected by queue bounds:** audit appends ride the same flush batch but are tracked in a separate internal counter so `maxPendingRows`/`maxPendingBytes` pressure on data writes cannot suppress audit rows.
- **Shutdown race:** once drain begins, new `enqueue` calls return `503 SERVER_SHUTTING_DOWN`; in-flight waiters resolve from the drain.
- **Two processes racing acquire:** `openSync("wx")` is atomic — exactly one winner; the loser returns null → `503 SERIALIZER_LOCKED`.
- **Fenced writer with in-flight requests:** all in-flight waiters fail with `503 SERIALIZER_FENCED`; the process logs and refuses further enqueues for that namespace (operator restarts the writer or clears state).
- **Chunk rotation under concurrency:** rotation (`getNextChunkName`, `src/storage/jsonl.ts:100-118`) runs only inside the single-writer flush, so two writers can never pick the same chunk name in one process; cross-process exclusion is the lock.

## Non-Goals

- **Lock-free multi-master.** Correctness comes from ordering through one writer per namespace; concurrent cross-process writers to the same namespace are excluded, not reconciled.
- No multi-namespace transactions: a batch is atomic within one table of one namespace only.
- No out-of-order execution, priorities, or preemption inside a queue.
- No reconciliation of audit rows lost in a crash window.
- No changes to the git operation queue (`GitQueue`, `src/git/queue.ts`) or to commit cadence; the serializer owns JSONL writes, `GitQueue`/`autocommit` keep owning git operations.
- No schema definition/evolution — per-table Zod schemas for non-memory tables are registered by DB-SUPA-6; this row ships the registry, the validation call site, and the built-in `memories` entry.

## Dependencies

- **DB-SUPA-1 (write durability)** — the flush barrier: fsync/direct mode namespaces fsync before waiter promises resolve; buffered mode keeps today's page-cache semantics. The serializer is the only permitted caller of `appendJsonlDurable`/`appendJsonlDirect` (`docs/specs/SUPA-1-write-durability.md`).
- **DB-SUPA-4 (roles + auth)** — role and per-table grant checks run before enqueue (AC-6); denial audit rows are written through this same serializer. Consumed, not provided: SUPA-2 does not define grants.
- **DB-SUPA-3 (REST)** — the generic table routes are the primary many-writer fan-in source and must enqueue through `NamespaceWriter`; not a build dependency of SUPA-2, which is exercised today through the memories routes.
- **DB-SUPA-6 (declared DDL)** — registers non-memory table schemas into `TableSchemaRegistry`. Not required for SUPA-2 to ship (built-in `memories` entry); do not assume SUPA-6 exists when building SUPA-2.
- **Existing code referenced:** `appendToJsonl`/chunk rotation (`src/storage/jsonl.ts`), lock pattern (`src/s3/sync.ts:161-195`), `isPidAlive` (`src/utils/pidfile.ts:33`), `MemorySchema` (`src/schema/memory.ts:50`), debounce via `commitNamespaceWithParams` and shutdown flush via `flushAllCommits` (`src/git/autocommit.ts`), `ValidationError`/`ApiError` (`src/http/middleware/errorHandler.ts`), `AuthPrincipal` (`src/auth/middleware.ts:46`).

## Test Plan

New suites (runnable individually via `pnpm test <file>` or together via `pnpm test`):

`src/serialization/registry.test.ts`:
- "built-in memories entry resolves MemorySchema for every namespace".
- "register + get round-trip for an arbitrary fixture table schema".
- "get for an unregistered table returns undefined".

`src/serialization/lock.test.ts` (temp `namespacesPath`):
- "wx acquire: exactly one winner among 16 concurrent acquirers".
- "dead-pid break: lock file with a dead pid is broken immediately and re-acquired" (spawn a child that writes a lock and exits).
- "live-pid lock younger than LOCK_STALE_MS is not broken".
- "stale lock (age > LOCK_STALE_MS) with live pid is broken and re-acquired".
- "corrupt lock file is busy until stale, then broken".
- "tokenStillCurrent: false after another process breaks and re-acquires".

`src/serialization/namespaceWriter.test.ts`:
- "enqueue assigns strictly monotonic seq per namespace".
- "flush appends in seq order — file order equals seq order" (AC-3).
- "invalid record returns VALIDATION_ERROR fields and never enqueues" (AC-8).
- "queue at maxPendingRows returns SERIALIZER_QUEUE_FULL + Retry-After: 1" (AC-7).
- "batch with one invalid row enqueues nothing" (AC-8).
- "graceful drain: enqueue during drain returns SERVER_SHUTTING_DOWN".
- "fenced writer refuses flush with SERIALIZER_FENCED" (AC-5).

`src/serialization/audit.test.ts`:
- "every accepted write produces an _audit row with matching seq and outcome accepted" (AC-9).
- "denial rows (role check failure) are appended with outcome denied" (AC-6).
- "audit appends survive data-queue pressure at maxPendingRows".

`src/cli/http-serialization.test.ts` (in-process `createHttpServer`, `src/cli/http.ts:243`; temp `DUCKBRAIN_NAMESPACES_PATH`):
- "32 concurrent writers × 4 namespaces: zero torn lines, row count equals 2xx count, per-namespace order deterministic" (AC-1, AC-3).
- "role-denied write: 403, queue length unchanged, denial audit row present" (AC-6).
- "fsync-mode namespace under load: restart-replay shows every acked row" (AC-2).

`src/serialization/twowriter-kill9.test.ts` (two spawned child servers sharing one temp `namespacesPath`):
- "second writer gets SERIALIZER_LOCKED while first holds the lock".
- "SIGKILL of the first mid-flush: second acquires via dead-pid break; restart-replay shows all acked rows from both, none lost" (AC-4).
