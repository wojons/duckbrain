# Verdict: DOC-13

**Task:** Document process-read DUCKBRAIN env vars
**Evaluated:** 2026-10-11T08:21:05.071043
**Result:** ✗ FAIL

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✗ **tier2**
  - INCOMPLETE
  ✗ docs/guide/configuration.md documents each of DUCKBRAIN_UI_DIST_DIR, DUCKBRAIN_DATA_DIR, DUCKBRAIN_S3_ACCESS_KEY_ID, DUCKBRAIN_S3_SECRET_ACCESS_KEY, DUCKBRAIN_GIT_AUTHOR_NAME, DUCKBRAIN_GIT_AUTHOR_EMAIL with source location, default, and precedence: All 6 vars appear in the table (docs/guide/configuration.md lines 14,17,31,32,33,34) with source/default/precedence text, and 4 are accurate: DUCKBRAIN_UI_DIST_DIR (src/cli/http.ts:88-89, default 'scan upward for packages/ui/dist', env wins) ✓; DUCKBRAIN_DATA_DIR (src/utils/pidfile.ts:59, default per-uid/pid) ✓; DUCKBRAIN_S3_ACCESS_KEY_ID/SECRET (src/s3/query.ts:107-110, fallback to AWS_*) ✓. BUT the two git vars are documented INCORRECTLY. Line 33 states 'Precedence: this env var > git config user.name > "DuckBrain"' and line 34 states 'this env var > git config user.email > "duckbrain@localhost.localdomain"'. The actual code (src/git/identity.ts:111-142) resolves repo-local git config > global git config > env — env is the LAST fallback, the exact inverse of the doc. Test src/git/identity.test.ts:205 ('env override beats nothing; repo-local beats global') confirms this and passes (npx vitest run src/git/identity.test.ts → 7 passed). The stated defaults are also fabricated: commit e6ac7681 (GIT-IDENTITY-001) removed the synthetic 'DuckBrain'/'duckbrain@localhost.localdomain' pin, and resolveGitIdentity now returns identity:null and throws (identity.ts:143-147) rather than defaulting. Thus the required 'default' and 'precedence' are wrong for 2 of the 6 vars.
All six env vars are listed, but the two DUCKBRAIN_GIT_AUTHOR_* entries document an inverted precedence (env is actually the last fallback, not the first) and a fabricated default that the code no longer uses, so the criterion is not met.

## Summary

Judge Result: DOC-13

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: FAIL
  INCOMPLETE
  ✗ docs/guide/configuration.md documents each of DUCKBRAIN_UI_DIST_DIR, DUCKBRAIN_DATA_DIR, DUCKBRAIN_S3_ACCESS_KEY_ID, DUCKBRAIN_S3_SECRET_ACCESS_KEY, DUCKBRAIN_GIT_AUTHOR_NAME, DUCKBRAIN_GIT_AUTHOR_EMAIL with source location, default, and precedence: All 6 vars appear in the table (docs/guide/configuration.md lines 14,17,31,32,33,34) with source/default/precedence text, and 4 are accurate: DUCKBRAIN_UI_DIST_DIR (src/cli/http.ts:88-89, default 'scan upward for packages/ui/dist', env wins) ✓; DUCKBRAIN_DATA_DIR (src/utils/pidfile.ts:59, default per-uid/pid) ✓; DUCKBRAIN_S3_ACCESS_KEY_ID/SECRET (src/s3/query.ts:107-110, fallback to AWS_*) ✓. BUT the two git vars are documented INCORRECTLY. Line 33 states 'Precedence: this env var > git config user.name > "DuckBrain"' and line 34 states 'this env var > git config user.email > "duckbrain@localhost.localdomain"'. The actual code (src/git/identity.ts:111-142) resolves repo-local git config > global git config > env — env is the LAST fallback, the exact inverse of the doc. Test src/git/identity.test.ts:205 ('env override beats nothing; repo-local beats global') confirms this and passes (npx vitest run src/git/identity.test.ts → 7 passed). The stated defaults are also fabricated: commit e6ac7681 (GIT-IDENTITY-001) removed the synthetic 'DuckBrain'/'duckbrain@localhost.localdomain' pin, and resolveGitIdentity now returns identity:null and throws (identity.ts:143-147) rather than defaulting. Thus the required 'default' and 'precedence' are wrong for 2 of the 6 vars.
All six env vars are listed, but the two DUCKBRAIN_GIT_AUTHOR_* entries document an inverted precedence (env is actually the last fallback, not the first) and a fabricated default that the code no longer uses, so the criterion is not met.

Overall: FAIL ✗
