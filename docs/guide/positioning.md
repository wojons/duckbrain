# Positioning and Roadmap — A git-native data layer for agent memory

> **Approved category statement.** DuckBrain is a git-native, agent-first memory
> system built on DuckDB, with MCP and HTTP access and namespace-local history;
> the “Supabase-for-DuckDB” phrase is a roadmap analogy for additive generic
> REST, declared-schema, and realtime work, alongside implemented-on-branch
> role/auth controls that still await public release evidence — not a claim of
> Supabase compatibility or managed-service parity.

This page is the **single long-form owner** of DuckBrain's positioning: who it is
for, what exists today, what is planned, and what it is not. The
[README](../../README.md) carries the compact version, and the
[AI Agent Configuration guide](ai-configure.md) and the
[HTTP API reference](../api/http-api.md) link here instead of repeating the
capability matrix — a duplicated matrix drifts, so there is exactly one.

Contract of record: [`docs/specs/SUPA-8-positioning.md`](../specs/SUPA-8-positioning.md).
Where this page and the product disagree, the source code wins and this page is
wrong; please open an issue.

## Who this is for

1. **Agent-platform engineers** who need durable, inspectable memory with MCP
   and HTTP access, running on infrastructure they already own.
2. **Teams that value namespace-local git history** — branch/ref investigation,
   offline-readable JSONL, and per-namespace repositories — over a hosted,
   opaque database service.
3. **Developers evaluating an embedded, agent-first data layer** who need to
   distinguish what DuckBrain is today from what is only planned.

**Use-case fit.**

| Fits well                                                        | Does not fit                                                          |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| Long-lived agent memory you can `git log`, diff, and archive     | OLTP workloads with high-concurrency multi-writer transactions        |
| Per-project / per-namespace isolation with independent history   | Tenant billing, quotas, or a hosted multi-tenant control plane        |
| Offline-first or self-hosted deployments on your own disk        | Drop-in replacement for a hosted backend platform's SDK and protocols |
| Analytical queries over your memory corpus (DuckDB, VSS, httpfs) | Sub-millisecond point lookups at production web scale                 |
| Read-only recall of memory _as it existed_ at a past ref         | Automatic bidirectional replication across regions                    |

## How it works (evidence-backed)

```text
        write path                              read path
        ──────────                              ─────────
  MCP tool / HTTP route / CLI             MCP tool / HTTP route / CLI
             │                                        │
             ▼                                        ▼
   JSONL partitions on local disk            DuckDB query layer
   namespaces/<ns>/<domain>/…                (node-duckdb, VSS vectors)
             │                                        │
             ▼                                        ▼
   namespace git repository           current rows ← manifest index
   (one repo per namespace)           as-of rows   ← git show <ref>:<path>
             │                                       (read-only, no checkout)
             ▼
   optional configured S3 sync
   (inert unless s3.enabled)
```

| Step                                                                                                                                                  | Evidence in this repository                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Append-only JSONL is the storage of record; DuckDB is the query layer                                                                                 | `AGENTS.md:5-16`; `src/storage/`; `src/duckdb/`                                                                             |
| Each namespace is its own git repository: `git init` runs inside the namespace directory and namespace files are committed                            | `src/git/autocommit.ts:287` (`git init`), `commitNamespaceWithParams` / `flushNamespaceCommit` (`:352`, `:407`)             |
| History is read without checkout: `git show <ref>:<path>` per partition, merged through the manifest, with the same semantics as the DuckDB list path | module contract `src/git/asof.ts:1-33`; `readRowsAtRef` (`:212`), `queryMemoriesAtRef` (`:361`)                             |
| MCP tools and the HTTP API are the two access surfaces; both are mounted by one server factory                                                        | `src/cli/http.ts:367` (`createHttpServer`), route mounts at `:477-481`                                                      |
| S3 is an **optional**, configured sync path, gated on config                                                                                          | `maybeSyncOnCommit` call sites `src/git/autocommit.ts:181-183`, `:325-327`; design doc [docs/s3-native.md](../s3-native.md) |

