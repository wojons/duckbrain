---
phase: 01-core-mvp
plan: 03
subsystem: mcp
tags: mcp, duckdb, typescript, zod, recall, list_keys

# Dependency graph
requires:
  - phase: 01-core-mvp
    provides: Schema, storage, and manifest utilities
provides:
  - recall() MCP tool with multiple query modes (exact key, prefix glob, domain filter)
  - list_keys() MCP tool with pagination and depth limits
  - MCP server with stdio transport
  - DuckDB connection and query layer
affects:
  - 01-core-mvp-04 (Git automation and remember/forget tools)
  - 02-core-mvp-01 (Embedding model integration for semantic search)

# Tech tracking
tech-stack:
  added:
    - "@modelcontextprotocol/sdk@1.28.0"
    - "duckdb@1.4.4"
  patterns:
    - MCP tool pattern with Zod validation
    - Tombstone filtering in all queries
    - Singleton DuckDB connection caching
    - Hierarchical key exploration with depth limits

key-files:
  created:
    - src/mcp/tools/recall.ts
    - src/mcp/tools/list_keys.ts
    - src/mcp/server.ts
    - src/duckdb/connection.ts
    - src/duckdb/queries.ts
  modified: []

key-decisions:
  - Used MCP SDK stdio transport for local Claude integration
  - Implemented tombstone filtering at query layer (WHERE action != 'tombstone')
  - Semantic search deferred to Phase 2 (requires embedding model integration)
  - Singleton connection pattern for DuckDB to avoid recreation overhead

patterns-established:
  - "MCP Tool Pattern: Zod schema validation → namespace resolution → DuckDB query → structured response"
  - "Query modes: exact key, prefix glob, domain filter, semantic (Phase 2)"
  - "list_keys() guardrail: prevents AI path hallucinations with controlled exploration"

requirements-completed: [CORE-02, CORE-03, SCHEMA-03]

# Metrics
duration: 10 min
completed: 2026-03-27
---

# Phase 01: Core MVP Plan 03 Summary

**recall() and list_keys() MCP tools with Zod validation, DuckDB queries, and stdio server**

## Performance

- **Duration:** 10 min
- **Started:** 2026-03-27T15:48:00Z
- **Completed:** 2026-03-27T15:58:13Z
- **Tasks:** 4
- **Files modified:** 5

## Accomplishments

- recall() MCP tool with 4 query modes: exact key, prefix glob, domain filter, semantic search
- list_keys() MCP tool with pagination (offset/limit), depth limits, and prefix counts
- MCP server with stdio transport, all 4 tools registered (remember/forget stubs for future plans)
- Zod validation on all tool inputs rejecting invalid data with clear errors
- DuckDB connection management with singleton caching
- Tombstone filtering in all query paths (WHERE action != 'tombstone')

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement recall() MCP tool** - `24909f6` (feat)
   - Also includes Task 2 (list_keys), Task 3 (MCP server), Task 4 (Zod validation)
   - All 4 tools implemented in single commit for coherence

**Plan metadata:** Pending final commit

## Files Created/Modified

- `src/mcp/tools/recall.ts` - Recall tool with exact key, prefix, domain, and semantic query modes
- `src/mcp/tools/list_keys.ts` - List keys tool with pagination, depth limits, prefix exploration
- `src/mcp/server.ts` - MCP server with stdio transport, registers all 4 tools
- `src/duckdb/connection.ts` - DuckDB connection management with singleton caching
- `src/duckdb/queries.ts` - Query layer for memories with tombstone filtering

## Decisions Made

- **Stdio transport only for Phase 1** - HTTP MCP deferred to Phase 2 (CLI-02)
- **Semantic search placeholder** - Returns error "requires embedding model - configure in Phase 2" until embedding integration
- **Singleton DuckDB connections** - Cache per namespace to avoid recreation overhead
- **Tombstone filtering at query layer** - All queries filter WHERE action != 'tombstone' per RESEARCH.md

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed DuckDB import path**
- **Found during:** Task 1 (recall implementation)
- **Issue:** Code referenced `@duckdb/duckdb` but installed package is `duckdb`
- **Fix:** Changed imports from `import { Database } from '@duckdb/duckdb'` to `import duckdb from 'duckdb'` with type alias
- **Files modified:** src/duckdb/connection.ts, src/duckdb/queries.ts
- **Verification:** Modules load correctly with tsx
- **Committed in:** 24909f6

**2. [Rule 3 - Blocking] Fixed MCP SDK import paths**
- **Found during:** Task 3 (MCP server setup)
- **Issue:** Imports from `@modelcontextprotocol/sdk/mcp.js` failed - correct path is `/server/mcp.js`
- **Fix:** Updated imports to `@modelcontextprotocol/sdk/server/mcp.js` and `/server/stdio.js`
- **Files modified:** src/mcp/server.ts
- **Verification:** Server module loads correctly
- **Committed in:** 24909f6

---

**Total deviations:** 2 auto-fixed (both blocking import path issues)
**Impact on plan:** Minor import corrections, no scope change. All functionality implemented as planned.

## Issues Encountered

- **Namespace doesn't exist yet** - Tools return "Namespace 'default' does not exist" error until remember() tool creates it in Plan 04
- **Semantic search not available** - Intentionally deferred to Phase 2, returns helpful error message

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- recall() ready for exact key, prefix glob, and domain filter queries
- list_keys() ready for hierarchical key exploration with pagination
- MCP server ready for stdio transport integration with local Claude
- **Blocked on:** remember() and forget() tools (Plan 02 and 04) to populate/test with real data
- **Phase 2 needs:** Embedding model integration for semantic search in recall()

---

*Phase: 01-core-mvp*
*Completed: 2026-03-27*
