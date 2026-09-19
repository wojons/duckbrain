# Verdict: DF-0919-03

**Task:** Align README prerequisites with supported pnpm
**Evaluated:** 2026-09-19T19:58:07.507824
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: RUN  v4.1.10 /home/kara/duckbrain
- ✗ **tier2**
  - INCOMPLETE
  ✗ README must state the verified pnpm major and provide a non-root corepack enable command that works on a fresh user; documentation remains accurate and the relevant checks pass.: Criterion 0: "README must state the verified pnpm major and provide a non-root corepack enable command that works on a fresh user; documentation remains accurate and the relevant checks pass."

Sub-findings:
(a) README states verified pnpm major: README.md:74 "You need **git**, **Node.js 22+**, and **pnpm 12**. The repository pins the tested pnpm release (`12.4.2`) in `package.json`." package.json:4 "packageManager": "pnpm@12.4.2". pnpm-lock.yaml lockfileVersion 9.0 with @pnpm/exe.*@12.4.2 entries. PASS.
(b) Non-root corepack enable: README.md:82-87:
  mkdir -p ~/.local/bin
  corepack enable pnpm --install-directory ~/.local/bin
  export PATH="$HOME/.local/bin:$PATH"
  corepack prepare pnpm@12.4.2 --activate
  pnpm --version  # expect 12.4.2
  Verified locally: corepack 0.34.6 on node v22.22.3 accepts `enable pnpm --install-directory <dir>` (no sudo, writes to user dir). Simulated run with stub corepack printed "corepack called: enable pnpm --install-directory /home/kara/.local/bin" and "prepare pnpm@12.4.2 --activate"; pnpm --version -> 12.4.2. PASS.
(c) Documentation remains accurate: FAIL. Stale pnpm 11 references remain:
  - docs/guide/getting-started.md:26 "**pnpm** 11.13.1 ... only pnpm major exercised by the clean-install CI smoke"; :30 "corepack prepare pnpm@11.13.1 --activate"; :33 "Do not use pnpm 12 to refresh this repository's pnpm 11 lockfile." — directly contradicts README/package.json (pnpm 12.4.2).
  - CONTRIBUTING.md:11 "- pnpm 11.13.1 (pinned by `package.json`)" — false, package.json pins 12.4.2.
  - AGENTS.md:16 "- **Package Manager:** pnpm 11+".
  - .github/workflows/ci.yml:31 `test "$(pnpm --version)" = "11.13.1"` — CI smoke asserts pnpm 11.13.1 while pnpm/action-setup@v4 reads packageManager pin 12.4.2 => CI install step fails.
(d) Relevant checks: see test run evidence.

Partial verdict — evaluation hit resource cap before all criteria verified

## Summary

Judge Result: DF-0919-03

Stage tier1: FAIL
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: RUN  v4.1.10 /home/kara/duckbrain

Stage tier2: FAIL
  INCOMPLETE
  ✗ README must state the verified pnpm major and provide a non-root corepack enable command that works on a fresh user; documentation remains accurate and the relevant checks pass.: Criterion 0: "README must state the verified pnpm major and provide a non-root corepack enable command that works on a fresh user; documentation remains accurate and the relevant checks pass."

Sub-findings:
(a) README states verified pnpm major: README.md:74 "You need **git**, **Node.js 22+**, and **pnpm 12**. The repository pins the tested pnpm release (`12.4.2`) in `package.json`." package.json:4 "packageManager": "pnpm@12.4.2". pnpm-lock.yaml lockfileVersion 9.0 with @pnpm/exe.*@12.4.2 entries. PASS.
(b) Non-root corepack enable: README.md:82-87:
  mkdir -p ~/.local/bin
  corepack enable pnpm --install-directory ~/.local/bin
  export PATH="$HOME/.local/bin:$PATH"
  corepack prepare pnpm@12.4.2 --activate
  pnpm --version  # expect 12.4.2
  Verified locally: corepack 0.34.6 on node v22.22.3 accepts `enable pnpm --install-directory <dir>` (no sudo, writes to user dir). Simulated run with stub corepack printed "corepack called: enable pnpm --install-directory /home/kara/.local/bin" and "prepare pnpm@12.4.2 --activate"; pnpm --version -> 12.4.2. PASS.
(c) Documentation remains accurate: FAIL. Stale pnpm 11 references remain:
  - docs/guide/getting-started.md:26 "**pnpm** 11.13.1 ... only pnpm major exercised by the clean-install CI smoke"; :30 "corepack prepare pnpm@11.13.1 --activate"; :33 "Do not use pnpm 12 to refresh this repository's pnpm 11 lockfile." — directly contradicts README/package.json (pnpm 12.4.2).
  - CONTRIBUTING.md:11 "- pnpm 11.13.1 (pinned by `package.json`)" — false, package.json pins 12.4.2.
  - AGENTS.md:16 "- **Package Manager:** pnpm 11+".
  - .github/workflows/ci.yml:31 `test "$(pnpm --version)" = "11.13.1"` — CI smoke asserts pnpm 11.13.1 while pnpm/action-setup@v4 reads packageManager pin 12.4.2 => CI install step fails.
(d) Relevant checks: see test run evidence.

Partial verdict — evaluation hit resource cap before all criteria verified

Overall: FAIL ✗
