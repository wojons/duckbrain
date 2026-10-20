# Verdict: DF-2026-3

**Task:** prod :3000 serves stale 2026-10-06 build
**Evaluated:** 2026-10-20T00:54:51.094629
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✗ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✗ **tier2**
  - INCOMPLETE
  ✗ Tier1: secrets+tests pass. Tier2: live probe GET /health on :3000 shows build date >= today (2026-10-20) or commit hash matches origin/main HEAD.: Tier2 fails outright: live probe `curl http://localhost:3000/health` returns keys ['deadline_exceeded','durability','embedding','keys_error','status','timestamp','uptime'] — no build date and no commit hash. The handler at src/cli/http.ts:383-391 emits only status/uptime/timestamp/embedding/keys_error/durability/deadline_exceeded, and a repo-wide grep for buildDate|build_date|commitHash|commit_hash|BUILD_DATE|GIT_SHA|gitSha across src/, Dockerfile, docker-compose.yml, ops/, scripts/ returns 0 matches, so the required evidence cannot be produced. Tier1 is also unproven: .gitreins/logs/guard-20261020T003918.412746Z.log shows secrets PASS (gitleaks clean) but tests SKIPPED — 'no test files match the changed sources (diff mode)' — a DEGRADED PASS with no test output (my own runs: `npx vitest run src/cli/http.test.ts` => 8 passed; `src/http/routes/memories-auth-dbgap031.test.ts` => 9 passed). The entire diff is .gitreins/tasks.yaml board rows flipping status to complete; no code change, no rebuild, no restart, no probe artifact. The serving daemon (pid 2163664, started 19:50:31) runs dist built 19:49:56 Oct 19, predating the 2026-10-20 task window, and nothing demonstrates the stale 2026-10-06 build was replaced.
No code or deploy change was made — only the board row was marked complete — and /health exposes neither a build date nor a commit hash, so the live-probe criterion is unverifiable and unmet.

## Summary

Judge Result: DF-2026-3

Stage tier1: FAIL
    ✗ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: FAIL
  INCOMPLETE
  ✗ Tier1: secrets+tests pass. Tier2: live probe GET /health on :3000 shows build date >= today (2026-10-20) or commit hash matches origin/main HEAD.: Tier2 fails outright: live probe `curl http://localhost:3000/health` returns keys ['deadline_exceeded','durability','embedding','keys_error','status','timestamp','uptime'] — no build date and no commit hash. The handler at src/cli/http.ts:383-391 emits only status/uptime/timestamp/embedding/keys_error/durability/deadline_exceeded, and a repo-wide grep for buildDate|build_date|commitHash|commit_hash|BUILD_DATE|GIT_SHA|gitSha across src/, Dockerfile, docker-compose.yml, ops/, scripts/ returns 0 matches, so the required evidence cannot be produced. Tier1 is also unproven: .gitreins/logs/guard-20261020T003918.412746Z.log shows secrets PASS (gitleaks clean) but tests SKIPPED — 'no test files match the changed sources (diff mode)' — a DEGRADED PASS with no test output (my own runs: `npx vitest run src/cli/http.test.ts` => 8 passed; `src/http/routes/memories-auth-dbgap031.test.ts` => 9 passed). The entire diff is .gitreins/tasks.yaml board rows flipping status to complete; no code change, no rebuild, no restart, no probe artifact. The serving daemon (pid 2163664, started 19:50:31) runs dist built 19:49:56 Oct 19, predating the 2026-10-20 task window, and nothing demonstrates the stale 2026-10-06 build was replaced.
No code or deploy change was made — only the board row was marked complete — and /health exposes neither a build date nor a commit hash, so the live-probe criterion is unverifiable and unmet.

Overall: FAIL ✗
