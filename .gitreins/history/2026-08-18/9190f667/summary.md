# Verdict: INT-CI-004

**Task:** CI red: duckdb fts extension missing on GH runner
**Evaluated:** 2026-08-18T17:38:55.239851
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: 
    ○
    │╲
    │ ○
    ○ ░
    ░    gitleaks

[90m12:37PM[0m [32mINF[0m [1mscanned ~12325039
  ✓ lint: 
  ✓ tests: 
> duckbrain@1.0.0 test
> vitest


[1m[30m[46m RUN [49m[39m[22m [36mv4.1.10 [39m[90m/home/k
- ✓ **tier2**
  - COMPLETE
  ✓ CI (run 32160011179-class) goes green: src/search/search-retr001.test.ts 18/18 passes on a fresh runner; rebuildNamespaceIndex explicitly INSTALLs fts before LOAD (idempotent, mirrors src/duckdb/vss.ts); .github/workflows/ci.yml pre-installs + caches ~/.duckdb/extensions; local suite unchanged 465/465; tsc --noEmit clean; no test-count drift in AGENTS.md: Fix commit d5b1efb (HEAD). (1) src/search/search-retr001.test.ts has exactly 18 it() tests (lines 141-376) and `npx vitest run src/search/search-retr001.test.ts` reports 18/18 passed; cold-start failure eliminated by explicit INSTALL (commit msg: 10 failures on run 32160011179 resolved). (2) src/search/index.ts:276-292 rebuildNamespaceIndex runs execAsync(db,'INSTALL fts;') before 'LOAD fts;' with fallback retry-LOAD and descriptive error — mirrors loadVSSExtension in src/duckdb/vss.ts (INSTALL vss/LOAD vss pattern); INSTALL is idempotent. (3) .github/workflows/ci.yml:34-42 adds 'Cache DuckDB extensions' (path ~/.duckdb/extensions, key duckdb-extensions-1.4.4) and 'Pre-install DuckDB fts extension' node step. (4) `npx vitest run` → 61 files / 465 tests passed, suite unchanged. (5) `npx tsc --noEmit` exit 0, clean. (6) AGENTS.md:14 '61 suites, 465 tests' and :33 '465 tests, 61 suites' match actual run — no count drift.
All criteria verified: 18/18 FTS tests pass, rebuildNamespaceIndex explicitly INSTALLs fts before LOAD mirroring vss.ts, ci.yml pre-installs+caches ~/.duckdb/extensions, full suite 465/465, tsc clean, AGENTS.md count unchanged.

## Summary

Judge Result: INT-CI-004

Stage tier1: PASS
    ✓ secrets: 
    ○
    │╲
    │ ○
    ○ ░
    ░    gitleaks

[90m12:37PM[0m [32mINF[0m [1mscanned ~12325039
  ✓ lint: 
  ✓ tests: 
> duckbrain@1.0.0 test
> vitest


[1m[30m[46m RUN [49m[39m[22m [36mv4.1.10 [39m[90m/home/k

Stage tier2: PASS
  COMPLETE
  ✓ CI (run 32160011179-class) goes green: src/search/search-retr001.test.ts 18/18 passes on a fresh runner; rebuildNamespaceIndex explicitly INSTALLs fts before LOAD (idempotent, mirrors src/duckdb/vss.ts); .github/workflows/ci.yml pre-installs + caches ~/.duckdb/extensions; local suite unchanged 465/465; tsc --noEmit clean; no test-count drift in AGENTS.md: Fix commit d5b1efb (HEAD). (1) src/search/search-retr001.test.ts has exactly 18 it() tests (lines 141-376) and `npx vitest run src/search/search-retr001.test.ts` reports 18/18 passed; cold-start failure eliminated by explicit INSTALL (commit msg: 10 failures on run 32160011179 resolved). (2) src/search/index.ts:276-292 rebuildNamespaceIndex runs execAsync(db,'INSTALL fts;') before 'LOAD fts;' with fallback retry-LOAD and descriptive error — mirrors loadVSSExtension in src/duckdb/vss.ts (INSTALL vss/LOAD vss pattern); INSTALL is idempotent. (3) .github/workflows/ci.yml:34-42 adds 'Cache DuckDB extensions' (path ~/.duckdb/extensions, key duckdb-extensions-1.4.4) and 'Pre-install DuckDB fts extension' node step. (4) `npx vitest run` → 61 files / 465 tests passed, suite unchanged. (5) `npx tsc --noEmit` exit 0, clean. (6) AGENTS.md:14 '61 suites, 465 tests' and :33 '465 tests, 61 suites' match actual run — no count drift.
All criteria verified: 18/18 FTS tests pass, rebuildNamespaceIndex explicitly INSTALLs fts before LOAD mirroring vss.ts, ci.yml pre-installs+caches ~/.duckdb/extensions, full suite 465/465, tsc clean, AGENTS.md count unchanged.

Overall: PASS ✓
