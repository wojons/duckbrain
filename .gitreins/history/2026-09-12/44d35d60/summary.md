# Verdict: OPS-002

**Task:** P1 /health hangs forever: bound the health handler and classify hung-vs-dark in the watchdog
**Evaluated:** 2026-09-12T19:43:44.784202
**Result:** ✗ FAIL

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: [90m2:39PM[0m [32mINF[0m [1mscanned ~8019828 bytes (8.02 MB) in 1.58s[0m
[90m2:39PM[0m [32m
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  118 passed (118)
      Tests  1007 passed (1007)

- ✗ **tier2**
  - INCOMPLETE
  ✗ Live daemon /health answers within the deadline (200 or 503) after redeploy; /health handler wrapped in a hard outer deadline with the exceeding sub-probe named; hermetic regression covers a never-settling injected probe; scripts/health-check.js exit codes separate hung (timeout) from dark (refused); tsc --noEmit + prettier clean; AGENTS.md suite/test counts equal live.: Most sub-parts pass, but the AGENTS.md count sub-part fails and the live-daemon sub-part is unverified. (1) Handler deadline: PASS — src/cli/http.ts:151 HEALTH_HANDLER_DEADLINE_MS=4000; createHealthHandler(probe, keysProbe, durabilityProbe, deadlineMs) at :240-245; shared budget deadlineAt/remaining() at :252-256; withDeadline() races the probe against an unref'd setTimeout at :160-183; embedding miss pushes "embedding" + note 'embedding probe did not settle within the ${deadlineMs}ms /health deadline' (:258-263); keys miss pushes "keys" + keys_error note (:286-292); response carries deadline_exceeded and 503 when degraded (:317-325); documented in docs/api/http-api.md:77,93-95. (2) Hermetic never-settling regression: PASS — src/cli/http-health-deadline.test.ts defines `const never = <T>() => new Promise<T>(() => {})` and covers never-settling embedding probe, never-settling keys probe, both-hung single-budget, and late-rejecting abandoned probe; `npx vitest run src/cli/http-health-deadline.test.ts src/cli/health-check.test.ts` -> exit 0, 'Test Files 2 passed (2) / Tests 28 passed (28)'. (3) hung-vs-dark exit codes: PASS — src/cli/health-check.ts HUNG_EXIT_CODE=3, isRequestTimeout() separates TimeoutError/AbortError/'aborted due to timeout' (incl. nested cause) from ECONNREFUSED/ETIMEDOUT, runHealthCheckCli returns 0 alive / 3 hung / 1 dark / 2 usage; scripts/health-check.js docstring, ops/systemd/duckbrain-http-health.service:8-13 and docs/guide/deployment.md:137-146 all document it; health-check.test.ts spawns scripts/health-check.js against an accept-and-never-answer socket and asserts exit 3 + stderr /HUNG/ (passed). (4) tsc + prettier: PASS — `npx tsc --noEmit` exit 0 with no output; `npx prettier --check src/cli/http.ts src/cli/health-check.ts src/cli/http-health-deadline.test.ts src/cli/health-check.test.ts scripts/health-check.js` -> 'All matched files use Prettier code style!' exit 0. (5) AGENTS.md counts equal live: FAIL — full `npx vitest run` reports 'Test Files 118 passed (118) / Tests 1007 passed (1007)' (exit 0), but AGENTS.md:14 still reads 'Vitest (117 suites, 987 tests)' and AGENTS.md:33 still reads 'pnpm test # 987 tests, 117 suites'; the CI assert .github/workflows/ci.yml:57-62 (GAP-012) greps '(118 suites, 1007 tests)' and '# 1007 tests, 118 suites' — both DRIFT (verified: TECHSTACK_DRIFT / DEVCMD_DRIFT). Commit 20eac52's own message admits 'NOTE (follow-up, not applied here): AGENTS.md's two test-count lines still read "117 suites, 987 tests" ... Apply those two lines before pushing or the CI count assert (GAP-012) fails.' (6) Live daemon /health after redeploy: NOT VERIFIED — no live daemon/systemd probe output exists in this environment; only code-level and hermetic evidence supports it.
The handler deadline, hermetic never-settling regression, hung-vs-dark exit codes, and tsc/prettier checks all pass, but AGENTS.md still says 117 suites/987 tests while the live suite is 118/1007 (CI GAP-012 assert would fail) and the live-daemon /health probe was never demonstrated.

## Summary

Judge Result: OPS-002

Stage tier1: PASS
    ✓ secrets: [90m2:39PM[0m [32mINF[0m [1mscanned ~8019828 bytes (8.02 MB) in 1.58s[0m
[90m2:39PM[0m [32m
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  118 passed (118)
      Tests  1007 passed (1007)


Stage tier2: FAIL
  INCOMPLETE
  ✗ Live daemon /health answers within the deadline (200 or 503) after redeploy; /health handler wrapped in a hard outer deadline with the exceeding sub-probe named; hermetic regression covers a never-settling injected probe; scripts/health-check.js exit codes separate hung (timeout) from dark (refused); tsc --noEmit + prettier clean; AGENTS.md suite/test counts equal live.: Most sub-parts pass, but the AGENTS.md count sub-part fails and the live-daemon sub-part is unverified. (1) Handler deadline: PASS — src/cli/http.ts:151 HEALTH_HANDLER_DEADLINE_MS=4000; createHealthHandler(probe, keysProbe, durabilityProbe, deadlineMs) at :240-245; shared budget deadlineAt/remaining() at :252-256; withDeadline() races the probe against an unref'd setTimeout at :160-183; embedding miss pushes "embedding" + note 'embedding probe did not settle within the ${deadlineMs}ms /health deadline' (:258-263); keys miss pushes "keys" + keys_error note (:286-292); response carries deadline_exceeded and 503 when degraded (:317-325); documented in docs/api/http-api.md:77,93-95. (2) Hermetic never-settling regression: PASS — src/cli/http-health-deadline.test.ts defines `const never = <T>() => new Promise<T>(() => {})` and covers never-settling embedding probe, never-settling keys probe, both-hung single-budget, and late-rejecting abandoned probe; `npx vitest run src/cli/http-health-deadline.test.ts src/cli/health-check.test.ts` -> exit 0, 'Test Files 2 passed (2) / Tests 28 passed (28)'. (3) hung-vs-dark exit codes: PASS — src/cli/health-check.ts HUNG_EXIT_CODE=3, isRequestTimeout() separates TimeoutError/AbortError/'aborted due to timeout' (incl. nested cause) from ECONNREFUSED/ETIMEDOUT, runHealthCheckCli returns 0 alive / 3 hung / 1 dark / 2 usage; scripts/health-check.js docstring, ops/systemd/duckbrain-http-health.service:8-13 and docs/guide/deployment.md:137-146 all document it; health-check.test.ts spawns scripts/health-check.js against an accept-and-never-answer socket and asserts exit 3 + stderr /HUNG/ (passed). (4) tsc + prettier: PASS — `npx tsc --noEmit` exit 0 with no output; `npx prettier --check src/cli/http.ts src/cli/health-check.ts src/cli/http-health-deadline.test.ts src/cli/health-check.test.ts scripts/health-check.js` -> 'All matched files use Prettier code style!' exit 0. (5) AGENTS.md counts equal live: FAIL — full `npx vitest run` reports 'Test Files 118 passed (118) / Tests 1007 passed (1007)' (exit 0), but AGENTS.md:14 still reads 'Vitest (117 suites, 987 tests)' and AGENTS.md:33 still reads 'pnpm test # 987 tests, 117 suites'; the CI assert .github/workflows/ci.yml:57-62 (GAP-012) greps '(118 suites, 1007 tests)' and '# 1007 tests, 118 suites' — both DRIFT (verified: TECHSTACK_DRIFT / DEVCMD_DRIFT). Commit 20eac52's own message admits 'NOTE (follow-up, not applied here): AGENTS.md's two test-count lines still read "117 suites, 987 tests" ... Apply those two lines before pushing or the CI count assert (GAP-012) fails.' (6) Live daemon /health after redeploy: NOT VERIFIED — no live daemon/systemd probe output exists in this environment; only code-level and hermetic evidence supports it.
The handler deadline, hermetic never-settling regression, hung-vs-dark exit codes, and tsc/prettier checks all pass, but AGENTS.md still says 117 suites/987 tests while the live suite is 118/1007 (CI GAP-012 assert would fail) and the live-daemon /health probe was never demonstrated.

Overall: FAIL ✗
