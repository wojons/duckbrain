# DuckBrain — Coding Hermes Task Board

## Open

### DB-007: Resolve 6 high-severity npm vulnerabilities
- **Severity:** Medium
- **Status:** `npm audit --audit-level=high` reports 6 high severity vulnerabilities
- **Fix:** Run `npm audit fix` first (automatic patches). Review remaining for breaking changes.

### DB-008: Clean up 40+ pre-existing tsc strictness errors
- **Severity:** Low
- **Status:** `npx tsc --noEmit` reports 40+ errors (unused vars, missing @types/express, Buffer type mismatches). Pre-existing — does not block vitest or builds. Found during DB-006 discovery sweep.
- **Fix:** Batch fix by category: (1) remove unused imports/vars, (2) install @types/express, (3) fix Buffer type issues.

### DB-001: Implement actual embedding model in recall.ts
- **File:** `src/mcp/tools/recall.ts:68-73`
- **Severity:** Medium
- **Status:** `generateEmbedding()` is a stub — always returns `null`
- **Fix:** Integrate an embedding model API. **BLOCKED — needs Bane's decision on which embedding model/API to use.**

## Monitoring (48h watch)

### DB-003: Write degradation — silent write failures
- **Status:** Likely resolved by DB-002 + DB-004. Monitoring for 48h.
- Write test confirmed working at 2026-07-12T17:36Z.

## Done

### DB-006: Fix TS6 baseUrl deprecation
- ✅ Fixed in 291184d — added `ignoreDeprecations: "6.0"` to tsconfig.json

### DB-002: DuckDB singleton connection corruption
- ✅ Fixed in f1b4509

### DB-004: Thread leak on long-running instances
- ✅ Fixed in cbf2a50

### DB-005: Missing trailing newline guard in config files
- ✅ Fixed in bdccbfa

### DB-000: CI test failures
- ✅ Fixed. 97/97 tests passing, CI green.
