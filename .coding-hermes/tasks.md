# DuckBrain — Coding Hermes Task Board

## Open

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

### DB-008: Clean up tsc strictness errors
- ✅ Fixed in e67b6d7 — installed @types/express + async-mutex, removed unused imports, prefixed unused params with _, exported Database from connection.ts, fixed Buffer types in client.test.ts via `: any` return type. 29 files, 156 insertions, 124 deletions. tsc: 0 errors, vitest: 65/65 pass, guard: PASS.

### DB-009: Pre-existing secrets guard false positive
- ✅ Fixed in d7d3d4f + c3471ca — added .opencode/ and namespaces/ to gitleaks allowlist. Root cause: TOML single-quoted strings are literal — `'''\\\\.opencode/.*'''` matched literal backslash, not dot. Fixed to `'''\.opencode/.*'''`. Also fixed [[rules]] section patterns. Guard: PASS.

### DB-007: Resolve 6 high-severity npm vulnerabilities
- ✅ Fixed in 2277fa6 — simple-git 3.33.0→3.36.0 (RCE fix). 5 remaining tar vulns are transitive via duckdb→node-gyp (build-time only, no fix available). All 65 vitest tests pass.

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
