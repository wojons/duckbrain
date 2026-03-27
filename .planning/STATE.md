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
| 1 | Core MVP | ● In Progress | 2/4 | 50% |
| 2 | Git Automation | ○ Pending | 0/0 | 0% |
| 3 | Multi-User & Remote | ○ Pending | 0/0 | 0% |
| 4 | Web UI | ○ Pending | 0/0 | 0% |

---

## Current Position

**Last Activity:** Completed Phase 1 Plan 03 — recall() and list_keys() MCP tools
**Session:** 2026-03-27 — Core MVP implementation in progress

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

**What's next:**
- Plan 02: remember() tool (CORE-01, CORE-04)
- Plan 04: forget() tool with tombstone append

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
| **MCP stdio transport for local Claude** | ✓ Implemented |
| **Tombstone filtering at query layer** | ✓ Implemented |
| **Singleton DuckDB connection caching** | ✓ Implemented |

---

## Open Issues

(None yet — project just initialized)

---

## Session Continuity

**Last Session:** 2026-03-27
**Stopped At:** Completed Phase 1 Plan 03 - recall() and list_keys() MCP tools

**Resume Context:**
- Schema, storage, manifest, config, duckdb, and mcp modules implemented
- Commits: df57af8, b2fd2b3, 3b3943c, d9626f9, e1796af (Plan 01), 24909f6 (Plan 03)
- SUMMARY.md files: 01-core-mvp-01-SUMMARY.md, 01-core-mvp-03-SUMMARY.md
- Ready for Plan 02: remember() tool implementation

---

*Last updated: 2026-03-27 after Plan 03 completion*
