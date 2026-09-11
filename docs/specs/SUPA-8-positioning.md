# SUPA-8 — Positioning Contract: Git-Native DuckBrain, Not a Supabase Clone

- **Board row:** DB-SUPA-8 (P2, complexity 1)
- **Spec row:** DB-SUPA-10 (SPEC SET B)
- **Status:** pending documentation implementation — contract for README and guide updates
- **Companion specs:** `docs/specs/SUPA-3-rest.md`, `docs/specs/SUPA-4-auth.md`, `docs/specs/SUPA-5-realtime.md`, and `docs/specs/SUPA-6-ddl.md`

## Problem Statement

DuckBrain needs positioning that makes its useful analogy legible without making a false product claim. DuckBrain is a git-backed persistent-memory system for agents: `AGENTS.md:5-7` identifies DuckDB storage, MCP integration, HTTP access, and namespace isolation. A namespace has its own git repository: `src/git/autocommit.ts:68-109` initializes it and commits its files; `src/git/asof.ts:4-21` documents one repository per namespace. `resolveAsOfRef` accepts dates, commit hashes, branches, and tags (`src/git/asof.ts:111-168`), and `queryMemoriesAtRef` reads historical namespace files through `git show` without checkout or worktree mutation (`:171-257, 344-370`). Those are real proof points, not roadmap claims.

The phrase “Supabase-for-DuckDB” is useful only as a qualified category analogy. Supabase documents a complete backend platform and a full Postgres database with Realtime and other managed components.[6] PostgREST is explicitly a standalone server that turns a **PostgreSQL** database into a REST API; it is not SQLite software and must never be described as running on SQLite.[2] DuckDB's official site describes an analytical database system; DuckBrain's current runtime uses DuckDB through `node-duckdb` (`AGENTS.md:11-16`). The appropriate claim is therefore not drop-in parity, managed-service parity, or protocol parity.

This document is an implementation contract for public documentation. It pins audiences, wording, proof rules, capability tables, placement, citation discipline, and drift controls. It does not modify README content in this task, and it does not authorize a marketing claim before the named capability has evidence.

## Acceptance Criteria

### Contract: audience and approved wording

Target audiences are:

1. Agent-platform engineers who need durable, inspectable memory with MCP and HTTP access.
2. Teams that value namespace-local git history, branch/ref investigation, and offline-readable JSONL over a hosted opaque database service.
3. Developers evaluating an embedded/agent-first data layer who need to distinguish DuckBrain's current memory product and implemented-on-branch role/auth controls (pending public release evidence) from planned generic REST, realtime, and declared-DDL work.

Approved one-sentence category statement, for README lead and docs overview:

> DuckBrain is a git-native, agent-first memory system built on DuckDB, with MCP and HTTP access and namespace-local history; the “Supabase-for-DuckDB” phrase is a roadmap analogy for additive generic REST, declared-schema, and realtime work, alongside implemented-on-branch role/auth controls that still await public release evidence—not a claim of Supabase compatibility or managed-service parity.

The phrase may appear only with its qualifier in the same paragraph or adjacent table cell. Headlines may use “A git-native data layer for agent memory” but may not use “Supabase clone,” “drop-in Supabase,” or “Supabase compatible.” The category statement is a documentation claim, not an API compatibility promise.

### Contract: truthful capability matrix

| Capability | Status at this spec's evidence point | Evidence / allowed wording |
|---|---|---|
| DuckDB-backed local query/storage runtime | Available now | `AGENTS.md:5-16`; say “uses DuckDB via node-duckdb,” not “hosted DuckDB service” |
| Git repository per namespace, commits of namespace files | Available now | `src/git/autocommit.ts:68-109`; say “namespace-local git history” |
| Read at a past date, commit, branch, or tag without checkout | Available now | `src/git/asof.ts:111-180`; say “read-only as-of recall at git refs” |
| MCP tools and existing HTTP API | Available now | `AGENTS.md:18-25`; `createHttpServer` mounts current routes at `src/cli/http.ts:361-372` |
| S3-native sync / remote replication | Available now only where configured | `src/git/autocommit.ts:111-118, 260-307`; say “optional configured S3 sync,” never “multi-region HA” |
| fsync/direct durability modes | Implemented by SUPA-1; evidence must be checked before public promotion | `docs/specs/SUPA-1-write-durability.md` is a build contract, not release evidence |
| per-namespace serialized writes and audit rows | Implemented by SUPA-2; evidence must be checked before public promotion | `src/serialization/namespaceWriter.ts:670-850`; public claims require current tests and release proof |
| declared schema and generic table REST | Planned by SUPA-3/SUPA-6 | Use future tense only: “planned declared-schema generic REST” |
| role grants, auth backends, and token lifecycle | Implemented on branch by DB-SUPA-4; pending public release evidence | `src/auth/middleware.ts`; `src/auth/roles.test.ts`, `src/auth/token-lifecycle.test.ts`, and `src/auth/backend-interface.test.ts`; say “implemented-on-branch role/auth controls awaiting release evidence,” never “available now” from board status alone |
| committed resumable change feed | Planned by SUPA-5 | Use future tense only: “planned committed SSE change feed” |
| hosted tenant management, billing, global control plane | Explicit non-goal | Do not imply it exists |
| full PostgREST grammar, Supabase Realtime protocol, full Supabase SDK parity | Explicit non-goal | Do not imply compatibility |

