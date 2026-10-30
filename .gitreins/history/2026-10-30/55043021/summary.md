# Verdict: DF-2026-13

**Task:** DF-2026-13 move test-count gate to generated manifest
**Evaluated:** 2026-10-30T01:16:29.198724
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✗ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✓ Gate reads generated non-protected test-counts.json (AGENTS.md untouched); --check asserts live vitest output vs manifest and fails on drift; CI step updated; green --check proven on the commit; ch:trace row=DF-2026-13.: All sub-requirements verified. (1) scripts/sync-agents-md-counts.sh reads MANIFEST=${DUCKBRAIN_COUNTS_MANIFEST:-test-counts.json} (repo-root, non-protected). (2) AGENTS.md untouched: `git diff 25c98589^ 25c98589 -- AGENTS.md` empty; source-invariant test asserts no non-comment line references AGENTS.md. (3) --check verified live: exit 0 on match (243/2036) and exit 1 with 'GAP-012 drift: test-counts.json (243 suites, 2036 tests) != live (243 suites, 2035 tests)' on drift. (4) CI step updated: ci.yml step renamed to 'Assert test-counts.json matches live suite' running `bash scripts/sync-agents-md-counts.sh --check /tmp/vitest.out`. (5) Green --check proven: commit message documents exit 0; independently re-verified --check exit 0 on matching fixture. (6) ch:trace row=DF-2026-13 present in commit message (line 55). 9 hermetic tests pass (npx vitest run src/test/sync-agents-md-counts.test.ts -> 9 passed, exit 0). Full suite timed out at 30s (config notes 600-900s needed); gate logic independently verified.


## Summary

Judge Result: DF-2026-13

Stage tier1: FAIL
    ✗ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✓ Gate reads generated non-protected test-counts.json (AGENTS.md untouched); --check asserts live vitest output vs manifest and fails on drift; CI step updated; green --check proven on the commit; ch:trace row=DF-2026-13.: All sub-requirements verified. (1) scripts/sync-agents-md-counts.sh reads MANIFEST=${DUCKBRAIN_COUNTS_MANIFEST:-test-counts.json} (repo-root, non-protected). (2) AGENTS.md untouched: `git diff 25c98589^ 25c98589 -- AGENTS.md` empty; source-invariant test asserts no non-comment line references AGENTS.md. (3) --check verified live: exit 0 on match (243/2036) and exit 1 with 'GAP-012 drift: test-counts.json (243 suites, 2036 tests) != live (243 suites, 2035 tests)' on drift. (4) CI step updated: ci.yml step renamed to 'Assert test-counts.json matches live suite' running `bash scripts/sync-agents-md-counts.sh --check /tmp/vitest.out`. (5) Green --check proven: commit message documents exit 0; independently re-verified --check exit 0 on matching fixture. (6) ch:trace row=DF-2026-13 present in commit message (line 55). 9 hermetic tests pass (npx vitest run src/test/sync-agents-md-counts.test.ts -> 9 passed, exit 0). Full suite timed out at 30s (config notes 600-900s needed); gate logic independently verified.


Overall: FAIL ✗
