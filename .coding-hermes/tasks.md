# DuckBrain — Coding Hermes Task Board

## Open

### DB-001: Implement actual embedding model in recall.ts
- **File:** `src/mcp/tools/recall.ts:68-73`
- **Severity:** Medium
- **Status:** `generateEmbedding()` is a stub — always returns `null`
- **Impact:** Semantic search (`query` parameter) always fails with "requires embedding model - configure in Phase 2"
- **Fix:** Integrate an embedding model API (OpenAI, local model, etc.)

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

## Done

### DB-000: CI test failures (9 unit + 4 integration)
- ✅ Fixed in 520b033 + f072166 + 8672584
- 97/97 tests passing, CI green on Node 20.x and 22.x

### DB-002: DuckDB singleton connection corruption
- ✅ Fixed in f1b4509 — root-caused to :memory: database accumulating state from repeated read_json() across different file sets. Switched singleton to file-backed duckdb.db (matching what the per-query workaround already proved functional). Removed the per-query workaround from recall.ts.

### DB-005: Missing trailing newline guard in config files
- ✅ Fixed in bdccbfa — appended `'\n'` to all 8 `JSON.stringify()` calls paired with `writeFileSync` across 5 files (namespace.ts, manifest.ts, config/index.ts, cli/human.ts, squash.ts).
