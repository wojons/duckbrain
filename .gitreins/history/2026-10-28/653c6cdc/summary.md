# Verdict: DB-GAP-065

**Task:** duckbrain namespaces prune + drift guard
**Evaluated:** 2026-10-28T09:51:30.160931
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✗ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✓ AC-1..AC-6 in brief: prune CLI with --dry-run default + --apply, idempotent crash-safe, path-safety reuse, tests, drift guard on GET /api/namespaces, evidence reported: All sub-ACs verified. (1) CLI verb: src/cli/human.ts:1071-1081 dispatches `prune` with `const dryRun = flags["dry-run"] !== undefined || flags.apply === undefined;` (dry-run default, --dry-run wins), help text at human.ts:974-977; report/exit-code logic in src/cli/namespaces-prune.ts:52-120 (exit 0 clean, 1 refused, 2 aborted). (2) Core: src/namespaces/prune.ts planNamespacePrune() (pure read, dead = resolved path missing) and applyNamespacePrune() — no write when dead set empty (prune.ts:158-168), single stamped fsynced write via updateConfig({expectedStamp, fsync:true}) (prune.ts:196-200; src/config/index.ts:816-850 tmp+fsync+rename + stamp guard), defensive removal-set check, manifests pruned only after config write (prune.ts:203-210). (3) Path-safety reuse: src/namespaces/delete.ts:76 exports checkNamespacePathSafety(), used by both deleteNamespace (delete.ts:153) and prune (prune.ts:112). (4) Drift guard: src/http/routes/namespaces.ts:144-190 emits driftWarning {deadCount, liveCount, hint:"run 'duckbrain namespaces prune --apply'"} when deadCount>=25 OR deadCount>2*liveCount, omitted when clean; typed at src/http/types/api.ts:324. (5) Tests: `npx vitest run src/cli/namespaces-prune-dbgap065.test.ts src/http/routes/namespaces-drift-warning-dbgap065.test.ts` -> exit 0, 'Test Files 2 passed (2) / Tests 13 passed (13)'; full suite `npx vitest run --reporter=dot` -> 'Test Files 237 passed (237) / Tests 1973 passed (1973)'; `npx tsc --noEmit` rc=0. Tests cover dry-run byte-identical config, real CLI dispatch, exact removal set + manifest pruning, second-run no-op, concurrent-writer abort, write-failure atomicity, refusal of escaping paths, and drift thresholds (24/25 dead, 2x boundary). (6) Evidence: docs/evidence/DB-GAP-065-evidence.md with live CLI/HTTP probes, gate table, registry baseline, traceability; docs updated at docs/guide/cli-reference.md:306, docs/api/http-api.md:759, CHANGELOG.md:11.
Prune CLI (dry-run default/--apply), idempotent crash-safe atomic apply, shared path-safety guard, drift guard on GET /api/namespaces, 13 targeted + 1973 full-suite tests passing, and an evidence artifact are all present and verified.

## Summary

Judge Result: DB-GAP-065

Stage tier1: FAIL
    ✗ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✓ AC-1..AC-6 in brief: prune CLI with --dry-run default + --apply, idempotent crash-safe, path-safety reuse, tests, drift guard on GET /api/namespaces, evidence reported: All sub-ACs verified. (1) CLI verb: src/cli/human.ts:1071-1081 dispatches `prune` with `const dryRun = flags["dry-run"] !== undefined || flags.apply === undefined;` (dry-run default, --dry-run wins), help text at human.ts:974-977; report/exit-code logic in src/cli/namespaces-prune.ts:52-120 (exit 0 clean, 1 refused, 2 aborted). (2) Core: src/namespaces/prune.ts planNamespacePrune() (pure read, dead = resolved path missing) and applyNamespacePrune() — no write when dead set empty (prune.ts:158-168), single stamped fsynced write via updateConfig({expectedStamp, fsync:true}) (prune.ts:196-200; src/config/index.ts:816-850 tmp+fsync+rename + stamp guard), defensive removal-set check, manifests pruned only after config write (prune.ts:203-210). (3) Path-safety reuse: src/namespaces/delete.ts:76 exports checkNamespacePathSafety(), used by both deleteNamespace (delete.ts:153) and prune (prune.ts:112). (4) Drift guard: src/http/routes/namespaces.ts:144-190 emits driftWarning {deadCount, liveCount, hint:"run 'duckbrain namespaces prune --apply'"} when deadCount>=25 OR deadCount>2*liveCount, omitted when clean; typed at src/http/types/api.ts:324. (5) Tests: `npx vitest run src/cli/namespaces-prune-dbgap065.test.ts src/http/routes/namespaces-drift-warning-dbgap065.test.ts` -> exit 0, 'Test Files 2 passed (2) / Tests 13 passed (13)'; full suite `npx vitest run --reporter=dot` -> 'Test Files 237 passed (237) / Tests 1973 passed (1973)'; `npx tsc --noEmit` rc=0. Tests cover dry-run byte-identical config, real CLI dispatch, exact removal set + manifest pruning, second-run no-op, concurrent-writer abort, write-failure atomicity, refusal of escaping paths, and drift thresholds (24/25 dead, 2x boundary). (6) Evidence: docs/evidence/DB-GAP-065-evidence.md with live CLI/HTTP probes, gate table, registry baseline, traceability; docs updated at docs/guide/cli-reference.md:306, docs/api/http-api.md:759, CHANGELOG.md:11.
Prune CLI (dry-run default/--apply), idempotent crash-safe atomic apply, shared path-safety guard, drift guard on GET /api/namespaces, 13 targeted + 1973 full-suite tests passing, and an evidence artifact are all present and verified.

Overall: FAIL ✗
