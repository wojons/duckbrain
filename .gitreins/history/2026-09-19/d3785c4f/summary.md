# Verdict: DF-0919-01

**Task:** Fix fresh install missing root package links
**Evaluated:** 2026-09-19T22:14:54.886503
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: RUN  v4.1.10 /home/kara/duckbrain
- ✓ **tier2**
  - COMPLETE
  ✓ A clean frozen install must make the daemon boot successfully; reproduce on an empty install state, implement a durable fix, and add or update CI coverage; tests and build pass.: Reproduced on empty install state: cloned repo to /tmp/df0919-repro/app (no node_modules) and ran `pnpm install --frozen-lockfile --store-dir <fresh>` -> 'Done in 11.2s using pnpm v12.4.2'; all root deps linked (express, duckdb, simple-git, tsx, zod) plus packages/ui/node_modules/react. Daemon boot: `node bin/duckbrain.js http --port 3999` logged 'HTTP server started at http://127.0.0.1:3999' / 'HTTP server ready', ss shows LISTEN 127.0.0.1:3999, curl /health -> 200 {"status":"degraded",...} (degraded expected fresh per DF-0919-04); `node bin/duckbrain.js help` -> 'DuckBrain v1.0.0 - AI Memory System' EXIT=0. Durable fix in commit e9a839c (ancestor of HEAD): package.json adds "packageManager":"pnpm@12.4.2"; pnpm-workspace.yaml adds explicit `packages: - "packages/*"` (pre-fix had none); ci.yml/release.yml aligned on pnpm+Node 22. CI coverage: .github/workflows/ci.yml lines 29-47 'Install from a clean store and smoke-test the CLI' asserts pnpm version 12.4.2, no node_modules, fresh store, frozen-lockfile install, root dep symlinks, workspace react link, and CLI boot banner (valid YAML). Tests: `npx vitest run` -> 'Test Files 155 passed (155) / Tests 1212 passed (1212)' Duration 146.23s, matching AGENTS.md. Build: `pnpm build` EXIT=0 ('✓ built in 2.35s') in main repo and EXIT=0 on the fresh clone ('✓ built in 3.16s'). Type check `pnpm tsc --noEmit` EXIT=0; LSP diagnostics 0.
Clean frozen install links all root/workspace deps and boots the daemon successfully, with a durable pnpm-workspace/packageManager fix, CI clean-install smoke coverage, and passing tests (1212/1212), build, and type check.

## Summary

Judge Result: DF-0919-01

Stage tier1: FAIL
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: RUN  v4.1.10 /home/kara/duckbrain

Stage tier2: PASS
  COMPLETE
  ✓ A clean frozen install must make the daemon boot successfully; reproduce on an empty install state, implement a durable fix, and add or update CI coverage; tests and build pass.: Reproduced on empty install state: cloned repo to /tmp/df0919-repro/app (no node_modules) and ran `pnpm install --frozen-lockfile --store-dir <fresh>` -> 'Done in 11.2s using pnpm v12.4.2'; all root deps linked (express, duckdb, simple-git, tsx, zod) plus packages/ui/node_modules/react. Daemon boot: `node bin/duckbrain.js http --port 3999` logged 'HTTP server started at http://127.0.0.1:3999' / 'HTTP server ready', ss shows LISTEN 127.0.0.1:3999, curl /health -> 200 {"status":"degraded",...} (degraded expected fresh per DF-0919-04); `node bin/duckbrain.js help` -> 'DuckBrain v1.0.0 - AI Memory System' EXIT=0. Durable fix in commit e9a839c (ancestor of HEAD): package.json adds "packageManager":"pnpm@12.4.2"; pnpm-workspace.yaml adds explicit `packages: - "packages/*"` (pre-fix had none); ci.yml/release.yml aligned on pnpm+Node 22. CI coverage: .github/workflows/ci.yml lines 29-47 'Install from a clean store and smoke-test the CLI' asserts pnpm version 12.4.2, no node_modules, fresh store, frozen-lockfile install, root dep symlinks, workspace react link, and CLI boot banner (valid YAML). Tests: `npx vitest run` -> 'Test Files 155 passed (155) / Tests 1212 passed (1212)' Duration 146.23s, matching AGENTS.md. Build: `pnpm build` EXIT=0 ('✓ built in 2.35s') in main repo and EXIT=0 on the fresh clone ('✓ built in 3.16s'). Type check `pnpm tsc --noEmit` EXIT=0; LSP diagnostics 0.
Clean frozen install links all root/workspace deps and boots the daemon successfully, with a durable pnpm-workspace/packageManager fix, CI clean-install smoke coverage, and passing tests (1212/1212), build, and type check.

Overall: FAIL ✗
