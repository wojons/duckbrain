# DuckBrain — Coding Hermes Task Board

## Open

### DB-001: Implement actual embedding model in recall.ts
- **File:** `src/mcp/tools/recall.ts:68-73`
- **Severity:** Medium
- **Status:** `generateEmbedding()` is a stub — always returns `null`
- **Impact:** Semantic search (`query` parameter) always fails with "requires embedding model - configure in Phase 2"
- **Fix:** Integrate an embedding model API (OpenAI, local model, etc.)

### DB-002: DuckDB singleton connection corruption
- **File:** `src/mcp/tools/recall.ts:129-134`
- **Severity:** High
- **Status:** Worked around with per-query connections for multi-partition queries
- **Impact:** Singleton cached connections crash DuckDB Node.js bindings (Napi::Error) when querying across multiple partitions with key/prefix filters
- **Fix:** Root-cause the DuckDB connection corruption; remove the per-query workaround

### DB-003: Write degradation — silent write failures
- **File:** DuckDB MCP server (infrastructure)
- **Severity:** Critical
- **Status:** 4 confirmed episodes in ~13 days (June 1-4, June 6, June 12, June 15)
- **Impact:** `remember` returns `success: true` but data is never persisted. Cron context-sync runs produce "INTENDED FACTS" that silently vanish
- **Fix:** Server-side investigation needed — may be DuckDB file locking, git auto-commit race, or MCP transport issue

### DB-004: Thread leak on long-running instances
- **File:** DuckDB MCP server (infrastructure)
- **Severity:** High
- **Status:** Confirmed on N100 machine (1,359 threads, 865MB RSS after 18 days uptime)
- **Impact:** Memory exhaustion, eventual OOM on long-running servers
- **Fix:** Investigate thread lifecycle in DuckDB Node.js bindings; add periodic restart

### DB-005: Missing trailing newline guard in config files
- **File:** `duckbrain.config.json` + any JSON config writer
- **Severity:** Low
- **Status:** Fixed manually in 854a668, but no automated guard
- **Impact:** Config writes leave files without trailing newlines; cosmetic but triggers unnecessary diffs
- **Fix:** Add trailing newline enforcement in config write paths

## Done

### DB-000: CI test failures (9 unit + 4 integration)
- ✅ Fixed in 520b033 + f072166 + 8672584
- 97/97 tests passing, CI green on Node 20.x and 22.x
