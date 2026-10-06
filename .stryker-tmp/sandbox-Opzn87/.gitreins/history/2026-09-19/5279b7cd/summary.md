# Verdict: DF-0919-01

**Task:** Fix fresh install missing root package links
**Evaluated:** 2026-09-19T22:54:53.506706
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v4.1.10 /home/kara/duckbrain
- ✓ **tier2**
  - COMPLETE
  ✓ A clean frozen install must make the daemon boot successfully; reproduce on an empty install state, implement a durable fix, and add or update CI coverage; tests and build pass.: DURABLE FIX in HEAD (e9a839c is ancestor of HEAD): pnpm-workspace.yaml now declares `packages: - "packages/*"` (pre-fix e9a839c^ had no packages: key — the root cause), package.json adds "packageManager":"pnpm@12.4.2" (pre-fix absent), and ci.yml/release.yml moved off `npm ci` to pnpm/Node 22. REPRODUCED on empty state: `git archive HEAD` -> /tmp/df0919-eval (no node_modules), `pnpm install --frozen-lockfile --store-dir /tmp/df0919-store` -> 'Done in 7.2s using pnpm v12.4.2' exit 0; all 5 root links present as symlinks (express->.pnpm/express@5.2.1/..., duckdb, simple-git, tsx, zod) plus packages/ui/node_modules/react->../../../node_modules/.pnpm/react@19.3.0/node_modules/react. DAEMON BOOT: `node bin/duckbrain.js help` -> 'DuckBrain v1.0.0 - AI Memory System' EXIT=0; `node bin/duckbrain.js http --port 3999` -> 'HTTP server started at http://127.0.0.1:3999' / 'HTTP server ready'; ss shows LISTEN 127.0.0.1:3999; curl /health -> HTTP 503 {"status":"degraded"} (server up; degraded expected fresh per DF-0919-04). CI COVERAGE: .github/workflows/ci.yml:29-47 'Install from a clean store and smoke-test the CLI' asserts pnpm version, no node_modules, fresh store, frozen-lockfile install, root dep symlinks, workspace react link, and CLI boot banner; both workflows parse as valid YAML. TESTS: `npx vitest run` -> 'Test Files 155 passed (155) / Tests 1212 passed (1212)' Duration 127.81s, matching AGENTS.md:14/:33. BUILD: `pnpm build` EXIT=0 ('✓ built in 2.51s') in main repo and EXIT=0 on fresh clone ('✓ built in 3.31s'). TYPE CHECK: `npx tsc --noEmit` EXIT=0; LSP diagnostics 0. (Prior FAIL d3785c4f was solely a cross-process duckdb fixture race in tier1, since fixed by fd23b3c; its tier2 had already passed this criterion.)


## Summary

Judge Result: DF-0919-01

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v4.1.10 /home/kara/duckbrain

Stage tier2: PASS
  COMPLETE
  ✓ A clean frozen install must make the daemon boot successfully; reproduce on an empty install state, implement a durable fix, and add or update CI coverage; tests and build pass.: DURABLE FIX in HEAD (e9a839c is ancestor of HEAD): pnpm-workspace.yaml now declares `packages: - "packages/*"` (pre-fix e9a839c^ had no packages: key — the root cause), package.json adds "packageManager":"pnpm@12.4.2" (pre-fix absent), and ci.yml/release.yml moved off `npm ci` to pnpm/Node 22. REPRODUCED on empty state: `git archive HEAD` -> /tmp/df0919-eval (no node_modules), `pnpm install --frozen-lockfile --store-dir /tmp/df0919-store` -> 'Done in 7.2s using pnpm v12.4.2' exit 0; all 5 root links present as symlinks (express->.pnpm/express@5.2.1/..., duckdb, simple-git, tsx, zod) plus packages/ui/node_modules/react->../../../node_modules/.pnpm/react@19.3.0/node_modules/react. DAEMON BOOT: `node bin/duckbrain.js help` -> 'DuckBrain v1.0.0 - AI Memory System' EXIT=0; `node bin/duckbrain.js http --port 3999` -> 'HTTP server started at http://127.0.0.1:3999' / 'HTTP server ready'; ss shows LISTEN 127.0.0.1:3999; curl /health -> HTTP 503 {"status":"degraded"} (server up; degraded expected fresh per DF-0919-04). CI COVERAGE: .github/workflows/ci.yml:29-47 'Install from a clean store and smoke-test the CLI' asserts pnpm version, no node_modules, fresh store, frozen-lockfile install, root dep symlinks, workspace react link, and CLI boot banner; both workflows parse as valid YAML. TESTS: `npx vitest run` -> 'Test Files 155 passed (155) / Tests 1212 passed (1212)' Duration 127.81s, matching AGENTS.md:14/:33. BUILD: `pnpm build` EXIT=0 ('✓ built in 2.51s') in main repo and EXIT=0 on fresh clone ('✓ built in 3.31s'). TYPE CHECK: `npx tsc --noEmit` EXIT=0; LSP diagnostics 0. (Prior FAIL d3785c4f was solely a cross-process duckdb fixture race in tier1, since fixed by fd23b3c; its tier2 had already passed this criterion.)


Overall: PASS ✓