## Capability matrix

Every row is labeled with one of four statuses. The evidence bar is deliberately
strict: a row may move to “available now” only after the implementation task is
**merged**, its **named tests pass on the target branch**, and the
**source/route exists**. A spec file, a board status, or code on an unmerged
development branch is not release evidence.

**Statuses used in the matrix:** **Available now** · **Implemented on branch —
release evidence pending** · **Planned** · **Non-goal**.

| Capability                                                                                  | Status                                               | Evidence / allowed wording                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DuckDB-backed local query and storage runtime                                               | **Available now**                                    | `AGENTS.md:5-16` — “uses DuckDB via `node-duckdb`”, not a hosted DuckDB service                                                                                                                                                                                                                                                                                                                                      |
| Git repository per namespace; namespace files are committed                                 | **Available now**                                    | `src/git/autocommit.ts:287`, `:352`, `:407` — “namespace-local git history”                                                                                                                                                                                                                                                                                                                                          |
| Read-only recall at a past date, commit, branch, or tag, without checkout                   | **Available now**                                    | `src/git/asof.ts:126` (`resolveAsOfRef`), `:212`, `:361` — “read-only as-of recall at git refs”                                                                                                                                                                                                                                                                                                                      |
| MCP tools (`remember`, `recall`, `list_keys`, `forget`, `squash`, namespace + server tools) | **Available now**                                    | `AGENTS.md:18-25`; `src/mcp/`                                                                                                                                                                                                                                                                                                                                                                                        |
| HTTP API for memories, keys, namespaces, events, compaction                                 | **Available now**                                    | `src/cli/http.ts:477-481`; [HTTP API reference](../api/http-api.md)                                                                                                                                                                                                                                                                                                                                                  |
| Optional configured S3 sync / push-on-commit                                                | **Available now only where configured**              | `src/git/autocommit.ts:181-183`, `:325-327`; `s3.enabled: false` by default — “optional configured S3 sync”, never “multi-region HA”                                                                                                                                                                                                                                                                                 |
| fsync / direct write durability modes (SUPA-1)                                              | **Implemented — release evidence pending**           | `docs/specs/SUPA-1-write-durability.md` is a build contract, not release evidence                                                                                                                                                                                                                                                                                                                                    |
| Per-namespace serialized writes and audit rows (SUPA-2)                                     | **Implemented — release evidence pending**           | `src/serialization/namespaceWriter.ts`; `audit.ts`, `auditLedger.ts`; see the spec `docs/specs/SUPA-2-serialization.md`                                                                                                                                                                                                                                                                                              |
| Role grants, pluggable auth backends, token lifecycle (DB-SUPA-4)                           | **Implemented on branch — release evidence pending** | `src/auth/middleware.ts`, `src/auth/roles.ts`; named tests `src/auth/roles.test.ts`, `src/auth/token-lifecycle.test.ts`, `src/auth/backend-interface.test.ts`; spec [SUPA-4-auth.md](../specs/SUPA-4-auth.md). Not “available now”                                                                                                                                                                                   |
| Declared-schema generic table REST (SUPA-3 / SUPA-6)                                        | **Planned**                                          | Named roadmap: [SUPA-3-rest.md](../specs/SUPA-3-rest.md), [SUPA-6-ddl.md](../specs/SUPA-6-ddl.md) — future tense only: “planned declared-schema generic REST”                                                                                                                                                                                                                                                        |
| Committed, resumable SSE change feed (SUPA-5)                                               | **Available now**                                    | Route `src/http/routes/realtime.ts` (`GET /api/ns/:ns/changes`, mounted at `src/cli/http.ts:511`), implementation `src/http/realtime/`; tests `src/http/routes/realtime-*.test.ts` — 7 suites / 20 tests, green 2026-09-25; [HTTP API reference](../api/http-api.md). Known issues: DF-0925-01 (replay ignores `ops=`), DF-0925-02 (data/audit split-commit) — see [SUPA-5-realtime.md](../specs/SUPA-5-realtime.md) |
| Hosted tenant management, billing, global control plane                                     | **Non-goal**                                         | Not implemented and not implied anywhere in this repository                                                                                                                                                                                                                                                                                                                                                          |
| Full PostgREST query grammar, Supabase Realtime protocol, Supabase client SDK parity        | **Non-goal**                                         | Not implemented and not implied                                                                                                                                                                                                                                                                                                                                                                                      |

