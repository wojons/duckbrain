# SUPA-1 — Write Path v2: fsync-before-ack Durability + Pluggable Sync Modes

- **Board row:** DB-SUPA-1 (P0, complexity 3)
- **Spec row:** DB-SUPA-9 (SPEC SET A)
- **Status:** pending implementation — contract for the build
- **Reference:** mallard-prd-v14.html §03 / §04·B (log-first ordering, honest RPO); judge pushback briefs 2026-09-03
- **Companion specs:** `docs/specs/SUPA-2-serialization.md` (queue + WAL framing), `docs/specs/SUPA-4-auth.md` (role checks)

## Problem Statement

DuckBrain's write path acknowledges before any durability barrier. `appendToJsonl` (`src/storage/jsonl.ts:136`) validates the record via `MemorySchema.parse` (`src/storage/jsonl.ts:138`), runs the DB-GAP-035 round-trip guard (`src/storage/jsonl.ts:154-163`), then calls `fs.appendFileSync` (`src/storage/jsonl.ts:182`). `appendFileSync` copies the bytes into the kernel page cache and returns; the HTTP 2xx is sent with no `fdatasync`. Git commits are debounced per namespace by `gitBatching.maxSeconds` (default 30, `DEFAULT_PARAMS` at `src/git/autocommit.ts:30-34`, cadence documented at `src/git/autocommit.ts:7`), so the git boundary adds up to ~30s of additional exposure and, with `s3.pushOnCommit`, the same window to the S3 remote.

The resulting contract is *corruption-resistant but not ack-durable*: after a 2xx, a record survives `kill -9` (page cache persists) but is not guaranteed to survive an OS crash or power loss, and is not in git until the debounce flush. The 2026-09-03 five-judge audit named this "the single sharpest distinction between a resilient fleet memory system and a data product."

SUPA-1 makes the durability contract explicit and configurable per namespace:

- **buffered** — the current semantics, kept as the default for cron/agent traffic, with its real RPO documented in code and docs.
- **fsync** — `fdatasync` on the JSONL file plus `fsync` on the containing directory **before** the HTTP 2xx; RPO = 0 for acked writes on a single node.
- **direct** — `O_DIRECT` I/O bypassing the page cache for latency-predictable writes, same fsync-before-ack commit protocol as fsync mode.

The mode is per-namespace configuration, surfaced on every write response (`X-Durability` header) and in `/health`.

## Acceptance Criteria

### Contract: mode semantics

New module `src/storage/durability.ts`. `export type WriteMode = "buffered" | "fsync" | "direct";`

| Mode | Append mechanism | Durability barrier before ack | RPO for acked writes (single node) | RPO to git/S3 |
|---|---|---|---|---|
| `buffered` (default) | `fs.appendFileSync` (existing `appendToJsonl`, `src/storage/jsonl.ts:182`) — page-cache write | none | Process-kill safe (page cache retains); **OS-crash/power-loss window unbounded** — documented in the module docstring and in `docs/api/http-api.md` | ≤ `gitBatching.maxSeconds` (default 30, `src/git/autocommit.ts:30-34`); S3 same window when `s3.pushOnCommit` is true |
| `fsync` | new `appendJsonlDurable(filePath, record)` in `src/storage/durability.ts`: `openSync(path, "a")` → `writeSync(fd, line + "\n")` → `fdatasyncSync(fd)` → `closeSync(fd)`; then, when this write created a file or directory, `fsyncSync` on the parent directory fd (`openSync(dir, "r")` → `fsyncSync` → `closeSync`) | file `fdatasync` + directory `fsync` complete | **0** — record is on stable storage before the 2xx; survives process kill, OS crash, and power loss | git commit stays debounced (JSONL is already durable; the commit only transports history) |
| `direct` | new `appendJsonlDirect(filePath, record)` in `src/storage/durability.ts`: `openSync(path, "a", fs.constants.O_DIRECT)` over block-framed records produced by the SUPA-2 serializer (`docs/specs/SUPA-2-serialization.md`, WAL framing) | same commit protocol as `fsync` (file `fdatasync` + directory `fsync` when a file/dir was created) | **0** | same as `fsync` |

