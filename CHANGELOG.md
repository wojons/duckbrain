# Changelog

All notable changes to DuckBrain will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
