# Verdict: DF-2026-9

**Task:** CLI status consumes the space-form --namespace value
**Evaluated:** 2026-10-28T02:44:01.839186
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✗ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✗ **tier2**
  - INCOMPLETE
  ✗ node bin/duckbrain.js status --namespace dogfood1027 prints Namespace: dogfood1027 and the configured path, matching the equals form; a missing value or an unknown namespace fails loudly instead of resolving to true/default; regression tests cover both forms and the unknown-namespace case.: The literal acceptance command still exhibits the original bug. Actual run: `node bin/duckbrain.js status --namespace dogfood1027` -> "Namespace: true / Path: ./memory/default / Status: OK", exit 0, while `--namespace=dogfood1027` -> "Namespace: dogfood1027" — the two forms DISAGREE. Unknown namespace (`--namespace definitely-not-a-real-ns-xyz`) and missing value (`--namespace`) both print "Namespace: true ... Status: OK" with exit 0, i.e. they do NOT fail loudly. Root cause: bin/duckbrain.js:16-19 prefers the precompiled entry (`if (fs.existsSync(distEntry)) require(distEntry)`), and dist/src/cli/human.js is a stale 2026-10-22 build whose statusCommand (dist/src/cli/human.js:1022-1038) is the ORIGINAL buggy version (`const { flags } = parseArgs(args); const namespace = flags.namespace || getDefaultNamespace(); const nsPath = config.namespaceMappings?.[namespace] || "./memory/default";`) with no normalizeStatusNamespaceFlags, no namespaceExplicit, and no unknown-namespace guard. The fix exists only in TypeScript source (src/cli/human.ts:1285-1350 plus normalizeStatusNamespaceFlags at :628-648) and was never rebuilt into dist/. Proof: moving dist/ aside so bin/duckbrain.js falls back to tsx/TS source yields "Error: Namespace 'dogfood1027' does not exist" exit 1 — the source fix is live but the shipped entry point never reaches it. Tests: `npx vitest run src/cli/status-namespace-df2026-9.test.ts` -> exit 0, "Tests 11 passed (11)"; `npx vitest run src/cli/` -> exit 0, "Tests 409 passed (409)". However these tests are a false green for this criterion: src/cli/status-namespace-df2026-9.test.ts:41 imports `runHumanCLI` from "./human" (TS source) and calls it in-process, never spawning bin/duckbrain.js nor touching dist/, so the regression tests do not cover the entry point the criterion names. Missing: rebuild dist/ (pnpm build:cli) and/or add an end-to-end test that spawns bin/duckbrain.js.
The source-level fix and its 11 unit tests are correct, but the fix was never compiled into dist/, so the shipped `node bin/duckbrain.js status --namespace dogfood1027` still prints "Namespace: true" and unknown/missing namespaces still exit 0 — the criterion's literal command fails.

## Summary

Judge Result: DF-2026-9

Stage tier1: FAIL
    ✗ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: FAIL
  INCOMPLETE
  ✗ node bin/duckbrain.js status --namespace dogfood1027 prints Namespace: dogfood1027 and the configured path, matching the equals form; a missing value or an unknown namespace fails loudly instead of resolving to true/default; regression tests cover both forms and the unknown-namespace case.: The literal acceptance command still exhibits the original bug. Actual run: `node bin/duckbrain.js status --namespace dogfood1027` -> "Namespace: true / Path: ./memory/default / Status: OK", exit 0, while `--namespace=dogfood1027` -> "Namespace: dogfood1027" — the two forms DISAGREE. Unknown namespace (`--namespace definitely-not-a-real-ns-xyz`) and missing value (`--namespace`) both print "Namespace: true ... Status: OK" with exit 0, i.e. they do NOT fail loudly. Root cause: bin/duckbrain.js:16-19 prefers the precompiled entry (`if (fs.existsSync(distEntry)) require(distEntry)`), and dist/src/cli/human.js is a stale 2026-10-22 build whose statusCommand (dist/src/cli/human.js:1022-1038) is the ORIGINAL buggy version (`const { flags } = parseArgs(args); const namespace = flags.namespace || getDefaultNamespace(); const nsPath = config.namespaceMappings?.[namespace] || "./memory/default";`) with no normalizeStatusNamespaceFlags, no namespaceExplicit, and no unknown-namespace guard. The fix exists only in TypeScript source (src/cli/human.ts:1285-1350 plus normalizeStatusNamespaceFlags at :628-648) and was never rebuilt into dist/. Proof: moving dist/ aside so bin/duckbrain.js falls back to tsx/TS source yields "Error: Namespace 'dogfood1027' does not exist" exit 1 — the source fix is live but the shipped entry point never reaches it. Tests: `npx vitest run src/cli/status-namespace-df2026-9.test.ts` -> exit 0, "Tests 11 passed (11)"; `npx vitest run src/cli/` -> exit 0, "Tests 409 passed (409)". However these tests are a false green for this criterion: src/cli/status-namespace-df2026-9.test.ts:41 imports `runHumanCLI` from "./human" (TS source) and calls it in-process, never spawning bin/duckbrain.js nor touching dist/, so the regression tests do not cover the entry point the criterion names. Missing: rebuild dist/ (pnpm build:cli) and/or add an end-to-end test that spawns bin/duckbrain.js.
The source-level fix and its 11 unit tests are correct, but the fix was never compiled into dist/, so the shipped `node bin/duckbrain.js status --namespace dogfood1027` still prints "Namespace: true" and unknown/missing namespaces still exit 0 — the criterion's literal command fails.

Overall: FAIL ✗
