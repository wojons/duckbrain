# Verdict: DOC-13

**Task:** Document process-read DUCKBRAIN env vars
**Evaluated:** 2026-10-11T08:25:12.442656
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✓ docs/guide/configuration.md documents each of DUCKBRAIN_UI_DIST_DIR, DUCKBRAIN_DATA_DIR, DUCKBRAIN_S3_ACCESS_KEY_ID, DUCKBRAIN_S3_SECRET_ACCESS_KEY, DUCKBRAIN_GIT_AUTHOR_NAME, DUCKBRAIN_GIT_AUTHOR_EMAIL with source location, default, and precedence: All 6 vars present in the Environment Variables table of docs/guide/configuration.md (lines 14, 17, 31, 32, 33, 34), each with a Default column value and a Description citing source location + precedence. Verified against code: DUCKBRAIN_DATA_DIR (line 14) → src/utils/pidfile.ts:59 `dir || process.env.DUCKBRAIN_DATA_DIR || perUidPidDir()`, default 'per-uid/pid dir' ✓; DUCKBRAIN_UI_DIST_DIR (line 17) → src/cli/http.ts:88-89 env override else upward scan for packages/ui/dist ✓; DUCKBRAIN_S3_ACCESS_KEY_ID (line 31) → src/s3/query.ts:107 `AWS_ACCESS_KEY_ID ?? DUCKBRAIN_S3_ACCESS_KEY_ID` (docs 'Falls back to AWS_ACCESS_KEY_ID') ✓; DUCKBRAIN_S3_SECRET_ACCESS_KEY (line 32) → src/s3/query.ts:109-110 ✓; DUCKBRAIN_GIT_AUTHOR_NAME (line 33) → src/git/identity.ts:121-137 precedence repo-local > global > env > null(throws) ✓; DUCKBRAIN_GIT_AUTHOR_EMAIL (line 34) → src/git/identity.ts:124-137 same precedence ✓. Test-setup seed values in docs match src/test-setup.ts:50-51. Tests run fresh: `npx vitest run src/git/identity.test.ts src/git/attribution.test.ts` → exit_code 0, 'Test Files 2 passed (2), Tests 16 passed (16)'; `npx vitest run src/cli/http-ui-static-df092408.test.ts src/config/df100301-data-dir-dead.test.ts` → exit_code 0, 'Tests 12 passed (12)'; `npx vitest run src/s3/query-scheme-s3queryscheme001.test.ts src/s3/cli-query.test.ts` → exit_code 0, 'Tests 14 passed (14)'. [resolution 0.38; docs/guide/configuration.md]
All six process-read DUCKBRAIN env vars are documented in docs/guide/configuration.md with source locations, defaults, and precedence that match the actual code, and all related tests pass.

## Summary

Judge Result: DOC-13

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✓ docs/guide/configuration.md documents each of DUCKBRAIN_UI_DIST_DIR, DUCKBRAIN_DATA_DIR, DUCKBRAIN_S3_ACCESS_KEY_ID, DUCKBRAIN_S3_SECRET_ACCESS_KEY, DUCKBRAIN_GIT_AUTHOR_NAME, DUCKBRAIN_GIT_AUTHOR_EMAIL with source location, default, and precedence: All 6 vars present in the Environment Variables table of docs/guide/configuration.md (lines 14, 17, 31, 32, 33, 34), each with a Default column value and a Description citing source location + precedence. Verified against code: DUCKBRAIN_DATA_DIR (line 14) → src/utils/pidfile.ts:59 `dir || process.env.DUCKBRAIN_DATA_DIR || perUidPidDir()`, default 'per-uid/pid dir' ✓; DUCKBRAIN_UI_DIST_DIR (line 17) → src/cli/http.ts:88-89 env override else upward scan for packages/ui/dist ✓; DUCKBRAIN_S3_ACCESS_KEY_ID (line 31) → src/s3/query.ts:107 `AWS_ACCESS_KEY_ID ?? DUCKBRAIN_S3_ACCESS_KEY_ID` (docs 'Falls back to AWS_ACCESS_KEY_ID') ✓; DUCKBRAIN_S3_SECRET_ACCESS_KEY (line 32) → src/s3/query.ts:109-110 ✓; DUCKBRAIN_GIT_AUTHOR_NAME (line 33) → src/git/identity.ts:121-137 precedence repo-local > global > env > null(throws) ✓; DUCKBRAIN_GIT_AUTHOR_EMAIL (line 34) → src/git/identity.ts:124-137 same precedence ✓. Test-setup seed values in docs match src/test-setup.ts:50-51. Tests run fresh: `npx vitest run src/git/identity.test.ts src/git/attribution.test.ts` → exit_code 0, 'Test Files 2 passed (2), Tests 16 passed (16)'; `npx vitest run src/cli/http-ui-static-df092408.test.ts src/config/df100301-data-dir-dead.test.ts` → exit_code 0, 'Tests 12 passed (12)'; `npx vitest run src/s3/query-scheme-s3queryscheme001.test.ts src/s3/cli-query.test.ts` → exit_code 0, 'Tests 14 passed (14)'. [resolution 0.38; docs/guide/configuration.md]
All six process-read DUCKBRAIN env vars are documented in docs/guide/configuration.md with source locations, defaults, and precedence that match the actual code, and all related tests pass.

Overall: PASS ✓