**Exact fsync operation inventory per mode** (what runs, and when):

1. `buffered`: no `fdatasync`, no directory `fsync`. Append returns after `appendFileSync`.
2. `fsync`: `fdatasyncSync(fd)` on the JSONL fd for every append batch; `fsyncSync` on the parent-directory fd when that append (a) created a new chunk file via rotation (`getNextChunkName`, `src/storage/jsonl.ts:176-178`), (b) created the file itself (first write to a partition), or (c) created directories (`fs.mkdirSync` chain, `src/storage/jsonl.ts:141-144`) — in case (c) the parent of the deepest newly-created directory is fsynced in addition to the file's parent.
3. `direct`: identical inventory to `fsync`, with the append performed through an `O_DIRECT` fd. `O_DIRECT` requires sector-aligned buffers and offsets; the SUPA-2 serializer frames every record into block-aligned I/O units for direct-mode namespaces. A bare line append (non-framed) to a direct-mode namespace is a programming error and throws `DURABILITY_DIRECT_FRAME_ERROR`.

**Configuration shape** — added to `DuckBrainConfigSchema` (`src/config/index.ts:7`, zod style mirroring the `gitBatching` and `s3` blocks):

```ts
durability: z
  .object({
    defaultMode: z.enum(["buffered", "fsync", "direct"]).default("buffered"),
    overrides: z
      .record(z.string(), z.enum(["buffered", "fsync", "direct"]))
      .default({}),
  })
  .default({ defaultMode: "buffered", overrides: {} }),
```

- File: `duckbrain.config.json` (location per `DUCKBRAIN_CONFIG_PATH`, GAP-022, `src/config/index.ts:153`).
- Environment: `DUCKBRAIN_DURABILITY_MODE=buffered|fsync|direct` overrides `defaultMode` (runtime default only, never persisted — same convention as `DUCKBRAIN_NAMESPACES_PATH`, `src/config/index.ts:211-218`).
- Effective mode for a namespace: `resolveWriteMode(ns) = overrides[ns] ?? DUCKBRAIN_DURABILITY_MODE (when set and valid) ?? config.defaultMode ?? "buffered"`. A malformed `DUCKBRAIN_DURABILITY_MODE` or an invalid `overrides` value fails config load through the existing zod parse — no silent fallback to buffered.

**Response header and health surfacing:**

- Every write route sets `X-Durability: buffered|fsync|direct` on the 2xx response, reporting the mode the write **ACHIEVED** — not the configured one. `X-Durability-Configured` carries the mode resolved from config, and when the achieved mode is weaker than the configured one the response also carries `X-Durability-Degraded: configured=<mode>; achieved=<mode>` so configuration can never be read as achievement (DURABILITY-HONESTY-001).
  - Implemented in `src/storage/durability.ts`: `durabilityHeaders(configured, achieved)` / `setDurabilityHeaders(res, configured, achieved)`; `durabilityHeaderFor(ns)` still resolves the configured mode.
  - A **zero-row mutation** (PATCH/DELETE matching nothing) writes no bytes; its 200 reports the configured mode on both headers because there is nothing to be durable about.
  - `X-Durability-*` are listed in the CORS `Access-Control-Expose-Headers` (`src/cli/http.ts:658`) so browser clients can read them.
- `createHealthHandler` (`src/cli/http.ts:162`) response gains a `durability` block: `{ "defaultMode": "buffered", "overrides": { "<ns>": "fsync" } }` — only non-default overrides are listed, keeping the payload bounded. Config-derived only (no filesystem probe), so `/health` cannot fail over durability reporting.

### Behavioral acceptance criteria

