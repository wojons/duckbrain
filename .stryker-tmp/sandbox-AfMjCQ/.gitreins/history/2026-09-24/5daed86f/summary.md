# Verdict: CI-005

**Task:** CI red recurrence: AGENTS.md test-count assertion fails on every run - derive counts via sync script instead of hand-typed literals
**Evaluated:** 2026-09-24T13:37:37.664356
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v5.0.1 /home/kara/duckbrain
- ✓ **tier2**
  - COMPLETE
  ✓ CI step 'Assert AGENTS.md test counts match live suite' passes: counts in AGENTS.md equal live vitest totals, extracted by a single shared script (scripts/sync-agents-md-counts.sh) used by both the sync and the CI check mode; script is idempotent and fails loudly on unparseable output: Ran the real suite: `npx vitest run` produced ' Test Files  167 passed (167)' / '      Tests  1332 passed (1332)' (corroborated by `find src -name '*.test.ts' | wc -l` == 167 and vitest's '167 workers spawned'). AGENTS.md:14 '(167 suites, 1332 tests)' and AGENTS.md:33 '# 1332 tests, 167 suites' match exactly. Executed the CI step verbatim: `bash scripts/sync-agents-md-counts.sh --check /tmp/vitest2.out` -> 'AGENTS.md test counts match live suite (167 suites, 1332 tests)', exit 0. Single shared script: scripts/sync-agents-md-counts.sh (68 lines, mode 100755) holds the only extraction (strip_ansi + grep -oP for 'Test Files ... (N)' and 'Tests ... (N)'); ci.yml:69-70 now just calls `bash scripts/sync-agents-md-counts.sh --check /tmp/vitest.out`, and grep for 'Test Files|grep -oP|suites' in ci.yml returns NONE (no leftover inline duplication). Script serves both modes (default sync, --check). Idempotent: two consecutive sync runs on matching input left md5 34496cfd0551d3f39c7c749ea39e01c1 unchanged, printing 'no change (idempotent)', exit 0. Fails loudly: garbage input -> 'GAP-032: vitest summary unparseable in /tmp/bad.out' exit 1; missing file -> 'GAP-032: vitest output not found' exit 1; drift (999/888) -> 'GAP-012 drift' exit 1. `bash -n` syntax OK. [resolution 0.00; AGENTS.md, scripts/sync-agents-md-counts.sh]
The CI assertion passes against real live vitest totals (167 suites / 1332 tests) matching AGENTS.md, via a single shared script that is idempotent and fails loudly on unparseable output.

## Summary

Judge Result: CI-005

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v5.0.1 /home/kara/duckbrain

Stage tier2: PASS
  COMPLETE
  ✓ CI step 'Assert AGENTS.md test counts match live suite' passes: counts in AGENTS.md equal live vitest totals, extracted by a single shared script (scripts/sync-agents-md-counts.sh) used by both the sync and the CI check mode; script is idempotent and fails loudly on unparseable output: Ran the real suite: `npx vitest run` produced ' Test Files  167 passed (167)' / '      Tests  1332 passed (1332)' (corroborated by `find src -name '*.test.ts' | wc -l` == 167 and vitest's '167 workers spawned'). AGENTS.md:14 '(167 suites, 1332 tests)' and AGENTS.md:33 '# 1332 tests, 167 suites' match exactly. Executed the CI step verbatim: `bash scripts/sync-agents-md-counts.sh --check /tmp/vitest2.out` -> 'AGENTS.md test counts match live suite (167 suites, 1332 tests)', exit 0. Single shared script: scripts/sync-agents-md-counts.sh (68 lines, mode 100755) holds the only extraction (strip_ansi + grep -oP for 'Test Files ... (N)' and 'Tests ... (N)'); ci.yml:69-70 now just calls `bash scripts/sync-agents-md-counts.sh --check /tmp/vitest.out`, and grep for 'Test Files|grep -oP|suites' in ci.yml returns NONE (no leftover inline duplication). Script serves both modes (default sync, --check). Idempotent: two consecutive sync runs on matching input left md5 34496cfd0551d3f39c7c749ea39e01c1 unchanged, printing 'no change (idempotent)', exit 0. Fails loudly: garbage input -> 'GAP-032: vitest summary unparseable in /tmp/bad.out' exit 1; missing file -> 'GAP-032: vitest output not found' exit 1; drift (999/888) -> 'GAP-012 drift' exit 1. `bash -n` syntax OK. [resolution 0.00; AGENTS.md, scripts/sync-agents-md-counts.sh]
The CI assertion passes against real live vitest totals (167 suites / 1332 tests) matching AGENTS.md, via a single shared script that is idempotent and fails loudly on unparseable output.

Overall: PASS ✓
