# Verdict: S3-GIT-003

**Task:** Periodic forced full pass for S3 git-history
**Evaluated:** 2026-09-18T21:11:12.245054
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: [90m4:06PM[0m [32mINF[0m [1mscanned ~9978276 bytes (9.98 MB) in 2.32s[0m
[90m4:06PM[0m [32m
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  149 passed (149)
      Tests  1168 passed (1168)

- ✓ **tier2**
  - COMPLETE
  ✓ A healthy namespace whose state is older than the configured full-pass threshold is pushed again after its remote is deleted; normal unchanged runs remain skipped; weekly/unified wiring emits observable forced-pass evidence; harness and existing S3 tests pass.: (A) Age rule: scripts/s3/duckbrain-s3-push.sh:379-388 forces a re-push when FULL_PASS_INTERVAL>0, fail_count==0, last_refs==refs_now and (now-last_success)>=FULL_PASS_INTERVAL; harness RUN 8 (test-push-backoff.sh:273-296) wipes the ns-one remote, sets last_success=1, and asserts 'run8 the aged namespace is force-pushed with an age reason' + 'run8 the wipe was repaired by the age-based force alone' (remote sha == local sha). (B) Skip preserved: push.sh:401-406 skips when no force_reason and refs unchanged; harness RUN 2/6/9 assert 'pushed=0 skipped=3 ... forced=0' and 'run9 made no push attempt at all (no 15-minute re-push regression)'; RUN 10 proves DUCKBRAIN_S3_FULL_PASS_INTERVAL_S=0 disables the age force. (C) Observable evidence: push.sh:396 per-ns 'force-push <ns> (<reason>)', :472 'forced-full:' roll-up, :475 'forced-full-age:' line, :485 'forced=N' summary, :488/:493 PARTIAL + FORCED-FULL PARTIAL, :500 NOTICE; unified wrapper (duckbrain-s3-unified.sh:26-34,78-105) runs the git layer <=once/24h and inherits the env knobs unchanged — harness RUN 7 drives it through the unified wrapper and asserts the forced decision is logged with namespace AND reason, the roll-up reports 'env=2 age=0', and stdout says the pass was partial (not a bare green line). (D) Tests: `bash scripts/s3/test-push-backoff.sh` -> 'harness: 85 passed, 0 failed' EXIT=0; `bash scripts/s3/test-duplicate-bundle-repair.sh` -> 'harness: 51 passed, 0 failed' EXIT=0; `npx vitest run` -> 'Test Files 149 passed (149) / Tests 1168 passed (1168)' EXIT=0. RED check: the same harness against pre-fix ffc66d3 -> 'harness: 57 passed, 28 failed', proving the tests genuinely exercise the new behavior.
All four sub-claims verified: the age-based forced full pass repairs a wiped remote for an aged healthy namespace, unchanged runs stay skipped, the unified/weekly wiring emits observable forced-pass evidence, and the harness (85/85), duplicate-bundle harness (51/51) and vitest suite (1168/1168) all pass.

## Summary

Judge Result: S3-GIT-003

Stage tier1: PASS
    ✓ secrets: [90m4:06PM[0m [32mINF[0m [1mscanned ~9978276 bytes (9.98 MB) in 2.32s[0m
[90m4:06PM[0m [32m
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  149 passed (149)
      Tests  1168 passed (1168)


Stage tier2: PASS
  COMPLETE
  ✓ A healthy namespace whose state is older than the configured full-pass threshold is pushed again after its remote is deleted; normal unchanged runs remain skipped; weekly/unified wiring emits observable forced-pass evidence; harness and existing S3 tests pass.: (A) Age rule: scripts/s3/duckbrain-s3-push.sh:379-388 forces a re-push when FULL_PASS_INTERVAL>0, fail_count==0, last_refs==refs_now and (now-last_success)>=FULL_PASS_INTERVAL; harness RUN 8 (test-push-backoff.sh:273-296) wipes the ns-one remote, sets last_success=1, and asserts 'run8 the aged namespace is force-pushed with an age reason' + 'run8 the wipe was repaired by the age-based force alone' (remote sha == local sha). (B) Skip preserved: push.sh:401-406 skips when no force_reason and refs unchanged; harness RUN 2/6/9 assert 'pushed=0 skipped=3 ... forced=0' and 'run9 made no push attempt at all (no 15-minute re-push regression)'; RUN 10 proves DUCKBRAIN_S3_FULL_PASS_INTERVAL_S=0 disables the age force. (C) Observable evidence: push.sh:396 per-ns 'force-push <ns> (<reason>)', :472 'forced-full:' roll-up, :475 'forced-full-age:' line, :485 'forced=N' summary, :488/:493 PARTIAL + FORCED-FULL PARTIAL, :500 NOTICE; unified wrapper (duckbrain-s3-unified.sh:26-34,78-105) runs the git layer <=once/24h and inherits the env knobs unchanged — harness RUN 7 drives it through the unified wrapper and asserts the forced decision is logged with namespace AND reason, the roll-up reports 'env=2 age=0', and stdout says the pass was partial (not a bare green line). (D) Tests: `bash scripts/s3/test-push-backoff.sh` -> 'harness: 85 passed, 0 failed' EXIT=0; `bash scripts/s3/test-duplicate-bundle-repair.sh` -> 'harness: 51 passed, 0 failed' EXIT=0; `npx vitest run` -> 'Test Files 149 passed (149) / Tests 1168 passed (1168)' EXIT=0. RED check: the same harness against pre-fix ffc66d3 -> 'harness: 57 passed, 28 failed', proving the tests genuinely exercise the new behavior.
All four sub-claims verified: the age-based forced full pass repairs a wiped remote for an aged healthy namespace, unchanged runs stay skipped, the unified/weekly wiring emits observable forced-pass evidence, and the harness (85/85), duplicate-bundle harness (51/51) and vitest suite (1168/1168) all pass.

Overall: PASS ✓
