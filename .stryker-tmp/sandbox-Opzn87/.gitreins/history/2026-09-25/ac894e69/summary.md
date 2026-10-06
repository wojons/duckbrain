# Verdict: DF-0924-02

**Task:** P0 release gap: origin/main stale default branch
**Evaluated:** 2026-09-25T23:39:46.426978
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: Command timed out
- ✓ **tier2**
  - COMPLETE
  ✓ origin/main contains current HEAD (src/git/asof.ts + express); fresh clone boots with pnpm install --frozen-lockfile (express resolves); fresh-clone daemon returns 400 for pre-history as_of and 200-with-ref-state for valid as_of; default-branch README matches default-branch code: All four sub-claims verified end-to-end. (a) origin/main == HEAD: `git rev-parse HEAD` = `git rev-parse origin/main` = 42cea0a1280c8d4937d95285b1f8c72feacaa62d; `git cat-file -e origin/main:src/git/asof.ts` -> EXISTS; `git show origin/main:package.json` line 45 `"express": "^5.2.1"` and pnpm-lock.yaml has express@5.2.1 (lines 2000, 4808). (b) Fresh clone: `git clone /home/kara/duckbrain /tmp/eval-fresh-0924/fresh` -> HEAD 42cea0a, node_modules ABSENT; `pnpm install --frozen-lockfile --store-dir /tmp/eval-fresh-0924/store` -> exit 0, output `Packages: +476 ... Done in 11.3s using pnpm v12.4.2` with `+ express 5.2.1`; symlinks OK for express/duckdb/simple-git/tsx/zod + packages/ui/node_modules/react; `node -e require('express/package.json').version` -> 5.2.1; `node bin/duckbrain.js help` -> `DuckBrain v1.0.0 - AI Memory System` exit 0. (c) Fresh-clone daemon booted on :3799 (/health 200): PROBE A `?as_of=2020-01-01` -> HTTP 400 `{"error":"No commit found at or before 2020-01-01","code":"VALIDATION_ERROR"}`; PROBE B `?as_of=5a1ea1e` -> HTTP 200 total=1 items[0].key=/eval/one content="first memory"; PROBE C `?as_of=6ea3289` -> HTTP 200 total=2 (both /eval/two + /eval/one). Code path: src/http/routes/memories.ts:331-341 resolveAsOfRef -> ValidationError(400); src/git/asof.ts:126-172. (d) `git diff origin/main -- README.md` -> EMPTY (identical); README:30 claims as-of recall "Available now", README:38 names src/git/asof.ts + resolveAsOfRef (matches src/git/asof.ts:126); README:102 `pnpm install`, :105 `pnpm run dev` (package.json:18), :110 `pnpm start http --port=3000` (package.json:16), :121 POST /api/namespaces (src/http/routes/namespaces.ts:128), :129 GET /api/memories/key/... (src/http/routes/memories.ts:451 `/key/*key`); badges version 1.0.0 = package.json:3, TypeScript 7.0 = package.json:56, DuckDB v1.4 = package.json:44; docs/guide/positioning.md:84,116 cite src/git/asof.ts:126/:212/:361 which resolve to resolveAsOfRef@126, readRowsAtRef@212, queryMemoriesAtRef@361 — all correct. TESTS: `npx vitest run src/git/asof.test.ts src/http/routes/memories-asof-retr004.test.ts src/cli/recall-asof-retr004.test.ts` -> exit 0, `Test Files 3 passed (3) | Tests 28 passed (28)`. src/git/asof-ddl-compat.test.ts failed once under parallel load (15s timeout) but passes in isolation (`Test Files 1 passed (1) | Tests 1 passed (1)`, 11.95s) — flaky timeout, not a defect. [resolution 0.02; src/git/asof.ts]


## Summary

Judge Result: DF-0924-02

Stage tier1: FAIL
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: Command timed out

Stage tier2: PASS
  COMPLETE
  ✓ origin/main contains current HEAD (src/git/asof.ts + express); fresh clone boots with pnpm install --frozen-lockfile (express resolves); fresh-clone daemon returns 400 for pre-history as_of and 200-with-ref-state for valid as_of; default-branch README matches default-branch code: All four sub-claims verified end-to-end. (a) origin/main == HEAD: `git rev-parse HEAD` = `git rev-parse origin/main` = 42cea0a1280c8d4937d95285b1f8c72feacaa62d; `git cat-file -e origin/main:src/git/asof.ts` -> EXISTS; `git show origin/main:package.json` line 45 `"express": "^5.2.1"` and pnpm-lock.yaml has express@5.2.1 (lines 2000, 4808). (b) Fresh clone: `git clone /home/kara/duckbrain /tmp/eval-fresh-0924/fresh` -> HEAD 42cea0a, node_modules ABSENT; `pnpm install --frozen-lockfile --store-dir /tmp/eval-fresh-0924/store` -> exit 0, output `Packages: +476 ... Done in 11.3s using pnpm v12.4.2` with `+ express 5.2.1`; symlinks OK for express/duckdb/simple-git/tsx/zod + packages/ui/node_modules/react; `node -e require('express/package.json').version` -> 5.2.1; `node bin/duckbrain.js help` -> `DuckBrain v1.0.0 - AI Memory System` exit 0. (c) Fresh-clone daemon booted on :3799 (/health 200): PROBE A `?as_of=2020-01-01` -> HTTP 400 `{"error":"No commit found at or before 2020-01-01","code":"VALIDATION_ERROR"}`; PROBE B `?as_of=5a1ea1e` -> HTTP 200 total=1 items[0].key=/eval/one content="first memory"; PROBE C `?as_of=6ea3289` -> HTTP 200 total=2 (both /eval/two + /eval/one). Code path: src/http/routes/memories.ts:331-341 resolveAsOfRef -> ValidationError(400); src/git/asof.ts:126-172. (d) `git diff origin/main -- README.md` -> EMPTY (identical); README:30 claims as-of recall "Available now", README:38 names src/git/asof.ts + resolveAsOfRef (matches src/git/asof.ts:126); README:102 `pnpm install`, :105 `pnpm run dev` (package.json:18), :110 `pnpm start http --port=3000` (package.json:16), :121 POST /api/namespaces (src/http/routes/namespaces.ts:128), :129 GET /api/memories/key/... (src/http/routes/memories.ts:451 `/key/*key`); badges version 1.0.0 = package.json:3, TypeScript 7.0 = package.json:56, DuckDB v1.4 = package.json:44; docs/guide/positioning.md:84,116 cite src/git/asof.ts:126/:212/:361 which resolve to resolveAsOfRef@126, readRowsAtRef@212, queryMemoriesAtRef@361 — all correct. TESTS: `npx vitest run src/git/asof.test.ts src/http/routes/memories-asof-retr004.test.ts src/cli/recall-asof-retr004.test.ts` -> exit 0, `Test Files 3 passed (3) | Tests 28 passed (28)`. src/git/asof-ddl-compat.test.ts failed once under parallel load (15s timeout) but passes in isolation (`Test Files 1 passed (1) | Tests 1 passed (1)`, 11.95s) — flaky timeout, not a defect. [resolution 0.02; src/git/asof.ts]


Overall: FAIL ✗
