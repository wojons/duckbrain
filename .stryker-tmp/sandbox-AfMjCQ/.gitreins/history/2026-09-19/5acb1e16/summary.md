# Verdict: OPS-005

**Task:** Enforce Node 22 requirement and align CI matrix
**Evaluated:** 2026-09-19T19:23:48.159748
**Result:** ✗ FAIL

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v4.1.10 /home/kara/duckbrain
- ✗ **tier2**
  - INCOMPLETE
  ✗ Node below 22 fails clearly at install time; CI matrix no longer tests unsupported Node 20; tests and docs verify the contract.: FAIL: OPS-005 criterion "Node below 22 fails clearly at install time; CI matrix no longer tests unsupported Node 20; tests and docs verify the contract."

(1) Install-time failure: package.json:58-60 has engines.node ">=22" BUT no .npmrc (test -f .npmrc => NO), no engine-strict (npm config get engine-strict => false), no preinstall/postinstall script (grep preinstall package.json => empty), no .nvmrc. npm default engine-strict=false => Node<22 only WARNS (EBADENGINE warning), does not fail clearly. FAIL.

(2) CI matrix: .github/workflows/ci.yml:15 still `node-version: [20.x, 22.x]` — unsupported Node 20 STILL tested. .github/workflows/release.yml:20 also pins node-version "20.x". FAIL.

(3) Tests: grep -rln "engines" tests/ => empty; no test asserts the Node>=22 contract. FAIL.

(4) Docs: docs/guide/getting-started.md:18 says "Node.js 22+ (required by package.json engines: >=22)"; README.md:82 mentions Node 22. Docs partially satisfied but criterion requires all parts.

Git log: no OPS-005 implementation commit; only verdict commits bdfd11e and b067847 both recording FAIL. Working tree diff only touches .coding-hermes/board files (unrelated).
Partial verdict — evaluation hit resource cap before all criteria verified

## Summary

Judge Result: OPS-005

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v4.1.10 /home/kara/duckbrain

Stage tier2: FAIL
  INCOMPLETE
  ✗ Node below 22 fails clearly at install time; CI matrix no longer tests unsupported Node 20; tests and docs verify the contract.: FAIL: OPS-005 criterion "Node below 22 fails clearly at install time; CI matrix no longer tests unsupported Node 20; tests and docs verify the contract."

(1) Install-time failure: package.json:58-60 has engines.node ">=22" BUT no .npmrc (test -f .npmrc => NO), no engine-strict (npm config get engine-strict => false), no preinstall/postinstall script (grep preinstall package.json => empty), no .nvmrc. npm default engine-strict=false => Node<22 only WARNS (EBADENGINE warning), does not fail clearly. FAIL.

(2) CI matrix: .github/workflows/ci.yml:15 still `node-version: [20.x, 22.x]` — unsupported Node 20 STILL tested. .github/workflows/release.yml:20 also pins node-version "20.x". FAIL.

(3) Tests: grep -rln "engines" tests/ => empty; no test asserts the Node>=22 contract. FAIL.

(4) Docs: docs/guide/getting-started.md:18 says "Node.js 22+ (required by package.json engines: >=22)"; README.md:82 mentions Node 22. Docs partially satisfied but criterion requires all parts.

Git log: no OPS-005 implementation commit; only verdict commits bdfd11e and b067847 both recording FAIL. Working tree diff only touches .coding-hermes/board files (unrelated).
Partial verdict — evaluation hit resource cap before all criteria verified

Overall: FAIL ✗
