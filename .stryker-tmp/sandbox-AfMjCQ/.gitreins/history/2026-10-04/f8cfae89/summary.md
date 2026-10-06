# Verdict: S3-QUERY-SCHEME-001

**Task:** s3 query honours endpoint scheme (s3_use_ssl)
**Evaluated:** 2026-10-04T17:27:05.347090
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✓ src/s3/query.ts sets s3_use_ssl from the endpoint scheme; http endpoints query over plain http; test suite src/s3/query-scheme-s3queryscheme001.test.ts covers http/https; fix commit d2db770 on origin/main: src/s3/query.ts:91-99 defines endpointUseSsl(endpoint) returning new URL(endpoint).protocol !== "http:" (false only for explicit http:, true for https/schemeless/unparseable); line 211 issues db.exec(`SET s3_use_ssl='${endpointUseSsl(cfg.endpoint)}';`) inside the `if (cfg.endpoint)` block, so http:// endpoints get s3_use_ssl='false' (plain http) and https get 'true'. Test src/s3/query-scheme-s3queryscheme001.test.ts covers both: 'an http:// endpoint sets s3_use_ssl='false' beside s3_endpoint' and 'an https:// endpoint sets s3_use_ssl='true''. Ran `npx vitest run src/s3/query-scheme-s3queryscheme001.test.ts` => 'Test Files 1 passed (1)', 'Tests 6 passed (6)', exit_code 0. Commit d2db770 ('fix(s3): honour endpoint scheme in `s3 query` — set s3_use_ssl from the endpoint') exists and `git merge-base --is-ancestor d2db770 origin/main` returned YES (also contained in origin/main, ghgitlab/main); its stat shows src/s3/query.ts (+30) and src/s3/query-scheme-s3queryscheme001.test.ts (+130). [resolution 0.54; src/s3/query.ts, src/s3/query-scheme-s3queryscheme001.test.ts]


## Summary

Judge Result: S3-QUERY-SCHEME-001

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✓ src/s3/query.ts sets s3_use_ssl from the endpoint scheme; http endpoints query over plain http; test suite src/s3/query-scheme-s3queryscheme001.test.ts covers http/https; fix commit d2db770 on origin/main: src/s3/query.ts:91-99 defines endpointUseSsl(endpoint) returning new URL(endpoint).protocol !== "http:" (false only for explicit http:, true for https/schemeless/unparseable); line 211 issues db.exec(`SET s3_use_ssl='${endpointUseSsl(cfg.endpoint)}';`) inside the `if (cfg.endpoint)` block, so http:// endpoints get s3_use_ssl='false' (plain http) and https get 'true'. Test src/s3/query-scheme-s3queryscheme001.test.ts covers both: 'an http:// endpoint sets s3_use_ssl='false' beside s3_endpoint' and 'an https:// endpoint sets s3_use_ssl='true''. Ran `npx vitest run src/s3/query-scheme-s3queryscheme001.test.ts` => 'Test Files 1 passed (1)', 'Tests 6 passed (6)', exit_code 0. Commit d2db770 ('fix(s3): honour endpoint scheme in `s3 query` — set s3_use_ssl from the endpoint') exists and `git merge-base --is-ancestor d2db770 origin/main` returned YES (also contained in origin/main, ghgitlab/main); its stat shows src/s3/query.ts (+30) and src/s3/query-scheme-s3queryscheme001.test.ts (+130). [resolution 0.54; src/s3/query.ts, src/s3/query-scheme-s3queryscheme001.test.ts]


Overall: PASS ✓
