# Verdict: DB-SUPA-2

**Task:** SUPA serialization layer
**Evaluated:** 2026-09-11T01:47:22.975613
**Result:** ✗ FAIL

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: [90m8:41PM[0m [32mINF[0m [1mscanned ~7806884 bytes (7.81 MB) in 3.58s[0m
[90m8:41PM[0m [32m
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  110 passed (110)
      Tests  909 passed (909)
  
- ✗ **tier2**
  - INCOMPLETE
  ✗ Concurrent API writers across multiple namespaces produce zero torn/interleaved JSONL lines and zero lost acknowledged writes: Criterion 1 evidence:
- src/cli/http-serialization.test.ts:118-137 "acknowledges 32 concurrent writes across 4 namespaces with parseable, complete files": 32 concurrent HTTP POSTs across 4 namespaces, all 201, total data lines == 32 (no lost acked writes), each line JSON.parse'd (no torn lines).
- src/serialization/namespaceWriter.test.ts:207-258 "32 writers across 4 namespaces leave parseable files and no lost acknowledgements": acknowledged==32, rows==acknowledged, JSON.parse per line.
- src/serialization/namespaceWriter.test.ts:260-298 "acked fsync rows survive writer replacement and disk re-read": 8 fsync-mode writes, replay length 8, 8 unique ids.
- Run: `npx vitest run src/cli/http-serialization.test.ts src/serialization/` -> Test Files 6 passed (6), Tests 27 passed (27), exit 0.
- Full suite `npx vitest run` -> 110 files / 909 tests passed, exit 0.
- Mechanism: single in-process writer per ns (writers Map keyed root\0ns), enqueueMutex serializes seq assignment, flushOnce splices queue and sorts by seq, appends under cross-process lock.
  ✗ Writes are deterministically ordered per namespace through one writer with cross-process locking and dead-holder recovery: Criterion 2 evidence:
- src/serialization/lock.ts: acquireNamespaceWriteLock uses fs.openSync(lockPath,"wx",0o600) atomic create; shouldBreak() breaks on dead pid (isPidAlive) or age > LOCK_STALE_MS (10min) or corrupt+stale; tokenStillCurrent re-reads nonce; releaseNamespaceWriteLock only unlinks own token.
- src/serialization/namespaceWriter.ts: flushOnce acquires lock per batch, assertCurrent() fences on token change (isFenced=true, SERIALIZER_FENCED), releases in finally.
- src/serialization/lock.test.ts: 16 concurrent wx contenders -> exactly 1 winner; dead-pid break; young live-pid not broken; stale live-pid broken; corrupt busy until stale; tokenStillCurrent false after re-acquire.
- src/serialization/twowriter-kill9.test.ts: spawned child holds lock -> contender gets SERIALIZER_LOCKED and file unchanged; SIGKILL child -> dead-pid break, contender acked, file == ["/child/acked","/parent/acked"] (order preserved).
- src/serialization/namespaceWriter.test.ts: "assigns monotonic seq and flushes data in seq order" -> results seq 1,2,3 and file order [0,1,2].
- Run: `npx vitest run src/cli/http-serialization.test.ts src/serialization/` -> 6 files / 27 tests passed, exit 0.
  ✗ Role authorization happens before enqueue, durable modes write WAL before acknowledgement, and accepted writes retain audit evidence: Not verified — evaluation terminated before this criterion was checked
Partial verdict — evaluation hit resource cap before all criteria verified

## Summary

Judge Result: DB-SUPA-2

Stage tier1: PASS
    ✓ secrets: [90m8:41PM[0m [32mINF[0m [1mscanned ~7806884 bytes (7.81 MB) in 3.58s[0m
[90m8:41PM[0m [32m
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  110 passed (110)
      Tests  909 passed (909)
  

Stage tier2: FAIL
  INCOMPLETE
  ✗ Concurrent API writers across multiple namespaces produce zero torn/interleaved JSONL lines and zero lost acknowledged writes: Criterion 1 evidence:
- src/cli/http-serialization.test.ts:118-137 "acknowledges 32 concurrent writes across 4 namespaces with parseable, complete files": 32 concurrent HTTP POSTs across 4 namespaces, all 201, total data lines == 32 (no lost acked writes), each line JSON.parse'd (no torn lines).
- src/serialization/namespaceWriter.test.ts:207-258 "32 writers across 4 namespaces leave parseable files and no lost acknowledgements": acknowledged==32, rows==acknowledged, JSON.parse per line.
- src/serialization/namespaceWriter.test.ts:260-298 "acked fsync rows survive writer replacement and disk re-read": 8 fsync-mode writes, replay length 8, 8 unique ids.
- Run: `npx vitest run src/cli/http-serialization.test.ts src/serialization/` -> Test Files 6 passed (6), Tests 27 passed (27), exit 0.
- Full suite `npx vitest run` -> 110 files / 909 tests passed, exit 0.
- Mechanism: single in-process writer per ns (writers Map keyed root\0ns), enqueueMutex serializes seq assignment, flushOnce splices queue and sorts by seq, appends under cross-process lock.
  ✗ Writes are deterministically ordered per namespace through one writer with cross-process locking and dead-holder recovery: Criterion 2 evidence:
- src/serialization/lock.ts: acquireNamespaceWriteLock uses fs.openSync(lockPath,"wx",0o600) atomic create; shouldBreak() breaks on dead pid (isPidAlive) or age > LOCK_STALE_MS (10min) or corrupt+stale; tokenStillCurrent re-reads nonce; releaseNamespaceWriteLock only unlinks own token.
- src/serialization/namespaceWriter.ts: flushOnce acquires lock per batch, assertCurrent() fences on token change (isFenced=true, SERIALIZER_FENCED), releases in finally.
- src/serialization/lock.test.ts: 16 concurrent wx contenders -> exactly 1 winner; dead-pid break; young live-pid not broken; stale live-pid broken; corrupt busy until stale; tokenStillCurrent false after re-acquire.
- src/serialization/twowriter-kill9.test.ts: spawned child holds lock -> contender gets SERIALIZER_LOCKED and file unchanged; SIGKILL child -> dead-pid break, contender acked, file == ["/child/acked","/parent/acked"] (order preserved).
- src/serialization/namespaceWriter.test.ts: "assigns monotonic seq and flushes data in seq order" -> results seq 1,2,3 and file order [0,1,2].
- Run: `npx vitest run src/cli/http-serialization.test.ts src/serialization/` -> 6 files / 27 tests passed, exit 0.
  ✗ Role authorization happens before enqueue, durable modes write WAL before acknowledgement, and accepted writes retain audit evidence: Not verified — evaluation terminated before this criterion was checked
Partial verdict — evaluation hit resource cap before all criteria verified

Overall: FAIL ✗