> **Note on evidence.** The `docs/specs/` files are design contracts. Code on a
> development branch, a spec file, or a completed board row is not proof that a
> capability has been released — which is why SUPA-3/6 stay under **Planned**
> here and DB-SUPA-4 stays at **implemented on branch, release evidence
> pending**. SUPA-5 (SSE change feed) is **Available now**: the route is merged
> on `main`, the route/source exists, and the named tests were run green on this
> branch (2026-09-25). Statuses change only through the review rule below, never
> by assumption.

**Drift rule.** When a SUPA task lands, the documentation owner re-runs this
matrix before public copy changes: merge state, the named tests on the target
branch, and the existence of the source/route are all checked, and the row is
relabeled only if all three hold. A merged-but-unreleased task may read
“implemented on `<branch>`; release evidence pending” only when the branch/commit
and green test evidence are linked.

## Git history, refs, and what “rollback” means here

> Each namespace can have its own git history; DuckBrain resolves an as-of input
> as a date, commit, branch, or tag and reads the files at that ref without
> checkout. (`docs/specs/SUPA-8-positioning.md`)

`resolveAsOfRef` (`src/git/asof.ts:126`) accepts:

- an **ISO-8601 date/datetime** — resolved to the nearest commit at-or-before
  that instant (`git rev-list -1 --before=… HEAD`; a date-only value is
  inclusive of the whole day, normalized to an explicit end-of-day UTC bound so
  the result does not depend on the host timezone);
- a **commit hash** (full or short), a **branch name**, or a **tag** — resolved
  directly via `git rev-parse --verify <ref>^{commit}`.

Invalid input throws a readable error rather than crashing, and a namespace
without git history is reported as such.

Read it:

```bash
# CLI — recall the namespace as it was at a past date or ref
duckbrain recall --namespace=my-ns --as-of=2026-08-10
duckbrain recall --namespace=my-ns --as-of=<sha|branch|tag>

# HTTP — same resolution path
curl "http://localhost:3000/api/memories?namespace=my-ns&as_of=2026-08-10"
```

Both routes resolve through `resolveAsOfRef`; the HTTP `as_of` parameter is
documented in the [HTTP API reference](../api/http-api.md), and the
memory-as-of feature is described in the
[agentic memory roadmap](../agentic-memory-roadmap.md). Reads run
`git show <ref>:<path>` per partition and never mutate the worktree, index, or
HEAD (`src/git/asof.ts:1-33`).

**Branch and ref investigation** works the way git works: each namespace is a
normal repository under your data directory, so `git log`, `git diff`,
`git branch`, `git tag`, and `git show` all apply to it directly. There is no
separate UI, service, or API layer in front of that history.

**“Rollback” in this documentation means:** an operator can **inspect and
recover a prior revision** through the namespace's own git history — for example
by reading an old ref, or by checking out or restoring files in the namespace
repository. It does **not** mean every API mutation has an undo endpoint: there
is no undo route, no merge UI, no automatic branch lifecycle, and no claim of
unlimited recovery. As-of reads also depend on the history present locally in
that namespace repository; a shallow or pruned clone cannot resolve a commit it
does not have.

## What this is not

- **Not** a clone, drop-in replacement, or API-compatible equivalent of
  Supabase, and **not** an implementation of Supabase's Realtime, Auth, or
  client-SDK protocols. Supabase documents a broader backend platform [6]; this
  page uses that only as contrast.
