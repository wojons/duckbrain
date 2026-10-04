# Verdict: INT-CI-018

**Task:** Fix CI integration-suite port-race (EADDRINUSE in http-auth)
**Evaluated:** 2026-10-04T18:20:13.293346
**Result:** ✗ FAIL

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✗ **tier2**
  - INCOMPLETE
  ✗ tests/http-auth.int.test.ts no longer fails with EADDRINUSE/health-timeout in CI; tests/helpers.ts port allocation no longer draws from the kernel ephemeral range and daemon spawns are identity-verified with bounded retry; integration suite passes locally: Two of three sub-requirements are met but 'daemon spawns are identity-verified' is NOT implemented. (1) Port range: PASS — getRandomPort() changed from `30000 + Math.random()*20000` (30000-49999, overlapping the Linux kernel ephemeral range 32768+) to `21000 + Math.floor(Math.random()*9000)` (21000-29999, outside it) at tests/helpers.ts:200-201 (commit cd9600d). (2) Bounded retry: PASS — MAX_SPAWN_ATTEMPTS=3, assertPortFree() probe-bind, and EADDRINUSE-shaped retry with portRemaps in startDuckbrainHttp (tests/helpers.ts:217-232, 400-425). (3) Identity verification: FAIL — the spawn health probe is `curl -sf ... http://127.0.0.1:${opts.port}/health` accepting any 200/401/503 (tests/helpers.ts:358-365); there is no check that the responder is the child just spawned (no sentinel/nonce/token/PID correlation — grep for identity/token/nonce/instance in tests/helpers.ts returns nothing). The commit message claims to mirror the DB-GAP-063/nsauto001 pattern, but that reference DOES identity-verify: memories-namespace-autocreate-nsauto001.test.ts:480-505 (assertDaemonIsOurs) creates a random sentinel namespace and asserts the daemon's /api/namespaces lists it, rejecting a foreign listener. INT-CI-018 has no equivalent, so a stray/leftover daemon squatting the port is accepted as 'healthy' — the exact race the criterion targets; worse, if a foreign listener answers, the loop breaks and returns the child as ready even if the child died. (4) Local suite: PASS — `npx vitest run --config vitest.integration.config.ts tests/` => 'Test Files 10 passed (10)', 'Tests 64 passed (64)', Duration 41.15s; http-auth alone 6 passed (6). LSP diagnostics: 0.


## Summary

Judge Result: INT-CI-018

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: FAIL
  INCOMPLETE
  ✗ tests/http-auth.int.test.ts no longer fails with EADDRINUSE/health-timeout in CI; tests/helpers.ts port allocation no longer draws from the kernel ephemeral range and daemon spawns are identity-verified with bounded retry; integration suite passes locally: Two of three sub-requirements are met but 'daemon spawns are identity-verified' is NOT implemented. (1) Port range: PASS — getRandomPort() changed from `30000 + Math.random()*20000` (30000-49999, overlapping the Linux kernel ephemeral range 32768+) to `21000 + Math.floor(Math.random()*9000)` (21000-29999, outside it) at tests/helpers.ts:200-201 (commit cd9600d). (2) Bounded retry: PASS — MAX_SPAWN_ATTEMPTS=3, assertPortFree() probe-bind, and EADDRINUSE-shaped retry with portRemaps in startDuckbrainHttp (tests/helpers.ts:217-232, 400-425). (3) Identity verification: FAIL — the spawn health probe is `curl -sf ... http://127.0.0.1:${opts.port}/health` accepting any 200/401/503 (tests/helpers.ts:358-365); there is no check that the responder is the child just spawned (no sentinel/nonce/token/PID correlation — grep for identity/token/nonce/instance in tests/helpers.ts returns nothing). The commit message claims to mirror the DB-GAP-063/nsauto001 pattern, but that reference DOES identity-verify: memories-namespace-autocreate-nsauto001.test.ts:480-505 (assertDaemonIsOurs) creates a random sentinel namespace and asserts the daemon's /api/namespaces lists it, rejecting a foreign listener. INT-CI-018 has no equivalent, so a stray/leftover daemon squatting the port is accepted as 'healthy' — the exact race the criterion targets; worse, if a foreign listener answers, the loop breaks and returns the child as ready even if the child died. (4) Local suite: PASS — `npx vitest run --config vitest.integration.config.ts tests/` => 'Test Files 10 passed (10)', 'Tests 64 passed (64)', Duration 41.15s; http-auth alone 6 passed (6). LSP diagnostics: 0.


Overall: FAIL ✗