- **AC-1 (fsync mode, kill -9, zero loss):** GIVEN a spawned HTTP server child process whose config sets `durability.overrides` for namespace `nsA` to `fsync`, WHEN a POST write to `nsA` returns 2xx and the child is then killed with `SIGKILL` before any git commit, THEN a fresh reader process (restart-replay: `readFromJsonl` over the partition file plus the next debounced `git add -A` commit) finds the acked record present and the file parses line-by-line without error.
- **AC-2 (fsync ordering):** GIVEN an fsync-mode namespace write, WHEN the write is acknowledged, THEN `fdatasyncSync` was invoked on the JSONL fd before the response resolved, and `fsyncSync` was invoked on the parent-directory fd when the write created a new chunk file (asserted with an `fs` spy; see Test Plan).
- **AC-3 (buffered honesty):** GIVEN a buffered-mode namespace, WHEN a write is acknowledged, THEN no `fdatasync`/`fsync` was issued and the git commit remains debounced; the `src/storage/durability.ts` module docstring and `docs/api/http-api.md` state the RPO: git ≤ `gitBatching.maxSeconds` (default 30s) and the OS-crash/power-loss loss window.
- **AC-4 (direct mode fails loud):** GIVEN a filesystem that rejects `O_DIRECT` (`openSync` throws `EINVAL`/`EOPNOTSUPP` — tmpfs and overlayfs do), WHEN a direct-mode write is attempted, THEN the request fails with `500 DURABILITY_UNSUPPORTED` and no byte is silently written under buffered semantics.
- **AC-5 (config precedence and validation):** GIVEN `durability.overrides = {"nsA": "fsync"}` and no `DUCKBRAIN_DURABILITY_MODE`, WHEN `resolveWriteMode` is called for `nsA` and for `nsB`, THEN `nsA` resolves `fsync` and `nsB` resolves `buffered`; an invalid enum in the config file or the env var fails load with a zod error.
- **AC-6 (header + health):** GIVEN a 2xx write to an fsync-mode namespace, WHEN the response and `/health` are inspected, THEN the response carries `X-Durability: fsync` and `/health` lists `defaultMode` plus the non-default overrides.
- **AC-7 (graceful shutdown flush):** GIVEN pending debounced commits and queued durable appends, WHEN the server shuts down gracefully, THEN the existing shutdown flush (`flushAllCommits` at `src/git/autocommit.ts:195`) runs only after the SUPA-2 serializer queues for every namespace have drained and every fsync-mode append has hit its barrier.
- **AC-8 (fan-in amortization):** GIVEN K concurrent fsync-mode writes to one namespace through the SUPA-2 single-writer queue, WHEN all K acks settle, THEN `fdatasyncSync` was invoked at most once per flush batch (≤ K, and 1 when the queue coalesced all K into one batch) — the durability cost is amortized, not per-row.

## Edge Cases

- **Chunk rotation:** an acked write that triggers rotation to a new chunk (`MAX_BYTES_PER_CHUNK` / `MAX_LINES_PER_CHUNK` checks at `src/storage/jsonl.ts:171-178`) must fsync the new file's parent directory in fsync/direct mode, or the directory entry itself can be lost on crash even though the file data was fsynced.
- **First-write directory creation:** `appendToJsonl` runs `fs.mkdirSync(dir, {recursive:true})` (`src/storage/jsonl.ts:141-144`). When that call created directories, fsync mode also fsyncs the parent of the deepest new directory.
- **`fdatasync`/`fsync` error (e.g. `EIO`):** the error propagates before the ack; the request returns `500 DURABILITY_FSYNC_FAILED`. The record may or may not be on disk; it is never acknowledged.
- **Directory `fsync` unsupported (some NFS mounts return `EINVAL`):** treated as a durability failure — `500 DURABILITY_DIR_FSYNC_UNSUPPORTED`. Skipping it would silently weaken the RPO=0 claim.
- **O_DIRECT alignment:** direct mode requires SUPA-2 block framing; an unframed append to a direct-mode namespace throws `DURABILITY_DIRECT_FRAME_ERROR` rather than writing an unaligned buffer that the kernel would reject mid-write.
- **Buffered-mode power loss:** recent writes can be lost; this is the documented RPO of the mode, not a bug. Buffered mode remains process-kill safe because the page cache survives the process.
- **Bypass guard:** fsync/direct namespaces must be written only through the SUPA-2 serializer; a direct `appendToJsonl` call targeting an fsync/direct namespace is a contract violation (the serializer owns all file writes per `docs/specs/SUPA-2-serialization.md`).
- **Invalid env/config values:** fail config load loudly (zod enum), never fall back to buffered silently.

