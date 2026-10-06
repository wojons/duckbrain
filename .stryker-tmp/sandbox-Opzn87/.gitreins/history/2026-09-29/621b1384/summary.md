# Verdict: PERF-002

**Task:** PERF-002 — fuse recall double read_json scan into one query
**Evaluated:** 2026-09-29T12:22:42.956747
**Result:** ✗ FAIL

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v5.0.1 /home/kara/duckbrain
- ✗ **tier2**
  - INCOMPLETE
  ✗ Fused queryMemoriesWithTotal is the live recall path; live daemon coding-hermes limit=5 warm <3.0s; total/empty-page semantics verified: Two of three conjuncts fail. (1) NOT the live path: the fused fn exists in source (src/duckdb/queries.ts:673, called at src/mcp/tools/recall.ts:998,1010) but the live daemon PID 294709 started 'Mon Sep 28 00:51:06 2026', BEFORE the PERF-003 fusion commit 0b5be05 (2026-09-29 03:37:27). The dist build it serves has NO queryMemoriesWithTotal export (grep count 0 in dist/src/duckdb/queries.js; only exports.queryMemories:18 and exports.countMemories:19) and its list path dist/src/mcp/tools/recall.js:827,835 still calls countMemories back-to-back (old two-scan); dist mtime 2026-09-28 11:53. (2) Warm latency FAILS <3.0s: curl localhost:3000/api/memories?namespace=coding-hermes&limit=5 (X-API-Key auth) gave warmup 3.787s and warm runs 3.436, 3.092, 3.028, 3.020, 2.765, 2.978, 3.013, 3.825, 2.795, 2.797, 5.806, 5.280s — many exceed 3.0s (up to 5.8s). (3) total/empty-page semantics DO pass: limit=5 -> count=240644/total=240644/5 rows; offset=999999 -> count=240645/total=240645/0 rows (true total carried on empty page). Fused unit test src/duckdb/queries-fused-total-perf003.test.ts passes 6/6 (npx vitest run, exit 0), but that only proves the source, not the live daemon path. The task's only change was a bookkeeping entry in .gitreins/tasks.yaml; no code was changed to make the fused query the live path or to meet the latency bar.
The fused queryMemoriesWithTotal exists in source and its unit tests pass, but the live daemon runs a stale pre-fusion dist build (still doing the double countMemories scan) and warm coding-hermes limit=5 latency exceeds 3.0s, so the criterion fails.

## Summary

Judge Result: PERF-002

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v5.0.1 /home/kara/duckbrain

Stage tier2: FAIL
  INCOMPLETE
  ✗ Fused queryMemoriesWithTotal is the live recall path; live daemon coding-hermes limit=5 warm <3.0s; total/empty-page semantics verified: Two of three conjuncts fail. (1) NOT the live path: the fused fn exists in source (src/duckdb/queries.ts:673, called at src/mcp/tools/recall.ts:998,1010) but the live daemon PID 294709 started 'Mon Sep 28 00:51:06 2026', BEFORE the PERF-003 fusion commit 0b5be05 (2026-09-29 03:37:27). The dist build it serves has NO queryMemoriesWithTotal export (grep count 0 in dist/src/duckdb/queries.js; only exports.queryMemories:18 and exports.countMemories:19) and its list path dist/src/mcp/tools/recall.js:827,835 still calls countMemories back-to-back (old two-scan); dist mtime 2026-09-28 11:53. (2) Warm latency FAILS <3.0s: curl localhost:3000/api/memories?namespace=coding-hermes&limit=5 (X-API-Key auth) gave warmup 3.787s and warm runs 3.436, 3.092, 3.028, 3.020, 2.765, 2.978, 3.013, 3.825, 2.795, 2.797, 5.806, 5.280s — many exceed 3.0s (up to 5.8s). (3) total/empty-page semantics DO pass: limit=5 -> count=240644/total=240644/5 rows; offset=999999 -> count=240645/total=240645/0 rows (true total carried on empty page). Fused unit test src/duckdb/queries-fused-total-perf003.test.ts passes 6/6 (npx vitest run, exit 0), but that only proves the source, not the live daemon path. The task's only change was a bookkeeping entry in .gitreins/tasks.yaml; no code was changed to make the fused query the live path or to meet the latency bar.
The fused queryMemoriesWithTotal exists in source and its unit tests pass, but the live daemon runs a stale pre-fusion dist build (still doing the double countMemories scan) and warm coding-hermes limit=5 latency exceeds 3.0s, so the criterion fails.

Overall: FAIL ✗
