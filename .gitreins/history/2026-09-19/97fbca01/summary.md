# Verdict: DF-0919-03

**Task:** Align README prerequisites with supported pnpm
**Evaluated:** 2026-09-19T22:32:39.448498
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: RUN  v4.1.10 /home/kara/duckbrain
- ✗ **tier2**
  - INCOMPLETE
  ✗ README must state the verified pnpm major and provide a non-root corepack enable command that works on a fresh user; documentation remains accurate and the relevant checks pass.: Criterion 0 (README pnpm major + non-root corepack enable):
- README.md:74 "You need git, Node.js 22+, and pnpm 12. The repository pins the tested pnpm release (12.4.2) in package.json."
- README.md:82-87: mkdir -p ~/.local/bin; corepack enable pnpm --install-directory ~/.local/bin; export PATH="$HOME/.local/bin:$PATH"; corepack prepare pnpm@12.4.2 --activate; pnpm --version # expect 12.4.2
- package.json:4 "packageManager": "pnpm@12.4.2" -> matches README.
- Live verification on fresh dir /tmp/cptest: `corepack enable pnpm --install-directory ~/.local/bin` exit=0, created symlink ~/.local/bin/pnpm -> corepack/dist/pnpm.js (no root write); `corepack prepare pnpm@12.4.2 --activate` exit=0; `pnpm --version` -> 12.4.2.
- `npm view pnpm@12.4.2 version` -> 12.4.2 (major 12 exists).
- Fresh-store install with documented version: /tmp/cptest2 `pnpm install --frozen-lockfile --store-dir /tmp/cptest-store` exit=0, "Done in 169ms using pnpm v12.4.2", lockfileVersion 9.0 accepted.
- CI (.github/workflows/ci.yml:31) asserts pnpm --version = 12.4.2, consistent with README.
- Minor doc inconsistency: AGENTS.md:16 says "pnpm 11+" (stale, not README).
Partial verdict — evaluation hit resource cap before all criteria verified

## Summary

Judge Result: DF-0919-03

Stage tier1: FAIL
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: RUN  v4.1.10 /home/kara/duckbrain

Stage tier2: FAIL
  INCOMPLETE
  ✗ README must state the verified pnpm major and provide a non-root corepack enable command that works on a fresh user; documentation remains accurate and the relevant checks pass.: Criterion 0 (README pnpm major + non-root corepack enable):
- README.md:74 "You need git, Node.js 22+, and pnpm 12. The repository pins the tested pnpm release (12.4.2) in package.json."
- README.md:82-87: mkdir -p ~/.local/bin; corepack enable pnpm --install-directory ~/.local/bin; export PATH="$HOME/.local/bin:$PATH"; corepack prepare pnpm@12.4.2 --activate; pnpm --version # expect 12.4.2
- package.json:4 "packageManager": "pnpm@12.4.2" -> matches README.
- Live verification on fresh dir /tmp/cptest: `corepack enable pnpm --install-directory ~/.local/bin` exit=0, created symlink ~/.local/bin/pnpm -> corepack/dist/pnpm.js (no root write); `corepack prepare pnpm@12.4.2 --activate` exit=0; `pnpm --version` -> 12.4.2.
- `npm view pnpm@12.4.2 version` -> 12.4.2 (major 12 exists).
- Fresh-store install with documented version: /tmp/cptest2 `pnpm install --frozen-lockfile --store-dir /tmp/cptest-store` exit=0, "Done in 169ms using pnpm v12.4.2", lockfileVersion 9.0 accepted.
- CI (.github/workflows/ci.yml:31) asserts pnpm --version = 12.4.2, consistent with README.
- Minor doc inconsistency: AGENTS.md:16 says "pnpm 11+" (stale, not README).
Partial verdict — evaluation hit resource cap before all criteria verified

Overall: FAIL ✗