## Write-path inventory (per path, with the barrier it runs)

DURABILITY-HONESTY-001 fixed a real overstatement: `X-Durability` used to echo
the CONFIGURED mode, and the generic-table store wrote every row with a bare
`fs.appendFileSync` (page cache) / `fs.writeFileSync` + rename, so an
`fsync`-configured namespace advertised `fsync` for a path that never called
`fdatasync`. The table below is the current truth, path by path.

| Write path | Entry point | Mechanism | Achieved (fsync-configured ns) |
|---|---|---|---|
| Memory create (`POST /api/memories`, MCP `remember`) | `src/mcp/tools/remember.ts:315` → `NamespaceWriter.enqueue` | flush dispatch at `src/serialization/namespaceWriter.ts:935-938`: `appendFsyncBatch` (one `fdatasync` per touched file + dir `fsync` on create), `appendDirectBatch`, or `appendFileSync` | `fsync` (or `direct`) |
| Memory update (`PUT /api/memories/:id`) | tombstone + version both via `NamespaceWriter` | same dispatch | `fsync` |
| Memory delete (`DELETE /api/memories/:id`, MCP `forget`) | `src/duckdb/queries.ts:1154` `insertMemoryToPartition` (function at `:1140`) → `NamespaceWriter.enqueue` | same dispatch; the tombstone is a real serialized append, not a buffered side-write | `fsync` |
| Declared table write (`POST/PATCH/DELETE` where `schema.json` declares the table) | `src/http/routes/tables.ts` → `NamespaceWriter.enqueue` at the declared storage path | same dispatch | `fsync` |
| Legacy table insert (`.table.json` declaration) | `appendRowsToTable` (`src/duckdb/table-store.ts:752`) → `appendJsonlRows` (`:198`) → `appendTextDurable` (`src/storage/durability.ts:560`) | `open('a')` → `writeSync` → `fdatasync` → close; parent dir `fsync` when the file/dirs were created | `fsync` (a `direct`-configured namespace ACHIEVES `fsync` here — legacy lines cannot be block-framed — and the response says so via `X-Durability-Degraded`) |
| Legacy table PATCH/DELETE | `rewriteWithPredicate` (`src/duckdb/table-store.ts:806`; call at `:866`) → `rewriteTextDurable` (`src/storage/durability.ts:596`) | temp file `writeSync` → `fdatasync` → `rename` → parent dir `fsync` | `fsync` |
| Audit / change-record ledger | `appendAuditLedger` (`src/serialization/auditLedger.ts:196`, `fs.appendFileSync` at `:242`) | page-cache append, intentionally AFTER the data barrier; SUPA-2 documents a bounded crash window for audit tails and a second `fdatasync` per batch would defeat SUPA-1's fan-in amortization (see the comment at `src/serialization/namespaceWriter.ts:940-944`) | `buffered` (audit tail only; the DATA row is fsynced) |
| CLI `memory-demote` | `src/cli/memory-demote.ts:203` (`fs.appendFileSync`) | page-cache append — operator tooling, outside the HTTP ack path | `buffered` |
| Embedding/search index | `src/cli/search-index.ts:110` (`fs.appendFileSync`) | derived index, rebuildable; never the source of record | `buffered` |
| Git merge/squash internals | `src/git/merge.ts:173`, `src/git/squash.ts:452` | history transport, outside the write ack | n/a |

The `fsync`/`direct` rows above are proven per path by
`src/http/routes/tables-durability-honesty.test.ts` (an `fs.fdatasyncSync`
spy counts the barriers that ran during the request; the same probe reports 0
with the barrier removed) and `src/storage/durability.test.ts`.

## Non-Goals

