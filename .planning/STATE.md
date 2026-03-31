# DuckBrain — Project State

**Project:** DuckBrain
**Status:** Initialized — Ready for Phase 1 planning
**Current Focus:** Phase 1: Core MVP

---

## Project Reference

See: `.planning/PROJECT.md` (updated 2026-03-27)

**Core value:** Agents can remember and learn across sessions with full history, zero-cost branching, and collaborative sharing — all without database operations.

**Current focus:** Phase 1: Core MVP — Working MCP server with basic remember/recall, JSONL storage, DuckDB queries

---

## Phase Status

| Phase | Name | Status | Plans | Progress |
|-------|------|--------|-------|----------|
| 1 | Core MVP | ● Complete | 4/4 | 100% |
| 2 | Git Automation | ◐ In Progress | 1/3 | 33% |
| 3 | Multi-User & Remote | ○ Pending | 0/0 | 0% |
| 4 | Web UI | ○ Pending | 0/0 | 0% |

---

## Current Position

**Last Activity:** Completed Phase 2 Plan 02 — Squash/compaction process
**Session:** 2026-03-31 — Git Automation in progress

**What we have:**
- PROJECT.md — Full vision and requirements captured
- REQUIREMENTS.md — 24 requirements across v1/v2
- ROADMAP.md — 4 phases with success criteria
- Codebase map — `.planning/codebase/` (7 documents)
- **src/schema/memory.ts** — Hybrid memory schema with Zod validation
- **src/storage/jsonl.ts** — Partitioned JSONL storage utilities
- **src/storage/manifest.ts** — Manifest file tracking
- **src/config/index.ts** — Configuration management
- **src/duckdb/connection.ts** — DuckDB connection management
- **src/duckdb/queries.ts** — DuckDB query layer with tombstone filtering
- **src/mcp/server.ts** — MCP server with stdio transport
- **src/mcp/tools/recall.ts** — recall() tool with 4 query modes
- **src/mcp/tools/list_keys.ts** — list_keys() guardrail tool
- **src/mcp/tools/remember.ts** — remember() MCP tool (stub)
- **src/mcp/tools/forget.ts** — forget() MCP tool (stub)
- **src/cli/stdio.ts** — Stdio MCP entry point
- **src/cli/http.ts** — HTTP MCP server with admin endpoints
- **src/cli/human.ts** — Human operator CLI commands
- **bin/duckbrain** — CLI executable with command routing
- **.opencode/agents/duckbrain-cli.md** — Comprehensive CLI documentation
- **src/git/squash.ts** — Squash/compaction with Parquet conversion
- **src/mcp/tools/squash.ts** — MCP squash tool for agents
- **src/config/index.ts** — Squash configuration options

**What's next:**
- Phase 2 Plan 01: Async git commit batching (GIT-01)
- Phase 2 Plan 03: Merge conflict resolution (GIT-03)

---

## Key Decisions

| Decision | Status |
|----------|--------|
| Name: DuckBrain | ✓ Confirmed |
| Hybrid schema (strict base + flexible attributes) | ✓ Confirmed |
| Hierarchical key field (filesystem-style paths) | ✓ Confirmed |
| Append-only + tombstones (no row updates) | ✓ Confirmed |
| Async git batching (background worker) | ✓ Confirmed |
| Git worktrees for HTTP mode | ✓ Confirmed |
| Manifest index for partition tracking | ✓ Confirmed |
| SSH tunneling for remote access | ✓ Confirmed |
| Namespace = Git repo | ✓ Confirmed |
| **Zod v4.1.8 for runtime validation** | ✓ Implemented |
| **Atomic writes (tmp+rename) for config/manifest** | ✓ Implemented |
| **Chunked JSONL (1000 lines or 1MB max)** | ✓ Implemented |
| **DuckDB singleton connection pattern** | ✓ Implemented |
| **Time-based partitioning (YYYY-MM)** | ✓ Implemented |
| **Hybrid MCP tool responses** | ✓ Implemented |
| **MCP stdio transport for local Claude** | ✓ Implemented |
| **Tombstone filtering at query layer** | ✓ Implemented |
| **Singleton DuckDB connection caching** | ✓ Implemented |
| **Stdio MCP entry point** | ✓ Implemented (Plan 04) |
| **HTTP MCP server with DNS protection** | ✓ Implemented (Plan 04) |
| **Human CLI commands** | ✓ Implemented (Plan 04) |
| **CLI executable with bin config** | ✓ Implemented (Plan 04) |
| **Squash/compaction with Parquet** | ✓ Implemented (Phase 2 Plan 02) |
| **MCP squash tool** | ✓ Implemented (Phase 2 Plan 02) |
| **CLI squash command** | ✓ Implemented (Phase 2 Plan 02) |
| **Squash configuration** | ✓ Implemented (Phase 2 Plan 02) |

---

## Open Issues

(None yet — project just initialized)

---

## Session Continuity

**Last Session:** 2026-03-31
**Stopped At:** Completed Phase 2 Plan 02 — Squash/Compaction (GIT-02)

**Resume Context:**
- Phase 2 Git Automation IN PROGRESS (1/3 plans complete)
- Squash module implemented: squashPartition, compactHistory, removeTombstones, getCompactionStats
- MCP tools: squash, get_compaction_stats registered and working
- CLI command: duckbrain squash --stats|--dry-run|--partition|--aggressive
- Config options: squash.maxAgeDays, squash.thresholdRecords, squash.autoCompact, etc.
- Commits: 5 (746e292, fdd351d, aea770a, 2c654e6, 65c44d8)
- SUMMARY: 02-git-auto-02-SUMMARY.md created
- Remaining: Plan 01 (git batching), Plan 03 (merge conflicts)

---

*Last updated: 2026-03-31 after Phase 2 Plan 02 completion*