- **Not** a hosted or managed service. There is no tenant console, no billing,
  no global control plane, and no managed operational completeness claim.
- **Not** a PostgREST deployment, and not derived from PostgREST code. PostgREST
  is a standalone REST server for **PostgreSQL** [2]; it does not run on SQLite
  or DuckDB, and DuckBrain does not implement the full PostgREST query grammar.
- **Not** SQLite — DuckBrain's runtime storage engine is DuckDB [5]. SQLite
  appears on this page only as ecosystem category context [3].
- **Not** multi-region HA, point-in-time recovery, or synchronous replication.
  S3 support is an **optional, configured** sync path
  ([docs/s3-native.md](../s3-native.md)); it is inert unless you enable it, and
  DuckBrain has no Litestream- or LiteFS-style continuous replication [1][4].
- **Not** production-certified. No uptime, latency, throughput, durability, or
  security certification claim appears here without a linked measurement or
  operational evidence artifact.

## Source notes

External comparisons on this page carry one of three labels. Nothing below is a
DuckBrain dependency or lineage claim.

- **Primary evidence** — an official project source directly supports a factual
  statement about _that_ project.
- **Analogy** — a category comparison that orients the reader; it does not imply
  code reuse, API parity, or architecture inheritance.
- **Precedent** — an independently built example showing that an embedded-database
  deployment pattern exists.

|  ID | Label                                                                | Source                                                           | Access date | Permitted use                                                                                                                          |
| --: | -------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [1] | Precedent                                                            | How it works — Litestream, <https://litestream.io/how-it-works/> | 2026-09-11  | Ecosystem precedent: continuous replication of an embedded database to object storage. Not a DuckBrain dependency or implementation.   |
| [2] | Primary evidence (PostgREST boundary); Analogy (resource derivation) | PostgREST Documentation, <https://postgrest.org/>                | 2026-09-11  | Establishes that PostgREST serves **PostgreSQL** as a REST API. It does **not** run on SQLite or DuckDB.                               |
| [3] | Primary evidence (SQLite category)                                   | About SQLite, <https://sqlite.org/about.html>                    | 2026-09-11  | Category context only: SQLite is an embedded SQL database engine. DuckBrain is not SQLite.                                             |
| [4] | Precedent                                                            | LiteFS — Distributed SQLite, <https://fly.io/docs/litefs/>       | 2026-09-11  | Ecosystem precedent: a distributed filesystem built for SQLite replication. Not evidence of DuckBrain replication, HA, or shared code. |
| [5] | Primary evidence (DuckDB category)                                   | DuckDB, <https://duckdb.org/>                                    | 2026-09-11  | Category context for DuckDB as an analytical, in-process database; runtime integration claims here cite this repository instead.       |
| [6] | Primary evidence (comparison boundary)                               | Supabase Docs, <https://supabase.com/docs/>                      | 2026-09-11  | Supports contrast with a broader backend platform; it supports contrast, not parity.                                                   |

All URLs above were opened and returned HTTP 200 on the access date shown.

**Permitted relationship sentence.** DuckBrain borrows the _orientation_ of
database-derived APIs from projects such as PostgREST [2], while its git-native
namespace history is its own source-supported design; SQLite replication tools
such as Litestream [1] and LiteFS [4] are ecosystem precedents, not DuckBrain
dependencies or lineage.

Repository-evidence citations in this page (file paths and line numbers, the
`docs/specs/*` contracts, and `AGENTS.md`) are primary sources for DuckBrain's
own behavior and are re-checked whenever this page changes.

## Rejected phrasings

Terms such as “Supabase-inspired”, “serverless”, “zero-ops”, “multi-tenant”, and
“production-ready” are rejected by default, as is any phrasing that asserts
PostgREST grammar or protocol compatibility: each would require direct, current,
linked evidence, and none is available today. Report a page that uses one as an
issue, with the line, and this matrix gets re-checked.