The documentation owner must update a matrix row only after the implementation task is merged, its named tests pass on the target branch, and the source/route exists. A complete board status or unverified spec alone is insufficient evidence for “available now.” The matrix must always distinguish “available now,” “implemented on branch and awaiting public release evidence,” “planned,” and “non-goal”; it must not flatten all rows into a feature checklist.

### Contract: README and documentation placement

The planned public update has these files and outline. This task creates none of them; the later documentation task must follow this structure and cite this spec.

1. `README.md`
   - lead: approved one-sentence statement;
   - “What exists now” short matrix, limited to current evidence;
   - “Why git-native” with branch/ref/rollback proof links;
   - “Roadmap surface” with SUPA-3/5/6 named as planned and DB-SUPA-4 named as implemented-on-branch/pending public release evidence;
   - “What this is not” prohibited-claim summary.
2. `docs/guide/positioning.md`
   - audience and use-case fit;
   - evidence-backed architecture diagram (JSONL → namespace git → DuckDB/MCP/HTTP);
   - current-versus-roadmap capability matrix;
   - forks, branches, rollback, and as-of time-travel walkthrough linked to source-supported docs;
   - source notes: primary sources and clearly labeled analogies/precedents.
3. `docs/guide/ai-configure.md` and API guides
   - a compact link to the positioning page only; no duplicated capability matrix that can drift.

Fork/rollback/branch proof language is constrained as follows: “Each namespace can have its own git history; DuckBrain resolves an as-of input as a date, commit, branch, or tag and reads files at that ref without checkout.” This is supported by current source. Do not claim a productized fork-management UI, automatic branch lifecycle, conflict-free merge workflow, or remote rollback command unless a separate verified route/tool supplies it. “Rollback” in public copy means an operator can inspect/recover a prior git revision through normal namespace git history; it does not mean every API mutation has an undo endpoint.

### Contract: external source rules and authoritative source list

External comparisons must distinguish three labels in prose and tables:

- **Primary evidence**: an official project source directly supports a factual statement about that project.
- **Analogy**: a category comparison that helps readers orient themselves but does not imply code reuse, API parity, or architecture inheritance.
- **Precedent**: an independently built example showing that an embedded-database deployment pattern exists; it is not DuckBrain's technical lineage.

Do not cite a search snippet, third-party blog, or a URL not opened/validated in the documentation change. Prefer the official project/operator source below. Access date for every listed source is **2026-09-11**; each URL resolved with HTTP 200 on that date.

| ID | Label | Title | URL | Permitted use |
|---:|---|---|---|---|
| [1] | Precedent | How it works - Litestream | https://litestream.io/how-it-works/ | Litestream's official explanation of continuous SQLite replication. It supports “SQLite tooling can replicate data to object storage,” not a claim that DuckBrain uses Litestream or SQLite. |
| [2] | Primary evidence for PostgREST boundary; analogy for resource derivation | PostgREST Documentation | https://postgrest.org/ | Supports that PostgREST serves PostgreSQL as REST. It explicitly constrains copy: **PostgREST itself does not run on SQLite or DuckDB.** |
| [3] | Primary evidence for SQLite category | About SQLite | https://sqlite.org/about.html | Supports describing SQLite as an embedded SQL database engine. It is category context only; DuckBrain is not SQLite. |
| [4] | Precedent | LiteFS - Distributed SQLite | https://fly.io/docs/litefs/ | Supports that an operator built a distributed filesystem for SQLite replication. It is not evidence of DuckBrain replication, HA, or shared code. |
| [5] | Primary evidence for DuckDB category | DuckDB — An analytical SQL database management system | https://duckdb.org/ | Supports the DuckDB analytical/in-process category context. Runtime integration claims still cite this repository. |
| [6] | Primary evidence for the Supabase comparison boundary | Supabase Docs | https://supabase.com/docs | Supports that Supabase documents a broader backend platform. It supports contrast, not parity. |

