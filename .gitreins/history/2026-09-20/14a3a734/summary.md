# Verdict: DOC-3

**Task:** DOC s3-native: document AWS_ENDPOINT_URL[_S3] env overrides for s3 endpoint resolution
**Evaluated:** 2026-09-20T15:19:42.064520
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v5.0.1 /home/kara/duckbrain
- ✓ **tier2**
  - COMPLETE
  ✓ docs/s3-native.md documents the full effective-endpoint precedence chain (AWS_ENDPOINT_URL_S3 -> AWS_ENDPOINT_URL -> config s3.endpoint -> AWS default) matching src/s3/config.ts resolveEffectiveEndpoint; behavior live-verified with env combos: docs/s3-native.md:127-172 'Effective endpoint — which layer wins (DOGFOOD-030, DOC-3)' documents the full chain. Path A table (lines 141-144) lists all 4 layers: 1 AWS_ENDPOINT_URL_S3, 2 AWS_ENDPOINT_URL, 3 config s3.endpoint, 4 AWS SDK default ('s3 status prints (AWS default)'). This exactly matches src/s3/config.ts:80-86 resolveEffectiveEndpoint (s3Url -> url -> cfg.endpoint -> undefined) and src/s3/cli.ts:55 (`resolveEffectiveEndpoint(s3) ?? "(AWS default)"`). Path B table (lines 151-154) documents the push-child chain via buildPushEnv (src/git/autocommit.ts:588, injects AWS_ENDPOINT_URL from s3.endpoint, spread after process.env at lines 650/687/777 so it replaces the operator var; AWS_ENDPOINT_URL_S3 never set so it passes through). Live-verified all 4 env combos via `npx tsx bin/duckbrain.ts s3 status`: nothing set -> endpoint: https://hel1.your-objectstorage.com (config, matches duckbrain.config.json:164); AWS_ENDPOINT_URL=https://probe.example.com -> https://probe.example.com; AWS_ENDPOINT_URL_S3=https://svc.example.com -> https://svc.example.com; both set -> https://svc.example.com (S3-specific wins) — all matching the docs table at lines 168-172. Tests: `npx vitest run src/s3/cli-endpoint-dogfood030.test.ts` -> Test Files 1 passed, Tests 6 passed; `npx vitest run src/s3/` -> 4 files, 28 tests passed; `npx vitest run src/git/autocommit` -> 5 files, 31 tests passed.
docs/s3-native.md accurately documents the full effective-endpoint precedence chain matching src/s3/config.ts resolveEffectiveEndpoint, with all four env combos live-verified and the endpoint test suite passing 6/6.

## Summary

Judge Result: DOC-3

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v5.0.1 /home/kara/duckbrain

Stage tier2: PASS
  COMPLETE
  ✓ docs/s3-native.md documents the full effective-endpoint precedence chain (AWS_ENDPOINT_URL_S3 -> AWS_ENDPOINT_URL -> config s3.endpoint -> AWS default) matching src/s3/config.ts resolveEffectiveEndpoint; behavior live-verified with env combos: docs/s3-native.md:127-172 'Effective endpoint — which layer wins (DOGFOOD-030, DOC-3)' documents the full chain. Path A table (lines 141-144) lists all 4 layers: 1 AWS_ENDPOINT_URL_S3, 2 AWS_ENDPOINT_URL, 3 config s3.endpoint, 4 AWS SDK default ('s3 status prints (AWS default)'). This exactly matches src/s3/config.ts:80-86 resolveEffectiveEndpoint (s3Url -> url -> cfg.endpoint -> undefined) and src/s3/cli.ts:55 (`resolveEffectiveEndpoint(s3) ?? "(AWS default)"`). Path B table (lines 151-154) documents the push-child chain via buildPushEnv (src/git/autocommit.ts:588, injects AWS_ENDPOINT_URL from s3.endpoint, spread after process.env at lines 650/687/777 so it replaces the operator var; AWS_ENDPOINT_URL_S3 never set so it passes through). Live-verified all 4 env combos via `npx tsx bin/duckbrain.ts s3 status`: nothing set -> endpoint: https://hel1.your-objectstorage.com (config, matches duckbrain.config.json:164); AWS_ENDPOINT_URL=https://probe.example.com -> https://probe.example.com; AWS_ENDPOINT_URL_S3=https://svc.example.com -> https://svc.example.com; both set -> https://svc.example.com (S3-specific wins) — all matching the docs table at lines 168-172. Tests: `npx vitest run src/s3/cli-endpoint-dogfood030.test.ts` -> Test Files 1 passed, Tests 6 passed; `npx vitest run src/s3/` -> 4 files, 28 tests passed; `npx vitest run src/git/autocommit` -> 5 files, 31 tests passed.
docs/s3-native.md accurately documents the full effective-endpoint precedence chain matching src/s3/config.ts resolveEffectiveEndpoint, with all four env combos live-verified and the endpoint test suite passing 6/6.

Overall: PASS ✓
