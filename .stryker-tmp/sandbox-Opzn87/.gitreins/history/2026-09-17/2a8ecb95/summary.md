# Verdict: DB-GAP-045

**Task:** Same-key concurrent write survivorship: declare multi-version semantics + pin with ACK-fidelity hermetic test
**Evaluated:** 2026-09-17T09:54:25.294788
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: [90m4:51AM[0m [32mINF[0m [1mscanned ~9587931 bytes (9.59 MB) in 1.53s[0m
[90m4:51AM[0m [32m
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  145 passed (145)
      Tests  1153 passed (1153)

- ✓ **tier2**
  - COMPLETE
  ✓ AC1 spec section in docs/specs/SUPA-2-serialization.md declaring multi-version (NOT last-write-wins) + timestamp DESC,id ASC ordering contract with same-millisecond caveat + seq non-durability citing changeRecord.ts: docs/specs/SUPA-2-serialization.md:79-88 — new section 'Same-key survivorship and version ordering': 'Same-key writes are **append-only multi-version**, never last-write-wins' (line 81); ordering contract 'retrieval orders versions by `timestamp DESC, id ASC` (`src/duckdb/queries.ts:301`, `DEFAULT_ORDER_BY`)' (line 83, verified live: queries.ts:301-302 `ORDER BY try_cast(timestamp AS TIMESTAMP) DESC NULLS LAST, id ASC`); same-millisecond caveat 'deterministic for a given dataset ... but is **explicitly NOT write order**' (line 83); seq non-durability citing '`src/serialization/changeRecord.ts:55-56` — "Internal process-local serializer sequence — never a cursor"' (line 83, verified live at changeRecord.ts:55-56); plus AC-11/AC-12 (lines 87-88).
  ✓ AC2 docs/api/http-api.md documents persisted-timestamp 201 semantics + multi-version rule: docs/api/http-api.md:319-331 — 'Note — same-key multi-version (SUPA-2 / DB-GAP-045): same-key writes are **append-only multi-version**, never last-write-wins ... Versions are ordered `timestamp DESC, id ASC` ... The process-local serializer `seq` is not durable and is not a cursor.' docs/api/http-api.md:457-463 — 'Note — write timestamp (DB-GAP-045): the 201 body's `timestamp` is the **persisted write timestamp of the stored version** — the exact value on the JSONL row for the returned `id` — not a response-time stamp.'
  ✓ AC3 rememberTool exposes optional timestamp and POST /api/memories echoes it (fallback retained): src/mcp/tools/remember.ts:90-93 — `timestamp?: string;` added to RememberOutput with DB-GAP-045 doc comment; remember.ts:248-250 — success response sets `timestamp: memory.timestamp`. src/http/routes/memories.ts:558 — `timestamp: result.timestamp ?? new Date().toISOString(),` (persisted value echoed, response-time stamp retained as fallback).
  ✓ AC4 new suite src/http/memories-same-key-dbgap045.test.ts asserts 4 distinct concurrent ACKs, ACK id+timestamp == stored version, 4 retrievable versions, identical order across repeated list calls, and was proven RED on the ACK-timestamp assertion against pre-fix code: src/http/memories-same-key-dbgap045.test.ts (299 lines, hermetic scratch daemon on free port + temp data dir): 4 concurrent POSTs all 201 with distinct ids (lines 262-268, `expect(new Set(ids).size).toBe(CONCURRENCY)`); ACK id+timestamp == stored version (lines 270-279, `expect(stored!.timestamp).toBe(ack.body.timestamp)`); exactly 4 non-tombstone versions (lines 281-287, `expect(items).toHaveLength(CONCURRENCY)` + isTombstone false + total 4); identical order across repeated list calls (lines 289-296). RED-proof independently reproduced: I reverted memories.ts:558 to `timestamp: new Date().toISOString()` and re-ran — FAIL at test line 278 'AssertionError: expected '2026-09-17T09:52:42.439Z' to be '2026-09-17T09:52:42.497Z''; restored the fix and the suite passes (1 passed).
  ✓ AC5 tsc --noEmit clean, prettier --check src/ clean, vitest run green: `npx tsc --noEmit` → exit 0, no output. `npx prettier --check src/` → 'All matched files use Prettier code style!', exit 0. `npx vitest run` (full suite, fresh) → 'Test Files 145 passed (145)' / 'Tests 1153 passed (1153)', no FAIL lines; the new suite alone: 'Test Files 1 passed (1) / Tests 1 passed (1)'.
All five ACs verified with hard evidence: spec + API docs declare append-only multi-version semantics with the timestamp DESC,id ASC contract and seq non-durability, the tool/route echo the persisted timestamp with fallback retained, the new hermetic suite pins all four assertions and was independently reproduced RED on the ACK-timestamp assertion against pre-fix code, and tsc/prettier/vitest (145 files, 1153 tests) are all green.

## Summary

Judge Result: DB-GAP-045

Stage tier1: PASS
    ✓ secrets: [90m4:51AM[0m [32mINF[0m [1mscanned ~9587931 bytes (9.59 MB) in 1.53s[0m
[90m4:51AM[0m [32m
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  145 passed (145)
      Tests  1153 passed (1153)


Stage tier2: PASS
  COMPLETE
  ✓ AC1 spec section in docs/specs/SUPA-2-serialization.md declaring multi-version (NOT last-write-wins) + timestamp DESC,id ASC ordering contract with same-millisecond caveat + seq non-durability citing changeRecord.ts: docs/specs/SUPA-2-serialization.md:79-88 — new section 'Same-key survivorship and version ordering': 'Same-key writes are **append-only multi-version**, never last-write-wins' (line 81); ordering contract 'retrieval orders versions by `timestamp DESC, id ASC` (`src/duckdb/queries.ts:301`, `DEFAULT_ORDER_BY`)' (line 83, verified live: queries.ts:301-302 `ORDER BY try_cast(timestamp AS TIMESTAMP) DESC NULLS LAST, id ASC`); same-millisecond caveat 'deterministic for a given dataset ... but is **explicitly NOT write order**' (line 83); seq non-durability citing '`src/serialization/changeRecord.ts:55-56` — "Internal process-local serializer sequence — never a cursor"' (line 83, verified live at changeRecord.ts:55-56); plus AC-11/AC-12 (lines 87-88).
  ✓ AC2 docs/api/http-api.md documents persisted-timestamp 201 semantics + multi-version rule: docs/api/http-api.md:319-331 — 'Note — same-key multi-version (SUPA-2 / DB-GAP-045): same-key writes are **append-only multi-version**, never last-write-wins ... Versions are ordered `timestamp DESC, id ASC` ... The process-local serializer `seq` is not durable and is not a cursor.' docs/api/http-api.md:457-463 — 'Note — write timestamp (DB-GAP-045): the 201 body's `timestamp` is the **persisted write timestamp of the stored version** — the exact value on the JSONL row for the returned `id` — not a response-time stamp.'
  ✓ AC3 rememberTool exposes optional timestamp and POST /api/memories echoes it (fallback retained): src/mcp/tools/remember.ts:90-93 — `timestamp?: string;` added to RememberOutput with DB-GAP-045 doc comment; remember.ts:248-250 — success response sets `timestamp: memory.timestamp`. src/http/routes/memories.ts:558 — `timestamp: result.timestamp ?? new Date().toISOString(),` (persisted value echoed, response-time stamp retained as fallback).
  ✓ AC4 new suite src/http/memories-same-key-dbgap045.test.ts asserts 4 distinct concurrent ACKs, ACK id+timestamp == stored version, 4 retrievable versions, identical order across repeated list calls, and was proven RED on the ACK-timestamp assertion against pre-fix code: src/http/memories-same-key-dbgap045.test.ts (299 lines, hermetic scratch daemon on free port + temp data dir): 4 concurrent POSTs all 201 with distinct ids (lines 262-268, `expect(new Set(ids).size).toBe(CONCURRENCY)`); ACK id+timestamp == stored version (lines 270-279, `expect(stored!.timestamp).toBe(ack.body.timestamp)`); exactly 4 non-tombstone versions (lines 281-287, `expect(items).toHaveLength(CONCURRENCY)` + isTombstone false + total 4); identical order across repeated list calls (lines 289-296). RED-proof independently reproduced: I reverted memories.ts:558 to `timestamp: new Date().toISOString()` and re-ran — FAIL at test line 278 'AssertionError: expected '2026-09-17T09:52:42.439Z' to be '2026-09-17T09:52:42.497Z''; restored the fix and the suite passes (1 passed).
  ✓ AC5 tsc --noEmit clean, prettier --check src/ clean, vitest run green: `npx tsc --noEmit` → exit 0, no output. `npx prettier --check src/` → 'All matched files use Prettier code style!', exit 0. `npx vitest run` (full suite, fresh) → 'Test Files 145 passed (145)' / 'Tests 1153 passed (1153)', no FAIL lines; the new suite alone: 'Test Files 1 passed (1) / Tests 1 passed (1)'.
All five ACs verified with hard evidence: spec + API docs declare append-only multi-version semantics with the timestamp DESC,id ASC contract and seq non-durability, the tool/route echo the persisted timestamp with fallback retained, the new hermetic suite pins all four assertions and was independently reproduced RED on the ACK-timestamp assertion against pre-fix code, and tsc/prettier/vitest (145 files, 1153 tests) are all green.

Overall: PASS ✓
