# Verdict: OPS-009

**Task:** S3 git mirror: repair duplicate refs/heads/master bundles blocking push for scheduler/default/hermes-canopy
**Evaluated:** 2026-09-18T17:42:44.966037
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: [90m12:34PM[0m [32mINF[0m [1mscanned ~9924872 bytes (9.92 MB) in 1.67s[0m
[90m12:34PM[0m [3
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  149 passed (149)
      Tests  1168 passed (1168)

- ✓ **tier2**
  - COMPLETE
  ✓ git ls-remote s3daily for scheduler/default/hermes-canopy each return exactly ONE refs/heads/master; the stale duplicate bundle is quarantined outside the ref tree (size-verified, reversible); a push lands and the remote tip advances to the local tip; off-box clone of the namespace matches the local tip.: All four sub-claims verified with live evidence. (1) ONE ref: `git -C namespaces/<ns> ls-remote s3daily` returns a single refs/heads/master each — scheduler 8efaeaa550b23a46e83c648d7cafadbbf1eb9c06, default 82a140ff749306bc4c57456aa22438544ec3c077, hermes-canopy 870b49ac0bbcf70bb756e9101d2dfc3e9326e5aa; `aws s3api list-objects-v2 --prefix current/git/<ns>/refs/heads/` shows exactly one .bundle per namespace. (2) Quarantine outside ref tree, size-verified: `--prefix quarantine/git/` returns quarantine/git/scheduler/master/dffe583421dd0bc36ff4d7bc6c47f3c1e4b7f7c4.bundle (70602323), quarantine/git/default/master/a8bbdbd9fc6e55b0ceceb5cfcc0d30ce807075c4.bundle (13770577), quarantine/git/hermes-canopy/master/{aef75ff4...,e650931e...}.bundle; `head-object` on the scheduler quarantine key returns ContentLength 70602323 == source size. Reversible: the quarantined bundle was downloaded (70602323 bytes) and `git bundle verify` reports 'is okay ... records a complete history ... refs/heads/master dffe583421dd0bc36ff4d7bc6c47f3c1e4b7f7c4'; README.md documents the `aws s3 cp quarantine/... -> ref path` rollback. The stale sha was confirmed present locally (`git cat-file -e dffe5834^{commit}` ok) so deletion was safe. (3) Push lands / tip advances: ~/.hermes/backups/duckbrain-s3daily.log line '2026-09-18T17:31:23Z OK: pushed=39 skipped=105 failed=0 remote_repos=146 duration_s=151' (prior runs 09-16/09-17/09-18 logged FAIL push default/scheduler/hermes-canopy with failed=2..3); local==remote for all three namespaces. (4) Off-box clone: fresh clones to /tmp/ops009-verify-clone returned rc=0 with HEAD == local tip for all three (scheduler 8efaeaa5..., default 82a140ff..., hermes-canopy 870b49ac...). Supporting: scripts/s3/test-duplicate-bundle-repair.sh -> 'harness: 43 passed, 0 failed'; scripts/s3/test-push-backoff.sh -> 'harness: 38 passed, 0 failed'; `bash -n` syntax OK on both scripts; LSP diagnostics empty.
Live S3 state confirms exactly one refs/heads/master per namespace, size-verified reversible quarantine outside the ref tree, a clean push (failed=0) advancing remote tips to local tips, and off-box clones matching local tips.

## Summary

Judge Result: OPS-009

Stage tier1: PASS
    ✓ secrets: [90m12:34PM[0m [32mINF[0m [1mscanned ~9924872 bytes (9.92 MB) in 1.67s[0m
[90m12:34PM[0m [3
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  149 passed (149)
      Tests  1168 passed (1168)


Stage tier2: PASS
  COMPLETE
  ✓ git ls-remote s3daily for scheduler/default/hermes-canopy each return exactly ONE refs/heads/master; the stale duplicate bundle is quarantined outside the ref tree (size-verified, reversible); a push lands and the remote tip advances to the local tip; off-box clone of the namespace matches the local tip.: All four sub-claims verified with live evidence. (1) ONE ref: `git -C namespaces/<ns> ls-remote s3daily` returns a single refs/heads/master each — scheduler 8efaeaa550b23a46e83c648d7cafadbbf1eb9c06, default 82a140ff749306bc4c57456aa22438544ec3c077, hermes-canopy 870b49ac0bbcf70bb756e9101d2dfc3e9326e5aa; `aws s3api list-objects-v2 --prefix current/git/<ns>/refs/heads/` shows exactly one .bundle per namespace. (2) Quarantine outside ref tree, size-verified: `--prefix quarantine/git/` returns quarantine/git/scheduler/master/dffe583421dd0bc36ff4d7bc6c47f3c1e4b7f7c4.bundle (70602323), quarantine/git/default/master/a8bbdbd9fc6e55b0ceceb5cfcc0d30ce807075c4.bundle (13770577), quarantine/git/hermes-canopy/master/{aef75ff4...,e650931e...}.bundle; `head-object` on the scheduler quarantine key returns ContentLength 70602323 == source size. Reversible: the quarantined bundle was downloaded (70602323 bytes) and `git bundle verify` reports 'is okay ... records a complete history ... refs/heads/master dffe583421dd0bc36ff4d7bc6c47f3c1e4b7f7c4'; README.md documents the `aws s3 cp quarantine/... -> ref path` rollback. The stale sha was confirmed present locally (`git cat-file -e dffe5834^{commit}` ok) so deletion was safe. (3) Push lands / tip advances: ~/.hermes/backups/duckbrain-s3daily.log line '2026-09-18T17:31:23Z OK: pushed=39 skipped=105 failed=0 remote_repos=146 duration_s=151' (prior runs 09-16/09-17/09-18 logged FAIL push default/scheduler/hermes-canopy with failed=2..3); local==remote for all three namespaces. (4) Off-box clone: fresh clones to /tmp/ops009-verify-clone returned rc=0 with HEAD == local tip for all three (scheduler 8efaeaa5..., default 82a140ff..., hermes-canopy 870b49ac...). Supporting: scripts/s3/test-duplicate-bundle-repair.sh -> 'harness: 43 passed, 0 failed'; scripts/s3/test-push-backoff.sh -> 'harness: 38 passed, 0 failed'; `bash -n` syntax OK on both scripts; LSP diagnostics empty.
Live S3 state confirms exactly one refs/heads/master per namespace, size-verified reversible quarantine outside the ref tree, a clean push (failed=0) advancing remote tips to local tips, and off-box clones matching local tips.

Overall: PASS ✓
