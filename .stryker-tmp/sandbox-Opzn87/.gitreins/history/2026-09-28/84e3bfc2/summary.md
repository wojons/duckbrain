# Verdict: DF-0924-01

**Task:** Verify default-branch fresh install
**Evaluated:** 2026-09-28T03:15:05.744760
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: RUN  v5.0.1 /home/kara/duckbrain
- ✓ **tier2**
  - COMPLETE
  ✓ A clean frozen install of the default branch must link express directly and boot the documented HTTP quickstart without manual package fixes; verify the exact default-branch acceptance criteria.: package.json:45 declares "express": "^5.2.1" as a DIRECT dependency; pnpm-lock.yaml:184-186 root importer declares express specifier ^5.2.1 -> 5.2.1(supports-color@10.2.2) and package-lock.json root deps express ^5.2.1 / node_modules/express 5.2.1. `pnpm install --frozen-lockfile --lockfile-only` -> 'Lockfile passes supply-chain policies ... Done' exit 0. Genuine clean frozen install in isolated copy (/tmp/freshinstall from `git archive HEAD`): `pnpm install --frozen-lockfile` -> 'dependencies: + express 5.2.1' (top-level link), exit 0, no manual fixes; `require.resolve('express')` -> /tmp/freshinstall/node_modules/.pnpm/express@5.2.1.../express/index.js. Documented quickstart booted from that fresh install: `node bin/duckbrain.js http --port=3996 --auth=none` -> '[duckbrain] HTTP server ready'; README steps 3-5 returned {"name":"quickstart"}, write -> {"key":"/quickstart/hello","content":"first memory from the quickstart"}, read-back identical — matching README:132 success criteria exactly. Regression guard src/utils/dependency-declaration.test.ts (DOGFOOD-0904-02) asserts express is in dependencies (not devDependencies), resolves from repo root, major 5: `npx vitest run src/utils/dependency-declaration.test.ts` -> Test Files 1 passed (1), Tests 4 passed (4), exit 0; combined run with namespaces.test.ts -> 2 files / 19 tests passed, exit 0. src/cli/http.ts:19 and src/http/routes/*.ts import express directly, satisfied by the direct link.
A clean frozen install of the default branch links express 5.2.1 directly and boots the documented HTTP quickstart end-to-end with no manual package fixes, guarded by a passing regression test.

## Summary

Judge Result: DF-0924-01

Stage tier1: FAIL
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: RUN  v5.0.1 /home/kara/duckbrain

Stage tier2: PASS
  COMPLETE
  ✓ A clean frozen install of the default branch must link express directly and boot the documented HTTP quickstart without manual package fixes; verify the exact default-branch acceptance criteria.: package.json:45 declares "express": "^5.2.1" as a DIRECT dependency; pnpm-lock.yaml:184-186 root importer declares express specifier ^5.2.1 -> 5.2.1(supports-color@10.2.2) and package-lock.json root deps express ^5.2.1 / node_modules/express 5.2.1. `pnpm install --frozen-lockfile --lockfile-only` -> 'Lockfile passes supply-chain policies ... Done' exit 0. Genuine clean frozen install in isolated copy (/tmp/freshinstall from `git archive HEAD`): `pnpm install --frozen-lockfile` -> 'dependencies: + express 5.2.1' (top-level link), exit 0, no manual fixes; `require.resolve('express')` -> /tmp/freshinstall/node_modules/.pnpm/express@5.2.1.../express/index.js. Documented quickstart booted from that fresh install: `node bin/duckbrain.js http --port=3996 --auth=none` -> '[duckbrain] HTTP server ready'; README steps 3-5 returned {"name":"quickstart"}, write -> {"key":"/quickstart/hello","content":"first memory from the quickstart"}, read-back identical — matching README:132 success criteria exactly. Regression guard src/utils/dependency-declaration.test.ts (DOGFOOD-0904-02) asserts express is in dependencies (not devDependencies), resolves from repo root, major 5: `npx vitest run src/utils/dependency-declaration.test.ts` -> Test Files 1 passed (1), Tests 4 passed (4), exit 0; combined run with namespaces.test.ts -> 2 files / 19 tests passed, exit 0. src/cli/http.ts:19 and src/http/routes/*.ts import express directly, satisfied by the direct link.
A clean frozen install of the default branch links express 5.2.1 directly and boots the documented HTTP quickstart end-to-end with no manual package fixes, guarded by a passing regression test.

Overall: FAIL ✗
