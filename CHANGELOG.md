# Changelog

All notable changes to DuckBrain will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [1.2.0] - 2026-11-03

Range: `v1.1.0`..`HEAD` — 398 commits (380 non-merge; 28 `feat`, 35 `fix`,
4 `perf`; 67 material non-merge commits). The post-prep range
`1364dc4f`..`HEAD` contains 143 commits (141 non-merge; 25 material
`feat`/`fix`/`perf` commits). Board, QA-ledger and releng bookkeeping is omitted
by design; the entries below are the product-visible changes.

### Added

- **`duckbrain namespaces prune`** (DB-GAP-065) — removes exactly the
  namespace-registry mappings whose directory no longer exists on disk;
  dry-run by default (`--apply` to write, `--dry-run` wins when both are
  passed), idempotent, crash-safe (stamped fsync tmp+rename write that aborts
  on concurrent modification), and path-safety-checked via the same guard as
  `namespace delete`. Each removed row's `.s3state` manifest is pruned in the
  same pass; S3 objects are untouched. Exit 0 success/clean, 1 refused rows,
  2 aborted.
- **`namespace prune --residue`** (DF-2026-15) — restricts the dead set to
  test-pattern names (`auger-pytest-*`, `auger-probe-*`, `pytest-*`,
  `test-residue-*`) so an operator can clear test residue without pruning every
  dead mapping. The DB-GAP-057 on-disk census contract is preserved: unmapped
  directories still appear in `GET /api/namespaces`.
- **Registry drift guard on `GET /api/namespaces`** — a `driftWarning`
  `{deadCount, liveCount, hint}` object when directory-missing rows reach
  >= 25 or exceed 2x the live count; omitted entirely when healthy.
- `updateConfig()` accepts `{expectedStamp, fsync}` for crash-safe,
  concurrent-writer-safe config rewrites (used by prune; default behavior of
  existing callers unchanged).
- **Operator-pinned embedding upstreams** — the embedding client can be pinned
  to a chosen OpenRouter upstream instead of accepting whichever provider the
  router picks, so a degraded upstream is an operator decision rather than a
  silent quality shift.
- **DuckBrain as a Hermes memory provider** (DF-2026-14) — including a
  lossless `MEMORY.md`/`USER.md` -> `hermes-memory` migration, and `dbq`, a
  single command that issues the correct DuckBrain call per intent.
- **L1 to L2 memory demotion** (DF-2026-16) — a CLI path for demoting a memory
  from working set to the archive layer without losing its provenance.
- **Recall quality benchmark** (DF-2026-17) — a repeatable benchmark, a runner,
  and a scheduled run, so recall regressions are measured rather than argued.
- **Nightly session distiller** (DF-2026-18) — turns raw session traffic into
  durable summary memories on a schedule.
- **Read-side recall counter and daily rollup** (DF-2026-19) — with a zero-day
  alert, so a recall path that stops being exercised is visible.
- **Session activity receipts** (DB-GAP-66) and **skill-aware prefetch** —
  recall packs are lane-sized, and a prefetch surfaces matching skills
  alongside memories.
- **Role and per-table grants enforced on every generic-table verb**
  (DB-SUPA-4-R2) — the grant layer is now enforcement, not documentation.
- **The operations plane** — HTTP now exposes namespace pruning, S3 status,
  and consolidation (`bd23bde6`), while MCP exposes declared-table CRUD,
  declaration, search, and query (`1c2e3f0f`).
- **Atomic declared-table writes** — table upsert, an atomic transaction
  envelope, and declared-relation embedding (`e18fb3c2`).
- **A DuckBrain-backed task board example** (`654b3c5b`).
- **Prometheus and storage observability** — `/metrics` now exposes storage
  growth, ledger churn, recall usefulness, read latency, refusal counts, and
  embedding request/cache outcomes (`035d21d8`, `933b39d9`, `a530621c`,
  `781a3ba3`).
- **Visible commit/push write-path instrumentation** (`eb96389c`).

### Changed

- `bin/duckbrain.js` has an end-to-end test and a CI validation leg
  (DF-2026-12), so the published entrypoint is covered like the source CLI.
- The test-count gate reads a generated `test-counts.json` instead of the
  agent-instruction file (DF-2026-13).
- **Rate limiting** now keys buckets on the authenticated principal rather
  than the peer IP (`91d92c51`), and liveness probes are not rate-limited
  (`121aa62c`).
- **Release validation and corruption census tooling** now cover both lockfiles
  offline and provide read-only and full production `CHANGELOG_CORRUPT`
  censuses (`a68cb2c8`, `e0e42fc1`, `aa3ba932`). The latency assertion helper
  is type-declared and the performance benchmark enforces its 500 ms ceiling
  (`a5095526`, `0d43addb`).

