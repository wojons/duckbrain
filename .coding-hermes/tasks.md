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

### 🔧 TICK #35 — BUILD FIX + DISPATCH (2026-07-24 21:00) — pnpm 11 build scripts, dispatched DB-021

- 🔴 **FIXED: pnpm 11 ignores build scripts** — DuckDB native module (`duckdb.node`) was missing. 5 test suites failed (connection, queries, http CLI, human CLI, stdio CLI). Root cause: pnpm 11.0+ moved build-dependency config to `pnpm-workspace.yaml` `allowBuilds` map (replaces pnpm 10 `onlyBuiltDependencies`).
- ✅ **Fix:** Created `pnpm-workspace.yaml` with `allowBuilds: {duckdb: true, esbuild: true}`. `duckdb.node` now downloads on install.
- ✅ **Tests:** 65/65 pass, 10/10 suites, 12.3s
- ✅ **Hilo:** 476 edges, 111 files — consistent
- ✅ **GitReins guard:** secrets clean
- ✅ **GitReins config:** evaluator configured (deepseek-v4-flash)
- ✅ **Committed:** pnpm-workspace.yaml + pnpm-lock.yaml (was untracked since project creation)
- 🚀 **Dispatched DB-021** (command injection audit) via worker → **COMPLETED (88576c0)**: 39 security tests, 104/104 total
- ⚠️ **Load:** 2.89 — well below dispatch threshold
- ⚠️ **TODO/FIXME:** node_modules only (noise)

Board summary: 27 tasks completed, 3 pending (DB-016, DB-018, DB-019), 1 BLOCKED (DB-001).

### 🛑 TICK #34 — BOARD CORRECTION (2026-07-25 01:52 UTC) — GitReins sync found 9 hidden pending tasks

- ❌ **FABRICATED BOARD DETECTED:** Prior 33 ticks claimed "ALL TASKS COMPLETE" — GitReins had 9 pending tasks the board never acknowledged.
- ✅ **Synced 4/9 to complete** (already done in code, just never synced): DB-014 (CI), DB-015 (docs), DB-017 (dedup resolveNamespacePath), DB-020 (GitReins config)
- ⚠️ **4 REAL pending tasks added to board:** DB-016, DB-018, DB-019, DB-021
- ✅ **Build:** clean (tsc --noEmit)
- ✅ **Tests:** 65/65 pass, 12.2s
- ✅ **Hilo:** 476 edges, 111 files — consistent
- ✅ **GitReins guard:** clean
- ✅ **Cooldown:** reverted to 1350s (from expected 21600) → fixed to 900s (real work found)
- ⚠️ **DB-001 still BLOCKED** on Bane's embedding model decision
- ⚠️ **Board staleness: 33 ticks wasted claiming "idle" with 9 pending GitReins tasks**

Board summary: 26 tasks completed (DB-000 through DB-017, DB-020), 4 pending real tasks, 1 BLOCKED (DB-001). **Real work found — project is ACTIVE.**

# DuckBrain — Model Router Task Matrix

> **Core purpose:** Git-backed persistent memory system for AI agents — DuckDB storage, MCP tools, HTTP API, namespace management.
> **Language:** TypeScript | **Tests:** 65/65 pass | **Build:** clean | **Status:** ACTIVE (4 pending + 1 blocked)

## Active

| ID | Task | Pri | Cpx | Deps | Tags | Model | Reasoning | Fallback |
|----|------|-----|-----|------|------|-------|-----------|----------|
| DB-016 | Replace HTTP stubs (/users, /activity) with real implementations | High | 4±1 | — | +++backend, ++api | GLM-5.2 | Medium | DS-V4-Flash |
| DB-018 | BigInt serialization fix in DuckDB queries | Medium | 2±1 | — | ++backend, +duckdb | DS-V4-Flash | Low | GLM-5.2 |
| DB-019 | Replace linear-scan lookups with DuckDB WHERE clauses | Medium | 3±1 | — | ++backend, +perf, +duckdb | DS-V4-Flash | Medium | GLM-5.2 |

## Blocked

| ID | Task | Pri | Cpx | Deps | Tags | Blocker |
|----|------|-----|-----|------|------|---------|
| DB-001 | Embedding model selection for VSS | Critical | — | — | ++ml, +duckdb | Bane decision on embedding model |

## Completed

| ID | Task | Commit | Synced |
|----|------|--------|--------|
| DB-014 | CI/CD: GitHub Actions workflow | ci.yml/release.yml | Tick #34 |
| DB-015 | DOC: Missing docs pages | All 4 pages exist | Tick #34 |
| DB-017 | QUALITY: Dedup resolveNamespacePath | shared.ts extraction | Tick #34 |
| DB-020 | SECURITY: GitReins guard config | .gitreins/config.yaml | Tick #34 |
| DB-021 | SECURITY: CLI command injection hardened | 88576c0 | Tick #35 |
| DB-000–DB-013, DB-022 | All prior tasks | Prior ticks | Prior ticks |

- [ ] E2E-001 — E2E Testing Tick (self-improving loop) 🔁 Every 5-10 ticks
  Spawn Luna (browser/screenshots) or Step 3.7 Flash (CLI/API). Deploy/build,
  Playwright, screenshots, endpoints, console. → e2e-output/tasks.md → inject
  into board. See foreman Step 1.5i. Every 5-10 ticks.

- [ ] NEVER-DONE — Run coding-hermes-never-done 14-point audit
  Load coding-hermes-never-done skill. Run ALL 14 checks. Create a task
  for EVERY gap found. This task is never complete — the audit always finds something.