The only permitted external relationship sentence is: “DuckBrain borrows the *orientation* of database-derived APIs from projects such as PostgREST [2], while its git-native namespace history is its own source-supported design; SQLite replication tools such as Litestream [1] and LiteFS [4] are ecosystem precedents, not DuckBrain dependencies or lineage.” Every public page using this sentence must retain the labels or equivalent language.

### Citation ledger

Sources:
[1] https://litestream.io/how-it-works — How it works - Litestream
[2] https://postgrest.org — PostgREST Documentation
[3] https://sqlite.org/about.html — About SQLite
[4] https://fly.io/docs/litefs — LiteFS - Distributed SQLite
[5] https://duckdb.org — DuckDB — An analytical SQL database management system
[6] https://supabase.com/docs — Supabase Docs

### Behavioral acceptance criteria

- **AC-1 (approved category statement):** GIVEN a maintainer writes a README or guide lead, WHEN it uses the Supabase comparison, THEN it uses the approved one-sentence statement or a meaning-preserving variant with the same-paragraph roadmap qualifier and does not say clone, drop-in, compatible, or parity. **Checks:** `docs-positioning.test.mjs` / `"comparison phrase has qualifier and no prohibited synonym"`; manual copy review.
- **AC-2 (current versus roadmap):** GIVEN the public capability matrix, WHEN it lists a feature, THEN every entry is labeled available now, implemented-on-branch/release-evidence-pending, planned, or non-goal and its source/evidence supports that label; SUPA-3/5/6 remain future tense, while DB-SUPA-4 role/auth controls are implemented-on-branch and remain short of an “available now” claim until release evidence is verified. **Checks:** `docs-positioning.test.mjs` / `"matrix rows cite current source or named roadmap"`, `"DB-SUPA-4 is implemented-on-branch not planned"`; release checklist `"feature evidence gate"`.
- **AC-3 (git proof points):** GIVEN public docs describe branches, time travel, or rollback, WHEN a reader follows the cited source/doc link, THEN the claim is limited to namespace-local git history and `resolveAsOfRef`/`queryMemoriesAtRef` read-only behavior; it does not imply an unimplemented UI, merge system, or API undo route. **Checks:** `docs-positioning.test.mjs` / `"git claims link to asof source-supported guide"`; `src/git/asof.test.ts` targeted verification.
- **AC-4 (citation integrity):** GIVEN an external comparison appears, WHEN its source list is inspected, THEN it uses one of [1]-[6] or a newly opened official source with title, URL, access date, and Primary evidence/Analogy/Precedent label; it never says PostgREST runs on SQLite. **Checks:** `docs-positioning.test.mjs` / `"external references are labeled and PostgREST boundary is explicit"`; `scripts/verify-doc-links.mjs` / `"SUPA-8 authoritative URLs resolve"`.
- **AC-5 (placement and drift):** GIVEN the later README and guide update lands, WHEN the repository documentation is scanned, THEN the long matrix exists only in `docs/guide/positioning.md`, README has the prescribed compact structure and link, and a SUPA task landing prompts a matrix review rather than silently aging the roadmap. **Checks:** `docs-positioning.test.mjs` / `"single matrix owner and README outline"`; release checklist `"SUPA drift review"`.
- **AC-6 (prohibited claims):** GIVEN public copy is linted, WHEN it contains a disallowed parity/hosting/protocol/production phrase, THEN the docs check fails and identifies the line; a production-performance or availability statement additionally requires a linked measurement or operational evidence artifact. **Checks:** `docs-positioning.test.mjs` / `"prohibited claim deny-list"`; release checklist `"evidence linked for production claim"`.

## Edge Cases

