# Verdict: DB-SUPA-2

**Task:** Serialization layer: route table PATCH/DELETE through NamespaceWriter
**Evaluated:** 2026-10-17T20:18:17.259617
**Result:** ✗ FAIL

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✗ **tier2**
  - INCOMPLETE
  ✗ AC1: Every declared-table mutation (POST/PATCH/DELETE) goes through the namespace single-writer/fencing path.
AC2: For update/delete, append accepted audit/change records and tombstone semantics before acknowledging; change feed remains valid after mutation.
AC3: Add a concurrent cross-process writer test proving no lost updates, plus a post-delete audit/SSE replay test.: AC1 partially met: POST for schema.json tables uses writer.enqueue (src/http/routes/tables.ts:846-880); PATCH takes acquireNamespaceWriteLockWaiting then awaits recordTableMutationAudit -> getNamespaceWriter(ns).enqueueAudit before res.json (tables.ts:1037-1095); DELETE likewise (tables.ts:1130-1175). However legacy .table.json tables bypass the writer entirely (direct appendRowsToTable / patchRowsByPk / deleteRowsByPk, tables.ts:884-886, 1085-1095, 1160-1175), so not EVERY declared-table mutation is routed through the single-writer path. AC2 FAILS: the audit row built in recordTableMutationAudit (tables.ts:958-980) is deliberately marker-less — the code comment at tables.ts:938-957 states targetPath/contentHash/key/tombstone/schemaVersion are intentionally NOT emitted, so no tombstone semantics and no change record exist for update/delete; isChangeRecordCandidate (src/serialization/changeRecord.ts:87-95) returns false for these rows and replay skips them (src/http/realtime/replay.ts: 'if (!isChangeRecordCandidate(entry)) continue'), so the change feed carries no update/delete event at all. AC3 FAILS: the only 'concurrent cross-process' test is src/http/routes/tables-supa2.test.ts:423-455, whose single case is 'two sequential PATCHes via same writer → deterministic final state' — sequential, in-process, no child process/spawn, no concurrency, no lost-update assertion. No post-delete audit/SSE replay test exists: the SSE tests (tables-supa2.test.ts:270-290, 396-420) only assert status != 500 / no 'CHANGELOG_CORRUPT' substring and run against the legacy namespace that writes no audit rows; nothing replays the change feed after a delete. Test run evidence: `npx vitest run src/http/routes/tables-supa2.test.ts` -> exit_code 0, 'Test Files 1 passed (1) / Tests 9 passed (9)', but those 9 tests do not exercise cross-process concurrency or post-delete replay.
PATCH/DELETE do append an awaited audit row through NamespaceWriter, but legacy tables bypass the writer, no tombstone/change-record markers are emitted (replay skips them), and the 'concurrent cross-process' test is a sequential in-process test with no post-delete replay coverage.

## Summary

Judge Result: DB-SUPA-2

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: FAIL
  INCOMPLETE
  ✗ AC1: Every declared-table mutation (POST/PATCH/DELETE) goes through the namespace single-writer/fencing path.
AC2: For update/delete, append accepted audit/change records and tombstone semantics before acknowledging; change feed remains valid after mutation.
AC3: Add a concurrent cross-process writer test proving no lost updates, plus a post-delete audit/SSE replay test.: AC1 partially met: POST for schema.json tables uses writer.enqueue (src/http/routes/tables.ts:846-880); PATCH takes acquireNamespaceWriteLockWaiting then awaits recordTableMutationAudit -> getNamespaceWriter(ns).enqueueAudit before res.json (tables.ts:1037-1095); DELETE likewise (tables.ts:1130-1175). However legacy .table.json tables bypass the writer entirely (direct appendRowsToTable / patchRowsByPk / deleteRowsByPk, tables.ts:884-886, 1085-1095, 1160-1175), so not EVERY declared-table mutation is routed through the single-writer path. AC2 FAILS: the audit row built in recordTableMutationAudit (tables.ts:958-980) is deliberately marker-less — the code comment at tables.ts:938-957 states targetPath/contentHash/key/tombstone/schemaVersion are intentionally NOT emitted, so no tombstone semantics and no change record exist for update/delete; isChangeRecordCandidate (src/serialization/changeRecord.ts:87-95) returns false for these rows and replay skips them (src/http/realtime/replay.ts: 'if (!isChangeRecordCandidate(entry)) continue'), so the change feed carries no update/delete event at all. AC3 FAILS: the only 'concurrent cross-process' test is src/http/routes/tables-supa2.test.ts:423-455, whose single case is 'two sequential PATCHes via same writer → deterministic final state' — sequential, in-process, no child process/spawn, no concurrency, no lost-update assertion. No post-delete audit/SSE replay test exists: the SSE tests (tables-supa2.test.ts:270-290, 396-420) only assert status != 500 / no 'CHANGELOG_CORRUPT' substring and run against the legacy namespace that writes no audit rows; nothing replays the change feed after a delete. Test run evidence: `npx vitest run src/http/routes/tables-supa2.test.ts` -> exit_code 0, 'Test Files 1 passed (1) / Tests 9 passed (9)', but those 9 tests do not exercise cross-process concurrency or post-delete replay.
PATCH/DELETE do append an awaited audit row through NamespaceWriter, but legacy tables bypass the writer, no tombstone/change-record markers are emitted (replay skips them), and the 'concurrent cross-process' test is a sequential in-process test with no post-delete replay coverage.

Overall: FAIL ✗
