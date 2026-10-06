# Verdict: DF-0926-03

**Task:** Fix ?contains= FTS stopword misses
**Evaluated:** 2026-09-29T06:43:32.321688
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v5.0.1 /home/kara/duckbrain
- ✓ **tier2**
  - COMPLETE
  ✓ contains=<stopword like Hello/from/different> returns rows whose content contains that word; regression test RED-GREEN; full suite+tsc+prettier green; scratch-daemon live proof: Implementation: src/search/query.ts adds opt-in includeStopwordLiterals raw-text word-boundary pass (regexp_matches on raw_text) for stopword-only queries; src/mcp/tools/recall.ts:605,623 enables it on both contains= call sites; HTTP route src/http/routes/memories.ts:485 forwards ?contains= to recallTool. (1) LIVE scratch-daemon proof: started `node bin/duckbrain.js http --port 3999` with DUCKBRAIN_NAMESPACES_PATH=/tmp/df092603-live, wrote board fixtures 'Hello from HTTP API' + 'zebra', rebuilt index (rowCount 2), then curl: contains=Hello -> 1 hit (content 'Hello from HTTP API'), contains=hello -> 1 (case-insensitive), contains=from -> 1, contains=zebra -> 1; after adding 'a different approach entirely', contains=different -> 1 hit; contains=different with no matching row -> 0 (no false positives). (2) RED-GREEN: `npx vitest run src/search/search-stopword-contains-df092603.test.ts` -> 'Test Files 1 passed (1), Tests 6 passed (6)'; reverting query.ts+recall.ts to 5899b4a^ -> 'Tests 3 failed | 3 passed (6)' with AssertionError 'expected 0 to be greater than or equal to 1' on contains=Hello/from/recallTool; restored -> 6 passed. (3) Full suite: `npx vitest run` -> 'Test Files 183 passed (183), Tests 1458 passed (1458)', 0 failures. (4) tsc: `npx tsc --noEmit` -> exit 0, no output. (5) prettier: `npx prettier --check src/search/query.ts src/mcp/tools/recall.ts src/search/search-stopword-contains-df092603.test.ts` -> 'All matched files use Prettier code style!' exit 0.
The ?contains= stopword fix is implemented and fully verified: live scratch-daemon probes return rows for Hello/from/different, the regression test is RED-GREEN, and the full suite (1458 tests), tsc, and prettier are all green.

## Summary

Judge Result: DF-0926-03

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v5.0.1 /home/kara/duckbrain

Stage tier2: PASS
  COMPLETE
  ✓ contains=<stopword like Hello/from/different> returns rows whose content contains that word; regression test RED-GREEN; full suite+tsc+prettier green; scratch-daemon live proof: Implementation: src/search/query.ts adds opt-in includeStopwordLiterals raw-text word-boundary pass (regexp_matches on raw_text) for stopword-only queries; src/mcp/tools/recall.ts:605,623 enables it on both contains= call sites; HTTP route src/http/routes/memories.ts:485 forwards ?contains= to recallTool. (1) LIVE scratch-daemon proof: started `node bin/duckbrain.js http --port 3999` with DUCKBRAIN_NAMESPACES_PATH=/tmp/df092603-live, wrote board fixtures 'Hello from HTTP API' + 'zebra', rebuilt index (rowCount 2), then curl: contains=Hello -> 1 hit (content 'Hello from HTTP API'), contains=hello -> 1 (case-insensitive), contains=from -> 1, contains=zebra -> 1; after adding 'a different approach entirely', contains=different -> 1 hit; contains=different with no matching row -> 0 (no false positives). (2) RED-GREEN: `npx vitest run src/search/search-stopword-contains-df092603.test.ts` -> 'Test Files 1 passed (1), Tests 6 passed (6)'; reverting query.ts+recall.ts to 5899b4a^ -> 'Tests 3 failed | 3 passed (6)' with AssertionError 'expected 0 to be greater than or equal to 1' on contains=Hello/from/recallTool; restored -> 6 passed. (3) Full suite: `npx vitest run` -> 'Test Files 183 passed (183), Tests 1458 passed (1458)', 0 failures. (4) tsc: `npx tsc --noEmit` -> exit 0, no output. (5) prettier: `npx prettier --check src/search/query.ts src/mcp/tools/recall.ts src/search/search-stopword-contains-df092603.test.ts` -> 'All matched files use Prettier code style!' exit 0.
The ?contains= stopword fix is implemented and fully verified: live scratch-daemon probes return rows for Hello/from/different, the regression test is RED-GREEN, and the full suite (1458 tests), tsc, and prettier are all green.

Overall: PASS ✓