- No change to git commit cadence semantics: the `gitBatching` debounce (default 30s) stays. In fsync/direct mode the commit is history transport, not the durability mechanism.
- No OS-crash durability in buffered mode; its loss window is documented, not engineered away.
- No synchronous cross-machine replication: the RPO=0 claim in fsync/direct mode is single-node. S3 push (`s3.pushOnCommit`) remains fire-and-forget best-effort (`maybeSyncOnCommit`, `src/s3/index.ts:30`).
- No device-dependent latency benchmark or numeric throughput targets: mechanism and syscall-count assertions are fixed here; measured numbers on real devices are the deliverable of DB-SUPA-7 (storage modes research note). Expected cost shape, stated honestly: a single-writer ack in fsync mode costs buffered-mode cost plus one device `fdatasync` (sub-millisecond to low-millisecond on SSD-class storage); fan-in batching collapses concurrent acks to one barrier per batch (AC-8).
- No multi-writer coordination, locking, or queue implementation — that is DB-SUPA-2.
- No change to `MemorySchema`, validation semantics, or the on-disk JSONL layout.

## Dependencies

- **DB-SUPA-2 (serialization layer)** — fsync/direct mode appends are enqueued through the SUPA-2 per-namespace single-writer and flushed with the SUPA-1 durability barrier; direct mode additionally requires SUPA-2's block-framed WAL records. SUPA-1's buffered semantics, header, and health surface are shippable without SUPA-2.
- **DB-SUPA-7 (storage modes research note)** — informs measured expectations only; SUPA-1 does not block on it. See [`docs/specs/SUPA-7-storage-modes.md`](SUPA-7-storage-modes.md) for the measured latency/throughput distributions, the `O_DIRECT` support matrix on real filesystems, and bounded crash/torn-line observations.
- **DB-SUPA-4 (roles + auth)** — role checks precede enqueue in the SUPA-2 serializer; the `X-Durability` header is set only on successful (2xx) write responses, so denied requests never emit it.
- **Existing code referenced:** `appendToJsonl` + chunk rotation (`src/storage/jsonl.ts`), `gitBatching` debounce (`src/git/autocommit.ts`), `DuckBrainConfigSchema` (`src/config/index.ts`), `createHealthHandler` (`src/cli/http.ts:162`), error envelope via `ApiError` (`src/http/middleware/errorHandler.ts`).

## Test Plan

New suites (runnable individually via `pnpm test <file>` or together via `pnpm test`):

`src/storage/durability.test.ts`:
- "fsync mode: fdatasyncSync + fsyncSync on parent dir run before append resolves" — `vi.spyOn(fs, "fdatasyncSync")` / `vi.spyOn(fs, "fsyncSync")`, temp namespace, `durability.overrides = {test: "fsync"}`.
- "fsync mode: chunk-rotation write fsyncs the new chunk's parent directory fd".
- "buffered mode: no fdatasyncSync, no fsyncSync (spies never called), commit stays debounced".
- "direct mode: openSync receives fs.constants.O_DIRECT on a filesystem that supports it (suite-setup probe; when the probe throws EINVAL/EOPNOTSUPP the scenario asserts the failure path instead)".
- "direct mode on unsupported filesystem: append throws DURABILITY_UNSUPPORTED and writes no bytes".
- "unframed append to a direct-mode namespace throws DURABILITY_DIRECT_FRAME_ERROR".
- "fsync error EIO propagates and the record is not acknowledged".
- "durable append round-trips byte-identically through readFromJsonl".
- "resolveWriteMode: overrides[ns] > env default > config default > 'buffered'; invalid env value fails config load".

`src/storage/durability-kill9.test.ts` (spawns real child processes against a temp `DUCKBRAIN_NAMESPACES_PATH`):
- "kill -9 after ack in fsync mode: record present after restart-replay, file parses cleanly" (AC-1).
- "kill -9 after ack in buffered mode: record present after restart (page-cache retention)".
- "graceful shutdown drains queues and flushes pending commits before exit" (AC-7).

`src/cli/http-durability.test.ts` (in-process `createHttpServer`, `src/cli/http.ts:243`):
- "X-Durability header on POST /api/memories reflects the written namespace's mode" (AC-6).
- "/health response includes durability.defaultMode and non-default overrides" (AC-6).
- "K concurrent fsync-mode writes coalesce: fdatasyncSync call count ≤ flush batch count" (AC-8).
