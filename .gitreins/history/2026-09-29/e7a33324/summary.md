# Verdict: QA-DUCKBRAIN-004

**Task:** Fix multi-uid EACCES on shared /tmp/.duckbrain-write test locks
**Evaluated:** 2026-09-29T16:46:07.299399
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: RUN  v5.0.1 /home/kara/duckbrain
- ✗ **tier2**
  - INCOMPLETE
  ✗ Test-path lock files land in per-namespace sibling dirs, never the shared tmpdir root; full suite green on multi-uid layout: Criterion 0: "Test-path lock files land in per-namespace sibling dirs, never the shared tmpdir root; full suite green on multi-uid layout"

PART A (per-namespace sibling dirs) — PASS:
- src/serialization/lock.ts:47-56 adds isSharedTempRoot() (path.resolve(root)===path.resolve(os.tmpdir())) and lockDirFor() which returns path.join(resolve(namespacesPath), `.duckbrain-write-${ns}`) when the root IS the shared tmpdir, else the status-quo `<root>/.duckbrain-write`.
- namespaceWriteLockPath (lock.ts:58-63) now joins lockDirFor(...) + `${ns}.lock`, so tmpdir-rooted test locks land in `<tmpdir>/.duckbrain-write-<ns>/<ns>.lock` — a per-namespace SIBLING dir, never `<tmpdir>/.duckbrain-write` (the shared cross-uid root).
- Regression tests in src/serialization/lock.test.ts:145-268 assert exactly this: lockPath is NOT `<tmpdir>/.duckbrain-write/<ns>.lock`, startsWith `<tmpdir>/.duckbrain-write-<ns>/`, is not inside the ns dir, two tmpdir callers get distinct lock dirs, and non-tmpdir roots keep the status-quo path.
- Multi-uid simulation test (lock.test.ts:181-217) mocks os.tmpdir to a fake tmpdir whose `.duckbrain-write` is chmod 0555 (EACCES), and asserts acquireNamespaceWriteLock still succeeds, the hostile shared dir is never written (readdirSync === []), and the ns dir is untouched.

PART B (full suite green) — NOT VERIFIED:
- `npx vitest run src/serialization/lock.test.ts` => exit_code 0, "Test Files 1 passed (1) / Tests 10 passed (10)".
- Full `npx vitest run` was launched (nohup, /tmp/qa004-full.log) but the machine is heavily loaded with many concurrent vitest runs from other repos; after ~30 min the log was still 0 bytes and the run had not completed. No full-suite result was obtained, so the "full suite green" half of the criterion is unproven by command output.
- Note: /tmp/.duckbrain-write exists (drwxrwxr-x kara kara) with a stale lock from Sep 27, i.e. the shared dir is present in this environment.
Partial verdict — evaluation hit resource cap before all criteria verified

## Summary

Judge Result: QA-DUCKBRAIN-004

Stage tier1: FAIL
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: RUN  v5.0.1 /home/kara/duckbrain

Stage tier2: FAIL
  INCOMPLETE
  ✗ Test-path lock files land in per-namespace sibling dirs, never the shared tmpdir root; full suite green on multi-uid layout: Criterion 0: "Test-path lock files land in per-namespace sibling dirs, never the shared tmpdir root; full suite green on multi-uid layout"

PART A (per-namespace sibling dirs) — PASS:
- src/serialization/lock.ts:47-56 adds isSharedTempRoot() (path.resolve(root)===path.resolve(os.tmpdir())) and lockDirFor() which returns path.join(resolve(namespacesPath), `.duckbrain-write-${ns}`) when the root IS the shared tmpdir, else the status-quo `<root>/.duckbrain-write`.
- namespaceWriteLockPath (lock.ts:58-63) now joins lockDirFor(...) + `${ns}.lock`, so tmpdir-rooted test locks land in `<tmpdir>/.duckbrain-write-<ns>/<ns>.lock` — a per-namespace SIBLING dir, never `<tmpdir>/.duckbrain-write` (the shared cross-uid root).
- Regression tests in src/serialization/lock.test.ts:145-268 assert exactly this: lockPath is NOT `<tmpdir>/.duckbrain-write/<ns>.lock`, startsWith `<tmpdir>/.duckbrain-write-<ns>/`, is not inside the ns dir, two tmpdir callers get distinct lock dirs, and non-tmpdir roots keep the status-quo path.
- Multi-uid simulation test (lock.test.ts:181-217) mocks os.tmpdir to a fake tmpdir whose `.duckbrain-write` is chmod 0555 (EACCES), and asserts acquireNamespaceWriteLock still succeeds, the hostile shared dir is never written (readdirSync === []), and the ns dir is untouched.

PART B (full suite green) — NOT VERIFIED:
- `npx vitest run src/serialization/lock.test.ts` => exit_code 0, "Test Files 1 passed (1) / Tests 10 passed (10)".
- Full `npx vitest run` was launched (nohup, /tmp/qa004-full.log) but the machine is heavily loaded with many concurrent vitest runs from other repos; after ~30 min the log was still 0 bytes and the run had not completed. No full-suite result was obtained, so the "full suite green" half of the criterion is unproven by command output.
- Note: /tmp/.duckbrain-write exists (drwxrwxr-x kara kara) with a stale lock from Sep 27, i.e. the shared dir is present in this environment.
Partial verdict — evaluation hit resource cap before all criteria verified

Overall: FAIL ✗