### Fixed

- **Search** — keyword matches are preserved for exact ticket queries
  (INT-CI-035); an absent ticket-ID query is refused instead of silently
  matching nothing (TESTQ-2026-10-30-1); a `.tmp.jsonl` caught in flight no
  longer trips the namespace leak-walk (DF-2026-11); and the legacy
  `/api/search` redirect preserves `q`, `contains`, `namespace`, `limit`, and
  `allNamespaces` (`58c92472`).
- **Replay audit records** are derived from legacy row images instead of being
  misclassified as `CHANGELOG_CORRUPT` (`609c9718`).
- **HTTP error classification** — a malformed-id DELETE and an empty-body POST
  answer 4xx instead of 5xx (DF-2026-5, DF-2026-6).
- **Generic-table durability and filtering** — writes report ACHIEVED durability
  and are barriered (`47b1d5d0`); URL primary keys use text declarations
  (`887622ec`); `pk=eq` filters work on GET reads (`a6df3394`); and table POST
  carries `X-Durability` (`d4439116`).
- **CLI distribution** — a stale `dist/` announces itself instead of answering
  confidently with the wrong version (`a797a34c`).
- **CLI flags** — `--namespace` accepts the space-separated form and an unknown
  namespace in `status` fails loudly rather than defaulting (DF-2026-9).
- **QA and dogfood harness** — the dogfood runner fails closed before spawning a
  daemon, isolates scratch/ports/agent ownership, and the battery's UI-probe
  port, upgrade N/A path and act post-step were repaired.
- **Test stability** — the namespace warm-up concurrency test and the CLI E2E
  config mismatch no longer fail on timing or config drift.
- **Secrets guard** (DF-2026-20) — a "harness state excluded" failure was a
  mislabelled builtin path-class finding, not a gitleaks scope disagreement;
  the summariser now reports the finding line instead of an unrelated echo.
- **Users author scans are bounded** (PERF-014).

### Performance

- **Recall list latency** — the plain list path is bounded to top-k results,
  and cold and warm samples are labelled distinctly (`e623f99e`, `0f712522`).

## [1.1.0] - 2026-10-21

Range: `v1.0.0`..`v1.1.0` — 628 non-merge commits (16 `feat`, 114 `fix`,
4 `perf`, 59 `docs`, 14 `test`, 5 `ci`, 72 `chore`, 286 board, plus
dogfood/qa/gitreins/ops/deps). Newest feature work sits below by area; board,
QA and dogfood bookkeeping is omitted by design.

### Added

- **Custom MCP tool runtime** — a sandboxed JS/WASM runtime so an operator can
  register first-class MCP tools without patching the server (`f7a17f50`), with
  the constructor-escape probe and trust boundary documented
  (`a12164fd`).
- **MCP profiles** — multi-profile connection state plus a `tools/list` filter
  installed on both the HTTP and stdio surfaces (`690b3e9f`, `7e040c34`,
  `3bb6b521`).
- **Declared tables** — the declared-table layer is reachable from a fresh
  install via `duckbrain tables declare` (`1e46d753`), and the namespace
  OpenAPI document now exposes the memory routes (`e828d125`).
- **S3 backup surface** — `sync-all` exits nonzero and reports the aggregate on
  partial failure (`7c318cf0`), `status` gained `--full`/`--json` with a
  truncation marker (`2918da16`), a consecutive-failure alert gate covers the
  backup cron (`bb9926cf`), and in-flight requests abort on deadline so two runs
  cannot hold overlapping locks (`6cba1d8d`).
- **HTTP observability and guards** — the daemon serves the built UI
  (`6508742e`); per-route read ledger plus a query endpoint
  (`d88a2b8a`); `--allowed-hosts` / `DUCKBRAIN_ALLOWED_HOSTS` Host guard
  (`12ef5ff6`); opt-in `?debug=search` diagnostics on the REST `q=` path
  (`c95dd5e0`); structured WARN on every HTTP 429 refusal (`85ab9003`).
- **Namespace lifecycle** — loud, opt-out-able auto-create on writes
  (`03c6397d`) and two distinct deletion paths, disk-delete versus S3-clear,
  with the ghost-push root cause fixed (`e3a98527`).
- **Embedding cache** — binary float32 cache format (`ed59c708`).
- **Ops inventory** — scheduled DuckBrain ops scripts brought under version
  control with a drift guard (`29b17fbc`).

### Fixed

- Storage honours the 1000-line / 1MB segment bound and gained a consolidation
  pass (`30a82dcf`).
- Search: cross-process single-flight sidecar rebuilds, corrupt-sidecar union
  facets (`2038d9fb`), and a zero-hit result now hints at a stale index instead
  of returning bare silence (`f048cb33`).
