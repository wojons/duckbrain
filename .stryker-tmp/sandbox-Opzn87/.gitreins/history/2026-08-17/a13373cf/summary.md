# Verdict: INT-CI-003

**Task:** Fix CI integration daemon spawn timeout flake (3rd occurrence, run 32071985468)
**Evaluated:** 2026-08-17T23:57:10.330538
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✓ secrets: [90m6:53PM[0m [32mINF[0m [1mscanned ~11931881 bytes (11.93 MB) in 2.69s[0m
[90m6:53PM[0m [3
  ✗ lint: npm warn exec The following package was not found and will be installed: eslint@10.8.1

Oops! Someth
  ✓ tests: 
[1m[30m[46m RUN [49m[39m[22m [36mv4.1.10 [39m[90m/home/kara/duckbrain[39m

 [32m✓[39m s
- ✓ **tier2**
  - COMPLETE
  ✓ waitForUrl no longer times out on Node 22 integration runs: raise budget / pre-warm / serialize such that 3 consecutive npm run test:integration runs pass; full suite + tsc clean + gitreins guard PASS: Verified on Node v22.22.3. (1) 3 consecutive `npm run test:integration` runs all passed: run1 6 files/44 tests (57.34s), run2 6 files/44 tests (20.08s), run3 6 files/44 tests (23.72s). (2) Full suite `npx vitest run`: 59 files/443 tests passed. (3) `npx tsc --noEmit` exit 0 (clean). (4) `gitreins guard` exit 0: 'Tier 1 Guards: PASS', '✓ tests'. Fix implemented: DAEMON_READY_TIMEOUT_MS 30s->60s (tests/helpers.ts:33), globalSetup pre-warm daemon (tests/global-setup.integration.ts + vitest.integration.config.ts:14), spawn via `node --import tsx` instead of npx (tests/helpers.ts:162), curl --max-time 10 per poll (tests/helpers.ts:105), hermetic embedding-provider pin, getChildState timeout diagnostics, ssh-tunnel wait 60s->120s.
INT-CI-003 fix verified: 3 consecutive integration runs, full suite (443 tests), tsc, and gitreins guard all pass on Node 22.

## Summary

Judge Result: INT-CI-003

Stage tier1: FAIL
    ✓ secrets: [90m6:53PM[0m [32mINF[0m [1mscanned ~11931881 bytes (11.93 MB) in 2.69s[0m
[90m6:53PM[0m [3
  ✗ lint: npm warn exec The following package was not found and will be installed: eslint@10.8.1

Oops! Someth
  ✓ tests: 
[1m[30m[46m RUN [49m[39m[22m [36mv4.1.10 [39m[90m/home/kara/duckbrain[39m

 [32m✓[39m s

Stage tier2: PASS
  COMPLETE
  ✓ waitForUrl no longer times out on Node 22 integration runs: raise budget / pre-warm / serialize such that 3 consecutive npm run test:integration runs pass; full suite + tsc clean + gitreins guard PASS: Verified on Node v22.22.3. (1) 3 consecutive `npm run test:integration` runs all passed: run1 6 files/44 tests (57.34s), run2 6 files/44 tests (20.08s), run3 6 files/44 tests (23.72s). (2) Full suite `npx vitest run`: 59 files/443 tests passed. (3) `npx tsc --noEmit` exit 0 (clean). (4) `gitreins guard` exit 0: 'Tier 1 Guards: PASS', '✓ tests'. Fix implemented: DAEMON_READY_TIMEOUT_MS 30s->60s (tests/helpers.ts:33), globalSetup pre-warm daemon (tests/global-setup.integration.ts + vitest.integration.config.ts:14), spawn via `node --import tsx` instead of npx (tests/helpers.ts:162), curl --max-time 10 per poll (tests/helpers.ts:105), hermetic embedding-provider pin, getChildState timeout diagnostics, ssh-tunnel wait 60s->120s.
INT-CI-003 fix verified: 3 consecutive integration runs, full suite (443 tests), tsc, and gitreins guard all pass on Node 22.

Overall: FAIL ✗
