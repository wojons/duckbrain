# DuckBrain — Coding Hermes Task Board

## Open

### DB-001: Implement actual embedding model in recall.ts
- **File:** `src/mcp/tools/recall.ts:68-73`
- **Severity:** Medium
- **Status:** `generateEmbedding()` is a stub — always returns `null`
- **Impact:** Semantic search (`query` parameter) always fails with "requires embedding model - configure in Phase 2"
- **Fix:** Integrate an embedding model API (OpenAI, local model, etc.). **BLOCKED — needs Bane's decision on which embedding model/API to use.**

## Monitoring (48h watch)

### DB-003: Write degradation — silent write failures
- **File:** DuckDB MCP server (infrastructure)
- **Severity:** Critical → **Likely resolved by DB-002 + DB-004**
- **Status:** Foreman investigation 2026-07-12: write→read cycle confirmed working. No active degradation. Context-sync from July 11 still showed INTENDED FACTS (pre-fix). DB-002 (singleton corruption) and DB-004 (thread leak) are the probable root causes — both now fixed. MCP server freshly restarted, 51Gi RAM free.
- **Action:** Monitor for 48h. If no new INTENDED FACTS appear in context-sync output → mark resolved. If they reappear → escalate to Bane for server-side DuckDB file locking investigation.
- **Investigation note:** Write test (`/test/write-degradation-check-20260712`) created and verified at 2026-07-12T17:36Z. Check context-sync output for July 12-14.

## Done

### DB-000: CI test failures (9 unit + 4 integration)
- ✅ Fixed in 520b033 + f072166 + 8672584
- 97/97 tests passing, CI green on Node 20.x and 22.x

### DB-002: DuckDB singleton connection corruption
- ✅ Fixed in f1b4509 — root-caused to :memory: database accumulating state. Switched to file-backed duckdb.db. Removed per-query workaround.

### DB-004: Thread leak on long-running instances
- ✅ Fixed in cbf2a50 — connection lifecycle management. Cached >1h → closed and recreated.

### DB-005: Missing trailing newline guard in config files
- ✅ Fixed in bdccbfa — appended `'\n'` to all 8 JSON.stringify() calls across 5 files.
