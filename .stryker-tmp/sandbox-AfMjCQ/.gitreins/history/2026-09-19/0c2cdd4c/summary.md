# Verdict: OPS-005

**Task:** Enforce Node 22 requirement and align CI matrix
**Evaluated:** 2026-09-19T18:58:25.035173
**Result:** ✗ FAIL

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v4.1.10 /home/kara/duckbrain
- ✗ **tier2**
  - INCOMPLETE
  ✗ Node below 22 fails clearly at install time; CI matrix no longer tests unsupported Node 20; tests and docs verify the contract.: Three of four sub-requirements unmet. (1) Install-time failure: package.json:58-60 declares engines.node ">=22" but there is NO .npmrc (test -f .npmrc => NO), no engine-strict=true anywhere (grep engine-strict => empty), no preinstall/postinstall script (grep preinstall package.json => empty), and no .nvmrc — npm's default engine-strict=false means Node<22 only warns, not fails clearly. (2) CI matrix: .github/workflows/ci.yml:15 still lists `node-version: [20.x, 22.x]` so unsupported Node 20 is still tested; .github/workflows/release.yml:20 also pins node-version "20.x". (3) Tests: grep of tests/ for engines/process.versions.node/node-version/>=22 returns nothing — no test verifies the contract (suite runs via `npx vitest run`, test_command from .gitreins/config.yaml, but no test asserts the Node requirement). (4) Docs only partially satisfied: docs/guide/getting-started.md:18 and README.md:82 mention Node 22+. The task diff only added the .gitreins/tasks.yaml row (plus an unrelated skills/duckbrain-usage/SKILL.md edit); git log shows no OPS-005 implementation commit, and prior verdict commit b067847 already recorded OPS-005 FAIL for the same reasons.
The task made no code/CI/test changes — Node 20 remains in the CI matrix, there is no install-time hard failure for Node<22 (no .npmrc/engine-strict/preinstall), and no test verifies the contract, so the criterion fails.

## Summary

Judge Result: OPS-005

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v4.1.10 /home/kara/duckbrain

Stage tier2: FAIL
  INCOMPLETE
  ✗ Node below 22 fails clearly at install time; CI matrix no longer tests unsupported Node 20; tests and docs verify the contract.: Three of four sub-requirements unmet. (1) Install-time failure: package.json:58-60 declares engines.node ">=22" but there is NO .npmrc (test -f .npmrc => NO), no engine-strict=true anywhere (grep engine-strict => empty), no preinstall/postinstall script (grep preinstall package.json => empty), and no .nvmrc — npm's default engine-strict=false means Node<22 only warns, not fails clearly. (2) CI matrix: .github/workflows/ci.yml:15 still lists `node-version: [20.x, 22.x]` so unsupported Node 20 is still tested; .github/workflows/release.yml:20 also pins node-version "20.x". (3) Tests: grep of tests/ for engines/process.versions.node/node-version/>=22 returns nothing — no test verifies the contract (suite runs via `npx vitest run`, test_command from .gitreins/config.yaml, but no test asserts the Node requirement). (4) Docs only partially satisfied: docs/guide/getting-started.md:18 and README.md:82 mention Node 22+. The task diff only added the .gitreins/tasks.yaml row (plus an unrelated skills/duckbrain-usage/SKILL.md edit); git log shows no OPS-005 implementation commit, and prior verdict commit b067847 already recorded OPS-005 FAIL for the same reasons.
The task made no code/CI/test changes — Node 20 remains in the CI matrix, there is no install-time hard failure for Node<22 (no .npmrc/engine-strict/preinstall), and no test verifies the contract, so the criterion fails.

Overall: FAIL ✗
