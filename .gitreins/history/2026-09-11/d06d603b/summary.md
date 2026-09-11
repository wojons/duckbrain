# Verdict: DOGFOOD-0904-02

**Task:** P1 phantom dependency: express imported by src/cli/http.ts but never declared in package.json (fresh install boots crash)
**Evaluated:** 2026-09-11T12:24:35.155455
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✓ secrets: [90m7:14AM[0m [32mINF[0m [1mscanned ~7876670 bytes (7.88 MB) in 1.58s[0m
[90m7:14AM[0m [32m
  ✗ tests: 
 RUN  v4.1.10 /home/kara/duckbrain

 ❯ src/search/search-retr007.test.ts (10 tests | 10 skipped) 10
- ✓ **tier2**
  - COMPLETE
  ✓ express is declared in package.json dependencies (semver-compatible with the lockfile-resolved 5.2.1); pnpm install --frozen-lockfile exits 0; a committed regression test asserts the dependency declaration and root-package resolution of express; full unit suite + tsc + prettier green; server boots from the repo after the change.: (a) Declaration: package.json dependencies now contains "express": "^5.2.1" (added in commit ee480f4); pnpm-lock.yaml importer block lines 26-28 records specifier ^5.2.1 -> version 5.2.1, and express@5.2.1 is the resolved package (pnpm-lock.yaml:1001, :2771) — semver-compatible with the lockfile-resolved 5.2.1. (b) `pnpm install --frozen-lockfile` -> exit 0, output 'Already up to date / Done in 438ms using pnpm v11.13.1'. (c) Committed regression test src/utils/dependency-declaration.test.ts (67 lines, added in ee480f4) asserts the manifest declaration (dependencies contains 'express', range matches /^\^?5\./, not hidden in devDependencies) and root-package resolution via createRequire(<repo>/package.json).resolve('express') -> path contains node_modules/express/ with version 5.x; `npx vitest run src/utils/dependency-declaration.test.ts` -> 'Test Files 1 passed (1) / Tests 4 passed (4)'. (d) `npx tsc --noEmit` -> exit 0, no output. (e) Prettier: changed files are clean — `npx prettier --check src/utils/dependency-declaration.test.ts package.json` -> 'All matched files use Prettier code style!' (exit 0); repo-wide `prettier --check .` reports 467 pre-existing unformatted files (docs/, README.md, pnpm-lock.yaml, examples/) that predate and are unrelated to this change. (f) Full unit suite (`npx vitest run`, the configured test_command): run 3 -> 'Test Files 115 passed (115) / Tests 944 passed (944)'. Two earlier runs showed load-induced timeouts in src/search/search-retr007.test.ts / search-retr008.test.ts (beforeAll hook timed out in 10000ms) and src/search/hooks.test.ts ('rebuild is idempotent' test timed out in 15000ms); those three files pass 29/29 when run with --maxWorkers=1, and none of them touch express — the flake is pre-existing concurrency contention, not caused by this change. (g) Server boot: `node bin/duckbrain.js http --port 34567` logged '[duckbrain] HTTP server started at http://127.0.0.1:34567' / '[duckbrain] HTTP server ready', and `curl http://127.0.0.1:34567/health` returned HTTP=200 {"status":"healthy",...}. express resolves from the repo root (node_modules/express -> .pnpm/express@5.2.1/node_modules/express, version 5.2.1) and is imported by src/cli/http.ts:19 and 10 other src files, so the phantom-dependency crash is fixed.
express is now a declared root dependency (^5.2.1, lockfile-resolved 5.2.1) with a committed regression test, frozen-lockfile install/tsc/prettier clean, full suite green (115 files / 944 tests), and the HTTP server boots and serves /health 200.

## Summary

Judge Result: DOGFOOD-0904-02

Stage tier1: FAIL
    ✓ secrets: [90m7:14AM[0m [32mINF[0m [1mscanned ~7876670 bytes (7.88 MB) in 1.58s[0m
[90m7:14AM[0m [32m
  ✗ tests: 
 RUN  v4.1.10 /home/kara/duckbrain

 ❯ src/search/search-retr007.test.ts (10 tests | 10 skipped) 10

Stage tier2: PASS
  COMPLETE
  ✓ express is declared in package.json dependencies (semver-compatible with the lockfile-resolved 5.2.1); pnpm install --frozen-lockfile exits 0; a committed regression test asserts the dependency declaration and root-package resolution of express; full unit suite + tsc + prettier green; server boots from the repo after the change.: (a) Declaration: package.json dependencies now contains "express": "^5.2.1" (added in commit ee480f4); pnpm-lock.yaml importer block lines 26-28 records specifier ^5.2.1 -> version 5.2.1, and express@5.2.1 is the resolved package (pnpm-lock.yaml:1001, :2771) — semver-compatible with the lockfile-resolved 5.2.1. (b) `pnpm install --frozen-lockfile` -> exit 0, output 'Already up to date / Done in 438ms using pnpm v11.13.1'. (c) Committed regression test src/utils/dependency-declaration.test.ts (67 lines, added in ee480f4) asserts the manifest declaration (dependencies contains 'express', range matches /^\^?5\./, not hidden in devDependencies) and root-package resolution via createRequire(<repo>/package.json).resolve('express') -> path contains node_modules/express/ with version 5.x; `npx vitest run src/utils/dependency-declaration.test.ts` -> 'Test Files 1 passed (1) / Tests 4 passed (4)'. (d) `npx tsc --noEmit` -> exit 0, no output. (e) Prettier: changed files are clean — `npx prettier --check src/utils/dependency-declaration.test.ts package.json` -> 'All matched files use Prettier code style!' (exit 0); repo-wide `prettier --check .` reports 467 pre-existing unformatted files (docs/, README.md, pnpm-lock.yaml, examples/) that predate and are unrelated to this change. (f) Full unit suite (`npx vitest run`, the configured test_command): run 3 -> 'Test Files 115 passed (115) / Tests 944 passed (944)'. Two earlier runs showed load-induced timeouts in src/search/search-retr007.test.ts / search-retr008.test.ts (beforeAll hook timed out in 10000ms) and src/search/hooks.test.ts ('rebuild is idempotent' test timed out in 15000ms); those three files pass 29/29 when run with --maxWorkers=1, and none of them touch express — the flake is pre-existing concurrency contention, not caused by this change. (g) Server boot: `node bin/duckbrain.js http --port 34567` logged '[duckbrain] HTTP server started at http://127.0.0.1:34567' / '[duckbrain] HTTP server ready', and `curl http://127.0.0.1:34567/health` returned HTTP=200 {"status":"healthy",...}. express resolves from the repo root (node_modules/express -> .pnpm/express@5.2.1/node_modules/express, version 5.2.1) and is imported by src/cli/http.ts:19 and 10 other src files, so the phantom-dependency crash is fixed.
express is now a declared root dependency (^5.2.1, lockfile-resolved 5.2.1) with a committed regression test, frozen-lockfile install/tsc/prettier clean, full suite green (115 files / 944 tests), and the HTTP server boots and serves /health 200.

Overall: FAIL ✗
