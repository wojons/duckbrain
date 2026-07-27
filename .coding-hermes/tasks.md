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

||||||||| **Core purpose:** Git-backed persistent memory system for AI agents — DuckDB storage, MCP tools, HTTP API, namespace management.
||||||||||| **Language:** TypeScript | **Tests:** 118/118 pass | **Build:** clean | **Status:** ACTIVE (3 new bugs from E2E) | **Tick:** #124 (E2E breakthrough) | **Cooldown:** 900s (scheduler ground truth)|

## Active

| ID | Task | Pri | Cpx | Deps | Tags | Model | Reasoning | Fallback |
|----|------|-----|-----|------|------|-------|-----------|----------|
| BUG-027 | Tombstone filtering broken: GET /api/memories/:id returns deleted memories | Critical | Medium | — | ++api, ++duckdb, bug | deepseek-v4-pro | DB query-level bug — needs reasoning to trace recall/filter pipeline | deepseek-v4-flash |
| BUG-028 | Multi-segment key lookup fails: Express :key captures only 1 segment | Medium | Low | — | ++api, bug | deepseek-v4-flash | Mechanical Express route fix (/:key → /*) | opencode |
| BUG-029 | Invalid domain POST returns 500 instead of 400 | Low | Low | — | ++api, bug | deepseek-v4-flash | Error handler catch — route needs try/catch → 400 mapping | opencode |

## Blocked

| ID | Task | Pri | Cpx | Deps | Tags | Blocker |
|----|------|-----|-----|------|------|---------|
| DB-001 | Embedding model selection for VSS | Critical | — | — | ++ml, +duckdb | Bane decision on embedding model — **124+ ticks** |

## Completed

| ID | Task | Commit | Synced |
|----|------|--------|--------|
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
| DB-023 | Route test coverage: 6/7 route files lack unit tests | Medium | Open (83+ ticks stale — needs worker, not foreman) |
| DB-024 | pnpm outdated: uuid 13→14, typescript 6→7, 2 deprecated @types | Low | Open (83+ ticks stale — needs worker) |
| DB-026 | ~~E2E-001 never run~~ | ~~Medium~~ | **RESOLVED Tick #124** — 36 endpoints, 32/36 pass, 4 bugs found → 3 new tasks |

- [ ] E2E-001 — E2E Testing Tick (self-improving loop) 🔁 Every 5-10 ticks
  Spawn Luna (browser/screenshots) or Step 3.7 Flash (CLI/API). Deploy/build,
  Playwright, screenshots, endpoints, console. → e2e-output/tasks.md → inject
  into board. See foreman Step 1.5i. Every 5-10 ticks.
  **Last run: Tick #124 — 4 bugs found (3 open, 1 fixed).** Next due: Tick #129–134.

- [ ] NEVER-DONE — Run coding-hermes-never-done 14-point audit
  Load coding-hermes-never-done skill. Run ALL 14 checks. Create a task
  for EVERY gap found. This task is never complete — the audit always finds something.

## Tick Log

### TICK #124 — ACTIVE: E2E BREAKTHROUGH (2026-07-27 08:13 UTC) — 3 new bugs, first E2E run

| Check | Result | Detail |
|-------|--------|--------|
| Build | ✅ Clean | pnpm build + vite, 3.38s — clean (now includes vite.svg) |
| Tests | ✅ 118/118 | 12/12 suites, 12.30s |
| tsc --noEmit | ✅ Clean | zero errors |
| Hilo | ✅ 499 edges, 115 files | stable |
| GitReins | ✅ 8/8 complete, 0 pending | All DuckBrain tasks complete |
| SECURITY.md | ✅ Exists | — |
| CHANGELOG.md | ✅ Exists | — |
| LICENSE | ✅ Exists | Apache 2.0 |
| Docs | ✅ 9 files | api/, guide/, index.md, AI_CONFIGURE.md |
| TODO/FIXME | ✅ None in src/ | Clean |
| pnpm outdated | ⚠️ 4 stale | uuid 13→14, tsc 6→7, 2 deprecated @types (unchanged) |
| DuckBrain MCP | ✅ Full operational | 67 namespaces, read/write paths working. currentNamespace: hermes-dagger |
| Compaction stats | ℹ️ 0 records | — |
| CI/CD | ⚠️ Run #122 failed (Node 22.x int test timeout), #123 in_progress | Pre-existing, no code change |
| Config mutation | ⚠️ Reduced divergence | Committed: h3, Working: hermes-dagger, MCP: hermes-dagger. MCP matches working copy — 2-way divergence (improved from 3-way) |
| **E2E (FIRST EVER)** | 🔴 **32/36 pass, 4 bugs** | **Breakthrough.** 124 ticks without E2E → 4 real bugs found immediately |
| BUG-027 | 🔴 Critical | Tombstone filtering broken — deleted memories still returned by GET |
| BUG-028 | 🟡 Medium | Multi-segment key lookup fails (Express :key → need *) |
| BUG-029 | 🟢 Low | Invalid domain returns 500 instead of 400 |
| BUG-030 | ✅ Fixed | Missing vite.svg — foreman fixed directly (created public/vite.svg) |
| DB-001 | 🔴 BLOCKED | Awaiting Bane's embedding model decision — **124+ ticks** |
| DuckBrain entry | ✅ Written | Tick #124 entry |
| Git status | ⚠️ Modified: duckbrain.config.json | Branch: main. 0 commits ahead. Config: h3→hermes-dagger. Also: public/vite.svg (new, untracked) |
| Scheduler daemon | ✅ Operational | :9090 responding |

**NEVER-DONE 14-point audit (#124):**

| # | Check | Result | Notes |
|---|-------|--------|-------|
| 1 | Spec alignment | N/A | No specs/ directory |
| 2 | Doc coverage | ✅ PASS | docs/ with api/, guide/, index.md, AI_CONFIGURE.md |
| 3 | Test gaps | ⚠️ DB-023 | 6/7 route files lack unit tests — 83+ ticks stale |
| 4 | Package upgrades | ⚠️ DB-024 | uuid 13→14, tsc 6→7, 2 deprecated @types — 83+ ticks stale |
| 5 | Pitfall hunt | ✅ PASS | tsc clean, no TODO/FIXME |
| 6 | Performance audit | ✅ PASS | DB-019 completed |
| 7 | Endpoint verification | 🔴 **3 BUGS** | BUG-027 (tombstone), BUG-028 (key segments), BUG-029 (500→400) — found by E2E |
| 8 | CI/CD health | ⚠️ CI failure #122 | Node 22.x integration tests — pre-existing |
| 9 | DuckBrain sync | ✅ Full operational | 67 namespaces, read+write working |
| 10 | Code quality | ✅ PASS | tsc clean, secrets clean, build clean |
| 11 | Middle-out wiring | ✅ PASS | CLI, MCP, HTTP, UI all wired (499 edges) |
| 12 | Usability smoke test | ✅ PASS | Build succeeds, 118 tests pass |
| 13 | E2E testing | ✅ **RESOLVED** | First E2E run in 124 ticks — 36 endpoints, 32/36 pass, 4 bugs → 3 matrix rows |
| 14 | GitReins judge | ✅ PASS | deepseek-v4-flash configured |

**Verdict:** ACTIVE — 3 new bugs from first-ever E2E run. This validates the 5-10 tick E2E rule: 124 ticks without E2E = 4 production bugs lurking undetected. BUG-030 (favicon) fixed directly by foreman. BUG-027 (critical tombstone bug — deleted data accessible), BUG-028 (key segments), BUG-029 (status code) converted to matrix rows with model assignments. DB-023 and DB-024 remain stale at 83+ ticks — these need workers spawned on next ticks. Config mutation reduced from 3-way to 2-way divergence (MCP now matches working copy). DB-001 at 124+ ticks remains the sole blocker.

**E2E lesson:** The 5-10 tick E2E rule exists for a reason. 124 ticks of "tests pass, build clean" masked 4 real bugs including a critical tombstone filtering failure. E2E must run every 5-10 ticks going forward — not negotiable.

Board summary: 36 tasks completed (incl BUG-030), 3 pending (BUG-027/028/029), 1 BLOCKED (DB-001), 2 audit gaps open (DB-023, DB-024).
