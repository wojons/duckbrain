# Verdict: DF-0925-07

**Task:** DR pull restores a fresh machine from S3
**Evaluated:** 2026-09-29T11:16:37.662433
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: RUN  v5.0.1 /home/kara/duckbrain
- ✓ **tier2**
  - COMPLETE
  ✓ On an empty namespaces root: (a) pull materializes namespaces found under the remote prefix (bootstrap-then-pull); (b) 's3 sync all pull' reports restored-vs-skipped loudly and never claims success with 0 restored when the remote prefix is non-empty; (c) README/docs document the exact fresh-machine restore command sequence: (a) src/s3/sync.ts:361-374 syncNamespace bootstraps a missing ns dir on pull via fs.mkdirSync(nsDir,{recursive:true}) (push still throws); syncAllNamespaces:391-420 enumerates the REMOTE prefix via listRemoteNamespaces (sync.ts:220-236) and unions with local dirs. (b) src/s3/cli.ts:147-172 prints per-namespace downloaded/skipped counts and, when remoteCount>0 && all.length===0, prints a loud WARNING and process.exit(1). (c) README.md:209-235 'Fresh-machine DR restore (paste-able)' gives the exact sequence (clone -> config -> 'duckbrain s3 sync all pull' -> git reinit -> serve); docs/s3-native.md:247-280 documents the same with a valid cross-link anchor. Test evidence (fresh runs): 'npx vitest run src/s3/cli-pull-df092507.test.ts' -> Test Files 1 passed, Tests 15 passed (incl. 'pull creates the missing namespace dir and downloads the files', 'restores into an ABSENT namespaces root (truly fresh machine)', 'all pull restoring 0 with a non-empty remote warns and exits nonzero', 'a fully in-sync re-run restores 0 files but does NOT warn'); 'npx vitest run src/s3' -> 5 files / 43 tests passed; battery log /tmp/battery-614.log -> 184 files / 1464 tests passed + prettier clean.
All three sub-criteria (bootstrap pull, loud restored-vs-skipped reporting with nonzero exit on silent zero, and documented fresh-machine restore sequence) are implemented and verified by 15 passing dedicated tests plus the full suite.

## Summary

Judge Result: DF-0925-07

Stage tier1: FAIL
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: RUN  v5.0.1 /home/kara/duckbrain

Stage tier2: PASS
  COMPLETE
  ✓ On an empty namespaces root: (a) pull materializes namespaces found under the remote prefix (bootstrap-then-pull); (b) 's3 sync all pull' reports restored-vs-skipped loudly and never claims success with 0 restored when the remote prefix is non-empty; (c) README/docs document the exact fresh-machine restore command sequence: (a) src/s3/sync.ts:361-374 syncNamespace bootstraps a missing ns dir on pull via fs.mkdirSync(nsDir,{recursive:true}) (push still throws); syncAllNamespaces:391-420 enumerates the REMOTE prefix via listRemoteNamespaces (sync.ts:220-236) and unions with local dirs. (b) src/s3/cli.ts:147-172 prints per-namespace downloaded/skipped counts and, when remoteCount>0 && all.length===0, prints a loud WARNING and process.exit(1). (c) README.md:209-235 'Fresh-machine DR restore (paste-able)' gives the exact sequence (clone -> config -> 'duckbrain s3 sync all pull' -> git reinit -> serve); docs/s3-native.md:247-280 documents the same with a valid cross-link anchor. Test evidence (fresh runs): 'npx vitest run src/s3/cli-pull-df092507.test.ts' -> Test Files 1 passed, Tests 15 passed (incl. 'pull creates the missing namespace dir and downloads the files', 'restores into an ABSENT namespaces root (truly fresh machine)', 'all pull restoring 0 with a non-empty remote warns and exits nonzero', 'a fully in-sync re-run restores 0 files but does NOT warn'); 'npx vitest run src/s3' -> 5 files / 43 tests passed; battery log /tmp/battery-614.log -> 184 files / 1464 tests passed + prettier clean.
All three sub-criteria (bootstrap pull, loud restored-vs-skipped reporting with nonzero exit on silent zero, and documented fresh-machine restore sequence) are implemented and verified by 15 passing dedicated tests plus the full suite.

Overall: FAIL ✗
