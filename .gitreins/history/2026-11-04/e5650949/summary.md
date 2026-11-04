# Verdict: PERF-DUCKBRAIN-001

**Task:** Cut /api/memories list latency tail by bounding the file scan (PERF-DUCKBRAIN-001)
**Evaluated:** 2026-11-04T16:11:05.335599
**Result:** ✗ FAIL

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: scanners=gitleaks+builtin cross-check
  ✓ tests: scanners: nice=nice -n 10
- ✗ **tier2**
  - INCOMPLETE
  ✗ Cold limit=10 on coding-hermes and fleet-quality answers in under 500ms with no rows lost, proven by a committed benchmark script; the list path no longer depends on total file count; tests pass.: Three of the five required outcomes are unmet. (a) <500ms cold target NOT met: the repo's own board record .coding-hermes/board/tasks.jsonl (PERF-DUCKBRAIN-001 foreman_note) states verbatim 'target (cold <500ms) NOT met yet', with measured production limit=10 at 1.42/1.88/2.00s and a compacted copy at 0.98s cold; the prior verdict .gitreins/history/2026-11-04/61c5252d/summary.md agrees: 'the <500ms cold-latency target is neither asserted by the committed benchmark nor met'. (b) The committed benchmark scripts/perf/perf001-list-latency.mjs (tracked, commit 0f712522) does sample coding-hermes and fleet-quality at limit=10 (1 cold + 3 warm), but it is 75 lines that only console.log the numbers — `grep -rn "500" scripts/perf/` returns nothing and there is no assertion or non-zero exit on latency, so it cannot 'prove' the target. (c) The list path STILL depends on total file count: src/duckdb/queries.ts:939 calls collectJsonlFiles(partitionPaths) which enumerates every .jsonl file, :876 builds fileList from ALL of them, and runBoundedRead at :803-810 executes read_json([${fileList}]) over the entire list; only the ORDER BY/LIMIT window is bounded (PLAIN_LIST_MAX_WINDOW=100_000 at :671), not the file scan — so latency still scales with the census counts (fleet-quality 29,080 files, coding-hermes 20,054). (d) No rows lost: PASS — src/duckdb/queries-plainlist-bounded-perf001.test.ts proves byte-equivalence to the fused statement across duplicate ids, tombstones, boundary straddles and offsets; `npx vitest run src/duckdb/queries-plainlist-bounded-perf001.test.ts` => 'Test Files 1 passed (1), Tests 4 passed (4)', exit_code 0. (e) Tests pass: PASS — `npx vitest run src/duckdb/` => 'Test Files 13 passed (13), Tests 128 passed (128)', exit_code 0 (the full suite exceeded the 30s tool limit; the duckdb scope is the changed-code scope). The bounded top-k is a genuine, well-tested improvement, but the criterion's headline latency and file-count-independence requirements are not satisfied.
The bounded top-k read is implemented and its tests pass (128/128 in src/duckdb), but the <500ms cold target is explicitly recorded as NOT met, the committed benchmark asserts no latency threshold, and the list path still read_json's every file so latency remains proportional to total file count.

## Summary

Judge Result: PERF-DUCKBRAIN-001

Stage tier1: PASS
    ✓ secrets: secrets: scanners=gitleaks+builtin cross-check
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: FAIL
  INCOMPLETE
  ✗ Cold limit=10 on coding-hermes and fleet-quality answers in under 500ms with no rows lost, proven by a committed benchmark script; the list path no longer depends on total file count; tests pass.: Three of the five required outcomes are unmet. (a) <500ms cold target NOT met: the repo's own board record .coding-hermes/board/tasks.jsonl (PERF-DUCKBRAIN-001 foreman_note) states verbatim 'target (cold <500ms) NOT met yet', with measured production limit=10 at 1.42/1.88/2.00s and a compacted copy at 0.98s cold; the prior verdict .gitreins/history/2026-11-04/61c5252d/summary.md agrees: 'the <500ms cold-latency target is neither asserted by the committed benchmark nor met'. (b) The committed benchmark scripts/perf/perf001-list-latency.mjs (tracked, commit 0f712522) does sample coding-hermes and fleet-quality at limit=10 (1 cold + 3 warm), but it is 75 lines that only console.log the numbers — `grep -rn "500" scripts/perf/` returns nothing and there is no assertion or non-zero exit on latency, so it cannot 'prove' the target. (c) The list path STILL depends on total file count: src/duckdb/queries.ts:939 calls collectJsonlFiles(partitionPaths) which enumerates every .jsonl file, :876 builds fileList from ALL of them, and runBoundedRead at :803-810 executes read_json([${fileList}]) over the entire list; only the ORDER BY/LIMIT window is bounded (PLAIN_LIST_MAX_WINDOW=100_000 at :671), not the file scan — so latency still scales with the census counts (fleet-quality 29,080 files, coding-hermes 20,054). (d) No rows lost: PASS — src/duckdb/queries-plainlist-bounded-perf001.test.ts proves byte-equivalence to the fused statement across duplicate ids, tombstones, boundary straddles and offsets; `npx vitest run src/duckdb/queries-plainlist-bounded-perf001.test.ts` => 'Test Files 1 passed (1), Tests 4 passed (4)', exit_code 0. (e) Tests pass: PASS — `npx vitest run src/duckdb/` => 'Test Files 13 passed (13), Tests 128 passed (128)', exit_code 0 (the full suite exceeded the 30s tool limit; the duckdb scope is the changed-code scope). The bounded top-k is a genuine, well-tested improvement, but the criterion's headline latency and file-count-independence requirements are not satisfied.
The bounded top-k read is implemented and its tests pass (128/128 in src/duckdb), but the <500ms cold target is explicitly recorded as NOT met, the committed benchmark asserts no latency threshold, and the list path still read_json's every file so latency remains proportional to total file count.

Overall: FAIL ✗
