# Verdict: S3-GIT-004

**Task:** S3 git layer self-heals duplicate-bundle ref collisions (quarantine + prune)
**Evaluated:** 2026-09-18T17:44:21.187929
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: [90m12:42PM[0m [32mINF[0m [1mscanned ~9908133 bytes (9.91 MB) in 1.63s[0m
[90m12:42PM[0m [3
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  149 passed (149)
      Tests  1168 passed (1168)

- ✓ **tier2**
  - COMPLETE
  ✓ scripts/s3/duckbrain-s3-push.sh detects >1 bundle under a pushed ref, quarantines the stale bundle(s) outside the ref tree with size verification, deletes them from the ref path, never deletes a bundle whose sha is missing locally, skips the guard entirely for non-s3 URLs, and does not alter the S3-GIT-002 exit-code/backoff/stamp contract; a hermetic harness with a stub aws proves cases (a)-(d) and the existing test-push-backoff.sh stays green.: Detection: repair_duplicate_bundles counts bundles from _s3_list_ref_bundles and only repairs when n>1 (duckbrain-s3-push.sh:145-155). Quarantine+size verify: `aws s3 cp` to quarantine/git/<ns>/<branch>/<sha>.bundle then `s3api head-object --query ContentLength` compared to source Size; mismatch => 'original NOT deleted' (lines ~180-195). Delete from ref path: `aws s3 rm` of stale key only after verified copy. Missing-local-sha guard: `git -C "$nsdir" cat-file -e "${sha}^{commit}"` else 'repair-skip ... NOT in the local repo — left alone' (line ~172). Non-s3 skip: repair_ns_refs returns 0 for non-s3:// (line 281) and caller guards `[[ "$url" == s3://* ]]` (line 339) => zero aws calls. S3-GIT-002 contract: `git show HEAD -- scripts/s3/duckbrain-s3-push.sh | grep -cE '^-[^-]'` = 0 removed lines (purely additive), exit-code/backoff/stamp logic untouched. Harness: `bash scripts/s3/test-duplicate-bundle-repair.sh` exit_code=0, output 'harness: 51 passed, 0 failed' covering cases A-G (duplicate detect+quarantine/delete, missing-local-sha refusal, single-bundle no-op, non-s3 skip, helper-running skip, aws-failure swallow, truncated-copy survival) with stub aws + stub git-remote-s3 + scratch HOME (hermetic). Existing: `bash scripts/s3/test-push-backoff.sh` exit_code=0, 'harness: 38 passed, 0 failed'.
All S3-GIT-004 sub-requirements are implemented and proven by two green hermetic harnesses (51/0 and 38/0) with a purely additive diff preserving the S3-GIT-002 contract.

## Summary

Judge Result: S3-GIT-004

Stage tier1: PASS
    ✓ secrets: [90m12:42PM[0m [32mINF[0m [1mscanned ~9908133 bytes (9.91 MB) in 1.63s[0m
[90m12:42PM[0m [3
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  149 passed (149)
      Tests  1168 passed (1168)


Stage tier2: PASS
  COMPLETE
  ✓ scripts/s3/duckbrain-s3-push.sh detects >1 bundle under a pushed ref, quarantines the stale bundle(s) outside the ref tree with size verification, deletes them from the ref path, never deletes a bundle whose sha is missing locally, skips the guard entirely for non-s3 URLs, and does not alter the S3-GIT-002 exit-code/backoff/stamp contract; a hermetic harness with a stub aws proves cases (a)-(d) and the existing test-push-backoff.sh stays green.: Detection: repair_duplicate_bundles counts bundles from _s3_list_ref_bundles and only repairs when n>1 (duckbrain-s3-push.sh:145-155). Quarantine+size verify: `aws s3 cp` to quarantine/git/<ns>/<branch>/<sha>.bundle then `s3api head-object --query ContentLength` compared to source Size; mismatch => 'original NOT deleted' (lines ~180-195). Delete from ref path: `aws s3 rm` of stale key only after verified copy. Missing-local-sha guard: `git -C "$nsdir" cat-file -e "${sha}^{commit}"` else 'repair-skip ... NOT in the local repo — left alone' (line ~172). Non-s3 skip: repair_ns_refs returns 0 for non-s3:// (line 281) and caller guards `[[ "$url" == s3://* ]]` (line 339) => zero aws calls. S3-GIT-002 contract: `git show HEAD -- scripts/s3/duckbrain-s3-push.sh | grep -cE '^-[^-]'` = 0 removed lines (purely additive), exit-code/backoff/stamp logic untouched. Harness: `bash scripts/s3/test-duplicate-bundle-repair.sh` exit_code=0, output 'harness: 51 passed, 0 failed' covering cases A-G (duplicate detect+quarantine/delete, missing-local-sha refusal, single-bundle no-op, non-s3 skip, helper-running skip, aws-failure swallow, truncated-copy survival) with stub aws + stub git-remote-s3 + scratch HOME (hermetic). Existing: `bash scripts/s3/test-push-backoff.sh` exit_code=0, 'harness: 38 passed, 0 failed'.
All S3-GIT-004 sub-requirements are implemented and proven by two green hermetic harnesses (51/0 and 38/0) with a purely additive diff preserving the S3-GIT-002 contract.

Overall: PASS ✓
