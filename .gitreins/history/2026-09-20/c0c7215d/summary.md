# Verdict: DB-GAP-048

**Task:** s3 query honors AWS_PROFILE
**Evaluated:** 2026-09-20T02:23:42.816503
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: RUN  v4.1.10 /home/kara/duckbrain
- ✓ **tier2**
  - COMPLETE
  ✓ src/s3/query.ts resolves S3 credentials for the DuckDB httpfs layer in this precedence: (1) direct env AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY (or DUCKBRAIN_S3_* overrides) are used verbatim with no SDK call; (2) else, when a profile is named via env AWS_PROFILE or cfg.profile, the AWS SDK v3 credential chain resolves it and the key/secret/session token are set on the httpfs session for the query; (3) else nothing is injected and httpfs raises its own authentication error. An unresolvable named profile fails loudly naming the profile. New tests in src/s3/cli-query.test.ts cover direct-keys-precedence, profile-fallback credential injection (asserted on the SQL issued to DuckDB, hermetic), cfg.profile fallback and env precedence, no-credentials unchanged failure, and loud unresolvable-profile failure. Full npx vitest run green (155 files / 1226 tests) and npx tsc --noEmit clean on the merged tree.: src/s3/query.ts (commit 95ee0a5, merged in a8b6a28): (1) envCredentials() (lines ~80-88) reads AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY ?? DUCKBRAIN_S3_ACCESS_KEY_ID/SECRET and resolveQueryCredentials returns it verbatim with source:'env' before any provider call (line 108-110) — no SDK call. (2) configuredProfile() (line 92) prefers process.env.AWS_PROFILE?.trim() then cfg.profile?.trim(); defaultCredentialProvider() calls buildClient(cfg).config.credentials() (the same SDK v3 chain src/s3/client.ts:32 uses); runS3Query (lines 167-198) issues `SET s3_access_key_id=...`, `SET s3_secret_access_key=...` and `SET s3_session_token=...` (sqlLiteral-escaped) on the httpfs session. (3) resolveQueryCredentials returns undefined when no env keys and no profile, so no SET is issued and httpfs raises its own auth error. Unresolvable profile throws `s3 query: could not resolve credentials for AWS profile "<profile>" ... : <cause>` (lines ~120-126). Tests in src/s3/cli-query.test.ts: (a) direct-keys-precedence with provider asserted not called; (b) profile injection asserted on the SQL issued to DuckDB via Database.prototype.exec spy + stub provider (hermetic, no AWS call); (b2) cfg.profile fallback and env precedence; (c) no-credentials -> credentialSetCalls()==[] and query still rejects; (d) loud unresolvable-profile failure matching /AWS profile "broken-profile"/. Command evidence: `npx vitest run src/s3/cli-query.test.ts` -> Test Files 1 passed (1), Tests 8 passed (8), exit 0. `npx vitest run` -> Test Files 155 passed (155), Tests 1226 passed (1226), EXIT=0 (98.35s). `npx tsc --noEmit` -> EXIT=0, no output.
All credential-precedence behavior, tests, full vitest run (155 files/1226 tests, exit 0) and tsc --noEmit (exit 0) verified on the merged tree.

## Summary

Judge Result: DB-GAP-048

Stage tier1: FAIL
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: RUN  v4.1.10 /home/kara/duckbrain

Stage tier2: PASS
  COMPLETE
  ✓ src/s3/query.ts resolves S3 credentials for the DuckDB httpfs layer in this precedence: (1) direct env AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY (or DUCKBRAIN_S3_* overrides) are used verbatim with no SDK call; (2) else, when a profile is named via env AWS_PROFILE or cfg.profile, the AWS SDK v3 credential chain resolves it and the key/secret/session token are set on the httpfs session for the query; (3) else nothing is injected and httpfs raises its own authentication error. An unresolvable named profile fails loudly naming the profile. New tests in src/s3/cli-query.test.ts cover direct-keys-precedence, profile-fallback credential injection (asserted on the SQL issued to DuckDB, hermetic), cfg.profile fallback and env precedence, no-credentials unchanged failure, and loud unresolvable-profile failure. Full npx vitest run green (155 files / 1226 tests) and npx tsc --noEmit clean on the merged tree.: src/s3/query.ts (commit 95ee0a5, merged in a8b6a28): (1) envCredentials() (lines ~80-88) reads AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY ?? DUCKBRAIN_S3_ACCESS_KEY_ID/SECRET and resolveQueryCredentials returns it verbatim with source:'env' before any provider call (line 108-110) — no SDK call. (2) configuredProfile() (line 92) prefers process.env.AWS_PROFILE?.trim() then cfg.profile?.trim(); defaultCredentialProvider() calls buildClient(cfg).config.credentials() (the same SDK v3 chain src/s3/client.ts:32 uses); runS3Query (lines 167-198) issues `SET s3_access_key_id=...`, `SET s3_secret_access_key=...` and `SET s3_session_token=...` (sqlLiteral-escaped) on the httpfs session. (3) resolveQueryCredentials returns undefined when no env keys and no profile, so no SET is issued and httpfs raises its own auth error. Unresolvable profile throws `s3 query: could not resolve credentials for AWS profile "<profile>" ... : <cause>` (lines ~120-126). Tests in src/s3/cli-query.test.ts: (a) direct-keys-precedence with provider asserted not called; (b) profile injection asserted on the SQL issued to DuckDB via Database.prototype.exec spy + stub provider (hermetic, no AWS call); (b2) cfg.profile fallback and env precedence; (c) no-credentials -> credentialSetCalls()==[] and query still rejects; (d) loud unresolvable-profile failure matching /AWS profile "broken-profile"/. Command evidence: `npx vitest run src/s3/cli-query.test.ts` -> Test Files 1 passed (1), Tests 8 passed (8), exit 0. `npx vitest run` -> Test Files 155 passed (155), Tests 1226 passed (1226), EXIT=0 (98.35s). `npx tsc --noEmit` -> EXIT=0, no output.
All credential-precedence behavior, tests, full vitest run (155 files/1226 tests, exit 0) and tsc --noEmit (exit 0) verified on the merged tree.

Overall: FAIL ✗