- **A SUPA task is merged but not released:** matrix may say “implemented on `<branch>`; release evidence pending” only if the branch/commit and green test evidence are linked. It may not move to “available now” by assumption.
- **A feature exists for `memories` but not generic tables:** state that scope. Do not upgrade a memory-specific route into a claim of generic PostgREST-style resources.
- **An external source changes URL/title:** link verification fails; update the citation table only after opening the new official page and revising the supported claim. A redirect is acceptable only when the final URL and title are recorded.
- **S3 is configured versus absent:** current source invokes sync/push only when configuration/remote exists (`src/git/autocommit.ts:111-118, 260-307`). Copy must say optional/configured, not automatic universal replication.
- **Git history is shallow or pruned:** as-of behavior depends on the namespace repository history available locally. Do not market unlimited recovery where the required commit is absent.
- **A contributor proposes a stronger analogy:** “Supabase-inspired,” “PostgREST-compatible,” “serverless,” “zero-ops,” “multi-tenant,” and “production-ready” require direct, current evidence and are rejected by default under this contract.

## Non-Goals

- No statement that DuckBrain is a Supabase clone, drop-in replacement, compatible API, hosted equivalent, or complete backend platform.
- No statement that PostgREST runs on SQLite or DuckDB, or that DuckBrain is derived from/PostgREST code.
- No full PostgREST query grammar, Supabase Realtime protocol, Supabase Auth/Storage parity, Supabase client SDK parity, hosted multi-tenancy, billing, global HA, or managed operational completeness claim.
- No claim that optional S3 push is synchronous replication, point-in-time recovery, multi-region durability, or a Litestream/LiteFS implementation.
- No production readiness, uptime, latency, durability, or security certification claim without independently linked operational evidence.
- No README or public-documentation edit in DB-SUPA-10 itself; this file is the contract for that later docs implementation.

## Dependencies

- **Current repository proof.** `AGENTS.md`, `src/git/autocommit.ts`, `src/git/asof.ts`, `src/cli/http.ts`, and `src/serialization/namespaceWriter.ts` provide the source-backed current-state claims. Documentation implementation must re-check line references on its target commit.
- **SUPA implementation dependencies.** SUPA-3 supplies planned generic resource REST, DB-SUPA-4 supplies implemented-on-branch role/auth semantics with source and named Vitest evidence in `src/auth/middleware.ts`, `src/auth/roles.test.ts`, `src/auth/token-lifecycle.test.ts`, and `src/auth/backend-interface.test.ts`, SUPA-5 supplies planned committed change feed, and SUPA-6 supplies planned declared DDL. A complete board row and source/test presence establish the implemented-on-branch classification, but neither is public-release evidence for an “available now” claim.
- **Documentation implementation dependencies.** A planned docs check (`scripts/docs-positioning.test.mjs` or repository-equivalent) must own the prohibited-claim deny-list, matrix owner rule, reference labels, and URL link validation. It must be run in CI with outbound links allowed or in a scheduled evidence job whose committed result is CI-consumed.
- **Authoritative source handling.** Sources [1]-[6] above are the initial approved list. They are primary official sources where stated; [1] and [4] are explicitly precedent, while [2] is an analogy bounded by its PostgreSQL-only reality. Their inclusion creates no runtime dependency.

## Test Plan

This is a documentation contract. The named checks are planned and must run when README/guide copy is created; DB-SUPA-10 does not add scripts or tests.

| Check | Acceptance criteria |
|---|---|
| `scripts/docs-positioning.test.mjs` — `comparison phrase has qualifier and no prohibited synonym` | AC-1 |
| `scripts/docs-positioning.test.mjs` — `matrix rows cite current source or named roadmap`; `DB-SUPA-4 is implemented-on-branch not planned`; release checklist `feature evidence gate` | AC-2 |
| `scripts/docs-positioning.test.mjs` — `git claims link to asof source-supported guide`; targeted `src/git/asof.test.ts` | AC-3 |
| `scripts/docs-positioning.test.mjs` — `external references are labeled and PostgREST boundary is explicit`; `scripts/verify-doc-links.mjs` — `SUPA-8 authoritative URLs resolve` | AC-4 |
| `scripts/docs-positioning.test.mjs` — `single matrix owner and README outline`; release checklist `SUPA drift review` | AC-5 |
| `scripts/docs-positioning.test.mjs` — `prohibited claim deny-list`; release checklist `evidence linked for production claim` | AC-6 |

The link verifier must follow redirects, require a final 2xx response, and report the final URL. The copy checker must inspect README plus `docs/**/*.md`, allow historical quotations only when marked as quotations, and fail any unqualified occurrence of “Supabase-for-DuckDB,” “Supabase clone,” “PostgREST-compatible,” “SQLite PostgREST,” “drop-in,” or production/HA equivalence language. Each merged SUPA implementation must add a release-note checklist item that re-runs this matrix review before public docs change status.
