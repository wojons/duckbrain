<!--
  ⚠️  BOARD FORMAT — coding-hermes-model-router v1.3 (2026-07-24)
  All tasks MUST use matrix format: | ID | Task | Pri | Cpx | Deps | Tags | Model | Reasoning | Fallback |
  Before editing this file, load the skill: skill_view(name='coding-hermes-model-router')
  Validate: python3 ~/.hermes/scripts/validate-board-format.py .coding-hermes/tasks.md
- [ ] **GITREINS-JUDGE — Configure LLM evaluator for commit quality review**
  | 🔴 Critical | — | — | deepseek-v4-flash @ deepseek-foreman | GITREINS_LLM_API_KEY in ~/.hermes/.env | foreman-direct |

  Run: `python3 ~/.hermes/scripts/check-gitreins-judge.py .` to verify.
  If missing, create/edit .gitreins/config.yaml with evaluator section using deepseek-v4-flash.
  This is CRITICAL for code quality — no automated review of worker output without it.

  NEVER remove the matrix header row or NEVER-DONE / E2E-001 fixtures.
-->

|# DuckBrain — Model Router Task Matrix

|||||||||| **Core purpose:** Git-backed persistent memory system for AI agents — DuckDB storage, MCP tools, HTTP API, namespace management.
|||||||||||| **Language:** TypeScript | **Tests:** 122/122 pass | **Build:** clean | **Status:** IDLE (all bugs fixed, only DB-001 blocked) | **Tick:** #125 | **Cooldown:** 900s (scheduler ground truth)|

## Active

| ID | Task | Pri | Cpx | Deps | Tags | Model | Reasoning | Fallback |
|----|------|-----|-----|------|------|-------|-----------|----------|
| — | No active tasks | — | — | — | — | — | All E2E bugs resolved. Only DB-001 (blocked) remains. | — |

## Blocked

| ID | Task | Pri | Cpx | Deps | Tags | Blocker |
|----|------|-----|-----|------|------|---------|
| DB-001 | Embedding model selection for VSS | Critical | — | — | ++ml, +duckdb | Bane decision on embedding model — **125+ ticks** |

## Completed

| ID | Task | Commit | Synced |
|----|------|--------|--------|
| BUG-027 | Tombstone filtering: integration test confirms fix (false E2E positive) | 1a1b37b | Tick #125 |
| BUG-028 | Multi-segment key lookup: Express wildcard route fix | 1a1b37b | Tick #125 |
| BUG-029 | Invalid domain validation: POST returns 400 not 500 | 1a1b37b | Tick #125 |
| BUG-030 | Missing vite.svg favicon in build output | Trivial fix — foreman direct | Tick #124 |
| DB-014 | CI/CD: GitHub Actions workflow | ci.yml/release.yml | Tick #34 |
| DB-015 | DOC: Missing docs pages | All 4 pages exist | Tick #34 |
| DB-017 | QUALITY: Dedup resolveNamespacePath | shared.ts extraction | Tick #34 |
| DB-020 | SECURITY: GitReins guard config | .gitreins/config.yaml | Tick #34 |
| DB-018 | BigInt serialization fix in DuckDB queries | bf4692f | Tick #36 |
| DB-016 | Replace HTTP stubs with real implementations | 08a0ef4 | Tick #37 |
| DB-021 | SECURITY: CLI command injection hardened | 88576c0 | Tick #35 |
| DB-019 | PERF: Replace linear-scan with DuckDB WHERE | 9fd51a9 | Tick #38 |
| DB-022 | QUALITY: Fix tsc --noEmit unused imports | Tick #38 | Tick #38 |
| DB-025 | META: GitReins sync for DB-019 | 0db4d7e | Tick #40 |
| DB-000–DB-013, DB-023 | All prior tasks | Prior ticks | Prior ticks |

## Audit Gaps (from NEVER-DONE #124)

| ID | Gap | Severity | Status |
|----|-----|----------|--------|
| DB-023 | Route test coverage: 6/7 route files lack unit tests | Medium | Open (84+ ticks stale — needs worker, not foreman) |
| DB-024 | pnpm outdated: uuid 13→14, typescript 6→7, 2 deprecated @types | Low | Open (84+ ticks stale — needs worker) |
| DB-026 | ~~E2E-001 never run~~ | ~~Medium~~ | **RESOLVED Tick #124** — 36 endpoints, 32/36 pass, 4 bugs found → all resolved by Tick #125 |

- [ ] E2E-001 — E2E Testing Tick (self-improving loop) 🔁 Every 5-10 ticks
  Spawn Luna (browser/screenshots) or Step 3.7 Flash (CLI/API). Deploy/build,
  Playwright, screenshots, endpoints, console. → e2e-output/tasks.md → inject
  into board. See foreman Step 1.5i. Every 5-10 ticks.
  **Last run: Tick #124 — 4 bugs found (all resolved by #125).** Next due: Tick #129–134.

- [ ] NEVER-DONE — Run coding-hermes-never-done 14-point audit
  Load coding-hermes-never-done skill. Run ALL 14 checks. Create a task
  for EVERY gap found. This task is never complete — the audit always finds something.

## Tick Log

### TICK #125 — IDLE: ALL 3 E2E BUGS RESOLVED (2026-07-27 08:23 UTC) — 1 worker dispatched

| Check | Result | Detail |
|-------|--------|--------|
| Host load | ✅ 2.86/3.90/3.47 | 46GB available — well under dispatch threshold |
| Build | ✅ Clean | pnpm build + vite, 1.74s, 1601 modules |
| Tests | ✅ **122/122** | 13/13 suites (4 new from BUG-027 test), 12.30s |
| Hilo | ✅ 499 edges, 115 files | Stable — Hilo=useful |
| GitReins | ✅ 8/8 complete, guard clean | secrets clean, no pending tasks |
| Git status | ⚠️ duckbrain.config.json modified | Config drift (pre-existing) |
| Scheduler | ✅ Operational | :9090, cooldown 900s |
| DuckBrain | ✅ Write verified | Tick #125 entry confirmed |
| BUG-027 | ✅ **Resolved** | False E2E positive — tombstone filter already works. Worker wrote integration test. |
| BUG-028 | ✅ **Fixed** | Express `:key` → `*key` wildcard for multi-segment key paths |
| BUG-029 | ✅ **Fixed** | DomainEnum.safeParse validation — POST returns 400 for invalid domain |
| BUG-030 | ✅ Fixed Tick #124 | vite.svg (pre-existing) |
| DB-001 | 🔴 BLOCKED | Awaiting Bane's embedding model decision — **125+ ticks** |

**Worker dispatch:** BUG-027 investigation dispatched to deepseek-v4-pro worker (23 calls, 226s). Worker confirmed tombstone filter already works correctly, wrote 4-test integration suite (memories-bug027.test.ts). BUG-028 and BUG-029 fixed foreman-direct (trivial).

**Commit:** 1a1b37b — fix: BUG-027/028/029 (2 files changed, 136 insertions)

**Verdict:** IDLE — All 4 E2E bugs from Tick #124 are now resolved. Project has zero active tasks. Only DB-001 (embedding model decision) remains blocked at 125+ ticks. DB-023 and DB-024 remain stale audit gaps at 84+ ticks. Next E2E due Tick #129–134.

Board summary: 39 tasks completed (incl BUG-027/028/029/030), 0 pending, 1 BLOCKED (DB-001), 2 audit gaps open (DB-023, DB-024).
