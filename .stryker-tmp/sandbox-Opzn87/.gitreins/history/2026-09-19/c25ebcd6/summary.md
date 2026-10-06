# Verdict: DB-GAP-049

**Task:** DB-GAP-049: chunk rotation froze past segment 9999 (padStart>4 digits + lexicographic sort) -> one segment holds every write (87,530 lines/84MB against a 1000-line/1MB bound)
**Evaluated:** 2026-09-19T14:49:51.948776
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v4.1.10 /home/kara/duckbrain
- ✓ **tier2**
  - COMPLETE
  ✓ src/storage/jsonl.ts orders chunk names numerically (compareChunkNames) and getNextChunkName never returns a segment name that already exists; readPartition uses the same numeric ordering: src/storage/jsonl.ts:96-104 defines compareChunkNames() with numeric regex /^\d+\.jsonl$/ + parseInt comparison (non-numeric names sort last). getNextChunkName (lines ~130-140) filters numeric chunks, sorts with .sort(compareChunkNames), then has a collision guard `while (fs.existsSync(path.join(partitionPath, candidate))) { nextNum += 1; ... }` so it never returns an existing name. readPartition (line ~421) uses `.sort(compareChunkNames)` on all *.jsonl chunks. Verified by test run: 10/10 pass in src/storage/jsonl.test.ts.
  ✓ src/storage/jsonl.test.ts adds regression cases for rotation past segment 9999, the collision guard, the legacy 4-digit sequence, non-numeric segments, appending into a new segment at capacity, and numeric read order; the pre-fix revision fails those cases (4 failed / 6 passed): src/storage/jsonl.test.ts adds describe("chunk rotation past segment 9999") with exactly the 6 required cases: 'continues to 10001.jsonl when 9999.jsonl and 10000.jsonl exist', 'skips existing names instead of re-returning one (collision guard)' -> 10003, 'keeps the legacy numeric sequence below 10000' -> 0003, 'ignores non-numeric segments when choosing the next chunk' -> 0008, 'appends to a NEW segment when a five-digit-named segment is at capacity', 'reads segments in numeric order, not lexicographic order'. RED-proven empirically: I swapped in the pre-fix src/storage/jsonl.ts (git show 3b6bbce^) and ran `npx vitest run src/storage/jsonl.test.ts` -> output 'Tests  4 failed | 6 passed (10)' with failures `expected '10000.jsonl' to be '10001.jsonl'` and `expected [ '/test/rotation/2', ... ] to deeply equal [ '/test/rotation/1', ... ]`. Restored the fixed file; `git diff --stat` shows no residual change to src/storage/jsonl.ts.
  ✓ tsc --noEmit clean, full vitest suite green at 149 files / 1174 tests, AGENTS.md counts read 1174, and the commit touches only AGENTS.md + src/storage/jsonl.ts + src/storage/jsonl.test.ts: `npx tsc --noEmit` -> exit_code 0, no output (clean). Full `npx vitest run` -> 'Test Files  149 passed (149)' / 'Tests  1174 passed (1174)' (exit 0). AGENTS.md:14 'Vitest (149 suites, 1174 tests)' and AGENTS.md:33 'pnpm test # 1174 tests, 149 suites' — both read 1174. `git show --name-only 3b6bbce` lists exactly AGENTS.md, src/storage/jsonl.test.ts, src/storage/jsonl.ts (3 files, no extras).


## Summary

Judge Result: DB-GAP-049

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v4.1.10 /home/kara/duckbrain

Stage tier2: PASS
  COMPLETE
  ✓ src/storage/jsonl.ts orders chunk names numerically (compareChunkNames) and getNextChunkName never returns a segment name that already exists; readPartition uses the same numeric ordering: src/storage/jsonl.ts:96-104 defines compareChunkNames() with numeric regex /^\d+\.jsonl$/ + parseInt comparison (non-numeric names sort last). getNextChunkName (lines ~130-140) filters numeric chunks, sorts with .sort(compareChunkNames), then has a collision guard `while (fs.existsSync(path.join(partitionPath, candidate))) { nextNum += 1; ... }` so it never returns an existing name. readPartition (line ~421) uses `.sort(compareChunkNames)` on all *.jsonl chunks. Verified by test run: 10/10 pass in src/storage/jsonl.test.ts.
  ✓ src/storage/jsonl.test.ts adds regression cases for rotation past segment 9999, the collision guard, the legacy 4-digit sequence, non-numeric segments, appending into a new segment at capacity, and numeric read order; the pre-fix revision fails those cases (4 failed / 6 passed): src/storage/jsonl.test.ts adds describe("chunk rotation past segment 9999") with exactly the 6 required cases: 'continues to 10001.jsonl when 9999.jsonl and 10000.jsonl exist', 'skips existing names instead of re-returning one (collision guard)' -> 10003, 'keeps the legacy numeric sequence below 10000' -> 0003, 'ignores non-numeric segments when choosing the next chunk' -> 0008, 'appends to a NEW segment when a five-digit-named segment is at capacity', 'reads segments in numeric order, not lexicographic order'. RED-proven empirically: I swapped in the pre-fix src/storage/jsonl.ts (git show 3b6bbce^) and ran `npx vitest run src/storage/jsonl.test.ts` -> output 'Tests  4 failed | 6 passed (10)' with failures `expected '10000.jsonl' to be '10001.jsonl'` and `expected [ '/test/rotation/2', ... ] to deeply equal [ '/test/rotation/1', ... ]`. Restored the fixed file; `git diff --stat` shows no residual change to src/storage/jsonl.ts.
  ✓ tsc --noEmit clean, full vitest suite green at 149 files / 1174 tests, AGENTS.md counts read 1174, and the commit touches only AGENTS.md + src/storage/jsonl.ts + src/storage/jsonl.test.ts: `npx tsc --noEmit` -> exit_code 0, no output (clean). Full `npx vitest run` -> 'Test Files  149 passed (149)' / 'Tests  1174 passed (1174)' (exit 0). AGENTS.md:14 'Vitest (149 suites, 1174 tests)' and AGENTS.md:33 'pnpm test # 1174 tests, 149 suites' — both read 1174. `git show --name-only 3b6bbce` lists exactly AGENTS.md, src/storage/jsonl.test.ts, src/storage/jsonl.ts (3 files, no extras).


Overall: PASS ✓
