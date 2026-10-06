# Verdict: DF-0925-01

**Task:** Fix SSE replay ops filter
**Evaluated:** 2026-09-26T22:39:07.677777
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v5.0.1 /home/kara/duckbrain
- ✓ **tier2**
  - COMPLETE
  ✓ Replay with ops=delete returns only delete events and preserves existing live subscription filtering: Fix commit 8381dc8 modifies src/http/realtime/hub.ts: builds replayAllow from request.tables/request.ops (lines 269-272) and applies the shared predicate `if (!this.changeMatchesSubscriber(replayAllow, change)) continue;` in both replay loops (lines 285, 298); changeMatchesSubscriber (lines 655-666) checks tables.includes && ops.includes. Live filtering preserved: deliver() still calls changeMatchesSubscriber(subscriber, change) at line 677. Test src/http/routes/realtime-replay-filter.test.ts:98 'ops=delete replay drops the historical inserts' subscribes with ops=["delete"] and asserts opsOf(replayed)===['delete'] plus matching cursor; back-compat test asserts unfiltered replay unchanged. Fresh run: `npx vitest run src/http/routes/realtime-replay-filter.test.ts` exit_code 0, 'Test Files 1 passed (1) / Tests 4 passed (4)'; regression `npx vitest run realtime-replay.test.ts realtime-cursor.test.ts realtime-routes.test.ts realtime-fanout.test.ts realtime-wire.test.ts` exit_code 0, 'Test Files 5 passed (5) / Tests 15 passed (15)'.
SSE replay now applies the same ops/tables allow-list predicate as live fan-out, with ops=delete replay returning only delete events and all realtime tests passing.

## Summary

Judge Result: DF-0925-01

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v5.0.1 /home/kara/duckbrain

Stage tier2: PASS
  COMPLETE
  ✓ Replay with ops=delete returns only delete events and preserves existing live subscription filtering: Fix commit 8381dc8 modifies src/http/realtime/hub.ts: builds replayAllow from request.tables/request.ops (lines 269-272) and applies the shared predicate `if (!this.changeMatchesSubscriber(replayAllow, change)) continue;` in both replay loops (lines 285, 298); changeMatchesSubscriber (lines 655-666) checks tables.includes && ops.includes. Live filtering preserved: deliver() still calls changeMatchesSubscriber(subscriber, change) at line 677. Test src/http/routes/realtime-replay-filter.test.ts:98 'ops=delete replay drops the historical inserts' subscribes with ops=["delete"] and asserts opsOf(replayed)===['delete'] plus matching cursor; back-compat test asserts unfiltered replay unchanged. Fresh run: `npx vitest run src/http/routes/realtime-replay-filter.test.ts` exit_code 0, 'Test Files 1 passed (1) / Tests 4 passed (4)'; regression `npx vitest run realtime-replay.test.ts realtime-cursor.test.ts realtime-routes.test.ts realtime-fanout.test.ts realtime-wire.test.ts` exit_code 0, 'Test Files 5 passed (5) / Tests 15 passed (15)'.
SSE replay now applies the same ops/tables allow-list predicate as live fan-out, with ops=delete replay returning only delete events and all realtime tests passing.

Overall: PASS ✓
