# Verdict: DF-0919-03

**Task:** Align README prerequisites with supported pnpm
**Evaluated:** 2026-09-19T23:17:54.813852
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v4.1.10 /home/kara/duckbrain
- ✓ **tier2**
  - COMPLETE
  ✓ README must state the verified pnpm major and provide a non-root corepack enable command that works on a fresh user; documentation remains accurate and the relevant checks pass.: README.md:74 states 'pnpm 12' and pins the tested release '12.4.2', matching package.json:4 "packageManager": "pnpm@12.4.2". README.md:82-87 provides the non-root command sequence: `mkdir -p ~/.local/bin` / `corepack enable pnpm --install-directory ~/.local/bin` / `export PATH="$HOME/.local/bin:$PATH"` / `corepack prepare pnpm@12.4.2 --activate` / `pnpm --version  # expect 12.4.2`. LIVE VERIFIED on fresh user 'kara': /usr/bin is root-owned and NOT writable, yet `corepack enable pnpm --install-directory /tmp/cptest` returned exit=0 and created a user-owned shim (pnpm -> corepack/dist/pnpm.js); `corepack prepare pnpm@12.4.2 --activate` exit=0; `pnpm --version` printed 12.4.2. Docs consistent: docs/guide/getting-started.md:26-35 updated to pnpm 12.4.2 with the same non-root corepack command; CI .github/workflows/ci.yml:31 asserts `pnpm --version` = 12.4.2. Relevant checks pass: `npx vitest run` -> 'Test Files 155 passed (155)', 'Tests 1212 passed (1212)', EXIT=0. Only residual nit: AGENTS.md:16 still reads 'pnpm 11+' (a loose range in the agent guide, not the README and not among this task's changed files), which does not contradict the README's stated major.
README states pnpm 12 / pinned 12.4.2 matching package.json, the non-root corepack enable command was verified live to work for a non-root user, docs are consistent, and the full vitest suite passes (155 files / 1212 tests, EXIT=0).

## Summary

Judge Result: DF-0919-03

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v4.1.10 /home/kara/duckbrain

Stage tier2: PASS
  COMPLETE
  ✓ README must state the verified pnpm major and provide a non-root corepack enable command that works on a fresh user; documentation remains accurate and the relevant checks pass.: README.md:74 states 'pnpm 12' and pins the tested release '12.4.2', matching package.json:4 "packageManager": "pnpm@12.4.2". README.md:82-87 provides the non-root command sequence: `mkdir -p ~/.local/bin` / `corepack enable pnpm --install-directory ~/.local/bin` / `export PATH="$HOME/.local/bin:$PATH"` / `corepack prepare pnpm@12.4.2 --activate` / `pnpm --version  # expect 12.4.2`. LIVE VERIFIED on fresh user 'kara': /usr/bin is root-owned and NOT writable, yet `corepack enable pnpm --install-directory /tmp/cptest` returned exit=0 and created a user-owned shim (pnpm -> corepack/dist/pnpm.js); `corepack prepare pnpm@12.4.2 --activate` exit=0; `pnpm --version` printed 12.4.2. Docs consistent: docs/guide/getting-started.md:26-35 updated to pnpm 12.4.2 with the same non-root corepack command; CI .github/workflows/ci.yml:31 asserts `pnpm --version` = 12.4.2. Relevant checks pass: `npx vitest run` -> 'Test Files 155 passed (155)', 'Tests 1212 passed (1212)', EXIT=0. Only residual nit: AGENTS.md:16 still reads 'pnpm 11+' (a loose range in the agent guide, not the README and not among this task's changed files), which does not contradict the README's stated major.
README states pnpm 12 / pinned 12.4.2 matching package.json, the non-root corepack enable command was verified live to work for a non-root user, docs are consistent, and the full vitest suite passes (155 files / 1212 tests, EXIT=0).

Overall: PASS ✓
