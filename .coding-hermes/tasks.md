# DuckBrain — Coding Hermes Task Board

## Open

### DB-006: Fix TS6 baseUrl deprecation before TS7 breaks build
- **File:** `tsconfig.json:21`
- **Severity:** Low (today), High (when TS7 ships)
- **Status:** `npx tsc --noEmit` warns: `Option 'baseUrl' is deprecated and will stop functioning in TypeScript 7.0`
- **Impact:** Build passes now (exit 0) but will break on TS7 upgrade. Currently pinned to TS 6.0.3.
- **Fix:** Add `"ignoreDeprecations": "6.0"` to compilerOptions in tsconfig.json, OR migrate away from baseUrl.

### DB-007: Resolve 6 high-severity npm vulnerabilities
- **Severity:** Medium
- **Status:** `npm audit --audit-level=high` reports 6 high severity vulnerabilities
- **Fix:** Run `npm audit fix` first (automatic patches). Review remaining for breaking changes.

### DB-001: Implement actual embedding model in recall.ts
- **File:** `src/mcp/tools/recall.ts:68-73`
- **Severity:** Medium
- **Status:** `generateEmbedding()` is a stub — always returns `null`
- **Impact:** Semantic search (`query` parameter) always fails
- **Fix:** Integrate an embedding model API. **BLOCKED — needs Bane's decision on which embedding model/API to use.**

## Monitoring (48h watch)

### DB-003: Write degradation — silent write failures
- **Status:** Likely resolved by DB-002 + DB-004. Monitoring for 48h.
- Write test confirmed working at 2026-07-12T17:36Z. Check context-sync output for July 12-14.

## Done

### DB-002: DuckDB singleton connection corruption
- ✅ Fixed in f1b4509

### DB-004: Thread leak on long-running instances
- ✅ Fixed in cbf2a50

### DB-005: Missing trailing newline guard in config files
- ✅ Fixed in bdccbfa

### DB-000: CI test failures
- ✅ Fixed. 97/97 tests passing, CI green.
