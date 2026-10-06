# Verdict: QA-DUCKBRAIN-006

**Task:** package-lock.json stale after DEPS-004 (docker npm ci dead)
**Evaluated:** 2026-09-30T14:07:20.404825
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v5.0.2 /home/kara/duckbrain
- ✓ **tier2**
  - COMPLETE
  ✓ npm ci --dry-run exits 0 at HEAD; fresh clone npm ci succeeds; lockfile matches package.json: Repo /home/kara/duckbrain, HEAD=1ac89d4 'fix(QA-DUCKBRAIN-006): regenerate package-lock.json after DEPS-004 refresh' (only package-lock.json changed, 136+/154-). (1) `npm ci --dry-run` at HEAD -> EXIT=0, output 'added 68 packages, removed 2 packages, and changed 28 packages in 461ms'. (2) Fresh clone `git clone /home/kara/duckbrain /tmp/qa006-fresh` (HEAD 1ac89d4) then `npm ci` -> EXIT=0, 'added 327 packages, and audited 328 packages in 5s'. (3) Lockfile/package.json sync check via node: lockfileVersion 3, name match true (duckbrain), version match true (1.0.0), dependencies MATCH, devDependencies MATCH, optionalDependencies MATCH, peerDependencies MATCH. Non-vacuous: pre-fix commit 1ac89d4~1 (dce18c4) `npm ci --dry-run` -> EXIT=1 with 'npm error code EUSAGE ... lock file's @aws-sdk/client-s3@3.1137.0 does not satisfy @aws-sdk/client-s3@3.1142.0' plus 5+ more mismatches (@modelcontextprotocol/sdk, @types/node, @vitest/coverage-v8, vitest, vite, std-env, rolldown, @oxc-project/types, @rolldown/binding-*). Dockerfile:8 uses `RUN npm ci`, confirming the Docker deploy path was genuinely dead and is now fixed. Working tree lockfile is identical to HEAD (git status clean for package-lock.json/package.json). [resolution 0.08; package.json]
package-lock.json was regenerated to match package.json; npm ci --dry-run exits 0 at HEAD, a real fresh-clone npm ci succeeds (327 packages), and the pre-fix commit demonstrably failed with EUSAGE, so the Docker npm ci path is restored.

## Summary

Judge Result: QA-DUCKBRAIN-006

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v5.0.2 /home/kara/duckbrain

Stage tier2: PASS
  COMPLETE
  ✓ npm ci --dry-run exits 0 at HEAD; fresh clone npm ci succeeds; lockfile matches package.json: Repo /home/kara/duckbrain, HEAD=1ac89d4 'fix(QA-DUCKBRAIN-006): regenerate package-lock.json after DEPS-004 refresh' (only package-lock.json changed, 136+/154-). (1) `npm ci --dry-run` at HEAD -> EXIT=0, output 'added 68 packages, removed 2 packages, and changed 28 packages in 461ms'. (2) Fresh clone `git clone /home/kara/duckbrain /tmp/qa006-fresh` (HEAD 1ac89d4) then `npm ci` -> EXIT=0, 'added 327 packages, and audited 328 packages in 5s'. (3) Lockfile/package.json sync check via node: lockfileVersion 3, name match true (duckbrain), version match true (1.0.0), dependencies MATCH, devDependencies MATCH, optionalDependencies MATCH, peerDependencies MATCH. Non-vacuous: pre-fix commit 1ac89d4~1 (dce18c4) `npm ci --dry-run` -> EXIT=1 with 'npm error code EUSAGE ... lock file's @aws-sdk/client-s3@3.1137.0 does not satisfy @aws-sdk/client-s3@3.1142.0' plus 5+ more mismatches (@modelcontextprotocol/sdk, @types/node, @vitest/coverage-v8, vitest, vite, std-env, rolldown, @oxc-project/types, @rolldown/binding-*). Dockerfile:8 uses `RUN npm ci`, confirming the Docker deploy path was genuinely dead and is now fixed. Working tree lockfile is identical to HEAD (git status clean for package-lock.json/package.json). [resolution 0.08; package.json]
package-lock.json was regenerated to match package.json; npm ci --dry-run exits 0 at HEAD, a real fresh-clone npm ci succeeds (327 packages), and the pre-fix commit demonstrably failed with EUSAGE, so the Docker npm ci path is restored.

Overall: PASS ✓