- Git identity is resolved through the config chain instead of synthetic
  identities (`e6ac7681`), with the CI fixtures isolated accordingly
  (`46d7e204`, `f20a1d99`, `9fd87053`, `df360347`).
- `supa2` PATCH/DELETE now route through `NamespaceWriter` (`6d0a0184`), replay
  accepted mutations as real change records (`8c300858`) and read the patched
  row back under the namespace write lock (`e3fc62d0`).
- Declared-table POST enforces the declared primary key (`2c2bcaac`).
- Live SSE subscribers are revoked on auth-store hot-reload (`ff4f6edc`).
- Daemon boot warms per-namespace DuckDB connections and the search index
  (`07f5b3f8`, `32de0244`); a corrupt manifest is graded a warmup failure rather
  than "warmed" (`83b3e0f2`).
- Test-suite isolation: config-path isolation, pidfile races, hermetic git
  config and bounded teardown across the integration rigs
  (`615c5f68`, `870e37af`, `7332afcd`, `a0658023`).

### Performance

- Semantic search latency reduced from 15–30s to under 5s (`74ab6db8`).
- As-of reads batch chunk reads through one `cat-file --batch` plus a
  whole-tree `ls-tree` (`6d8e456f`).
- `list_keys` materialises the key list with write-path invalidation
  (`3d5b9c48`), removing the full-corpus rescan per call.
- CLI prefers the precompiled dist entry and lazy-loads the S3 subtree
  (`d35b5d0f`).

### Notes

- Gates at the tag point: `pnpm tsc --noEmit` clean; bounded vitest subset
  (`src/mcp/server.test.ts`, `src/ssh/client.test.ts`, `src/schema`) 2 files /
  15 tests passed. The full 233-suite battery was not run for this cut.

## [1.0.0] - 2026-04-03

### Added

#### Core Features

- **MCP Server** - Full MCP protocol implementation with stdio and HTTP transports
- **Memory Storage** - JSONL-based append-only storage with DuckDB querying
- **Vector Search** - Built-in similarity search using DuckDB VSS extension
- **Git Versioning** - Complete version control with branching and time-travel

#### MCP Tools

- `remember()` - Store memories with hierarchical keys
- `recall()` - Query memories with semantic search
- `list_keys()` - Discover available memory keys
- `forget()` - Mark memories as tombstoned

#### Web UI

- **Memory Tree** - File-explorer-style navigation with expand/collapse
- **Timeline View** - Chronological memory browser with virtual scrolling
- **Inspector Panel** - Detailed memory viewing with JSON viewer
- **Real-time Updates** - SSE-based live updates
- **Keyboard Shortcuts** - Power-user navigation (`?` for help, `Esc` to close)
- **Glassmorphism Theme** - Beautiful dark UI with Tailwind CSS v4

#### Technical Features

- **HTTP API** - Express routes wrapping MCP tools
- **Multi-Agent Support** - Git worktrees for concurrent access
- **SSH Tunneling** - Remote access without open ports
- **Docker Support** - Multi-stage builds with Alpine and Debian variants
- **Type Safety** - Full TypeScript implementation

#### Documentation

- Comprehensive README with badges and screenshots
- Generated logo and mascot assets
- UI screenshots for Tree, Timeline, and Keyboard Shortcuts
- Architecture diagrams
- Contributing guidelines

### Technical Stack

- Vite + React + TypeScript
- TanStack Query v5 + TanStack Table v8
- Zustand for state management
- Tailwind CSS v4 with custom glassmorphism theme
- DuckDB with VSS extension
- Git for version control

## [0.1.0] - 2026-03-15

### Added

- Initial project setup
- Core MCP server implementation
- Basic memory storage with JSONL
- DuckDB integration
- CLI commands (stdio, http)

---

## Future Roadmap

### Planned for v1.1.0

- [ ] Web-based memory editor
- [ ] Import/export functionality
- [ ] Advanced search filters
- [ ] Memory templates
- [ ] Collaborative editing

### Planned for v1.2.0

- [ ] Plugin system
- [ ] Custom embedding providers
- [ ] Advanced analytics dashboard
- [ ] Memory compression strategies

## Migration Guide

### Upgrading to 1.0.0

**Breaking Changes:**

- Storage format updated to JSONL v2
- API endpoints reorganized under `/api/v1/`
- Configuration file format changed

**Migration Steps:**

1. Backup your data: `cp -r data/ data-backup/`
2. Run migration: `npm run migrate:v1`
3. Verify data integrity
4. Update configuration files

## Security Notes

### v1.0.0

- Authentication via JWT tokens
- Rate limiting on HTTP endpoints
- Input validation on all MCP tools
- CORS configured for localhost development

---

For the complete list of changes, see the [commit history](https://github.com/wojons/duckbrain/commits/main).
