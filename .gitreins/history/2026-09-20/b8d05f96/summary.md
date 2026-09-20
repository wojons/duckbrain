# Verdict: DEPS-001

**Task:** Dependency refresh: 9 npm packages
**Evaluated:** 2026-09-20T09:24:31.491790
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v5.0.1 /home/kara/duckbrain
- ✓ **tier2**
  - COMPLETE
  ✓ package.json + pnpm-lock.yaml + package-lock.json are synced to the refreshed versions (@aws-sdk/client-s3 3.1136.0, @modelcontextprotocol/sdk 1.30.0, vitest 5.0.1, @vitest/coverage-v8 5.0.1, concurrently 10.0.5, tsx 4.23.13, uuid 14.0.2, @types/node 26.6.2) with no unfrozen drift; 'pnpm install --frozen-lockfile' exits 0; 'npx tsc --noEmit' exits 0; full unit suite green at 157 files / 1247 tests; and 'docker build -t duckbrain .' exits 0 (the CI docker job's build path, runnable on this host): All sub-claims verified in /home/kara/duckbrain. (a) package.json declares all 8 refreshed ranges exactly (^3.1136.0, ^1.30.0, ^5.0.1, ^5.0.1, ^10.0.5, ^4.23.13, ^14.0.2, ^26.6.2). (b) pnpm-lock.yaml importers '.' block (lines 169-217) resolves 3.1136.0 / 1.30.0 / 4.23.13 / 14.0.2 / 26.6.2 / 5.0.1 / 10.0.5 / 5.0.1. (c) package-lock.json root deps match and node_modules entries are client-s3 3.1136.0, mcp 1.30.0, vitest 5.0.1, coverage-v8 5.0.1, concurrently 10.0.5, uuid 14.0.2, @types/node 26.6.2, tsx 4.23.14 (satisfies ^4.23.13). (d) No unfrozen drift: `pnpm install --frozen-lockfile` EXIT=0 with 'Lockfile is up to date, resolution step is skipped / Done in 19ms using pnpm v12.4.2'; git status for the three files is clean (committed in bc0bfdb + e6075ca). (e) `npx tsc --noEmit` EXIT=0, no output. (f) `npx vitest run` output: 'Test Files  157 passed (157)' / 'Tests  1247 passed (1247)' / Duration 67.44s; 157 src/**/*.test.ts files confirmed by find; zero 'failed' lines. (g) `docker build -t duckbrain .` EXIT=0 (buildx, image sha256:c7781fcea551, 855MB); the Dockerfile builder stage runs `npm ci` from package*.json, independently reproduced in /tmp/npmci-probe with the repo's package.json+package-lock.json → EXIT=0, 'added 329 packages', installed versions confirmed identical to the refreshed set. Image timestamp 02:21:20 postdates the lockfile regen at 02:19:51, so the cached npm ci layer reflects the current lockfile.
All DEPS-001 requirements verified: all three manifests synced to the 8 refreshed versions with no drift, pnpm --frozen-lockfile and tsc --noEmit exit 0, vitest reports 157 files / 1247 tests passing, and docker build -t duckbrain . exits 0.

## Summary

Judge Result: DEPS-001

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v5.0.1 /home/kara/duckbrain

Stage tier2: PASS
  COMPLETE
  ✓ package.json + pnpm-lock.yaml + package-lock.json are synced to the refreshed versions (@aws-sdk/client-s3 3.1136.0, @modelcontextprotocol/sdk 1.30.0, vitest 5.0.1, @vitest/coverage-v8 5.0.1, concurrently 10.0.5, tsx 4.23.13, uuid 14.0.2, @types/node 26.6.2) with no unfrozen drift; 'pnpm install --frozen-lockfile' exits 0; 'npx tsc --noEmit' exits 0; full unit suite green at 157 files / 1247 tests; and 'docker build -t duckbrain .' exits 0 (the CI docker job's build path, runnable on this host): All sub-claims verified in /home/kara/duckbrain. (a) package.json declares all 8 refreshed ranges exactly (^3.1136.0, ^1.30.0, ^5.0.1, ^5.0.1, ^10.0.5, ^4.23.13, ^14.0.2, ^26.6.2). (b) pnpm-lock.yaml importers '.' block (lines 169-217) resolves 3.1136.0 / 1.30.0 / 4.23.13 / 14.0.2 / 26.6.2 / 5.0.1 / 10.0.5 / 5.0.1. (c) package-lock.json root deps match and node_modules entries are client-s3 3.1136.0, mcp 1.30.0, vitest 5.0.1, coverage-v8 5.0.1, concurrently 10.0.5, uuid 14.0.2, @types/node 26.6.2, tsx 4.23.14 (satisfies ^4.23.13). (d) No unfrozen drift: `pnpm install --frozen-lockfile` EXIT=0 with 'Lockfile is up to date, resolution step is skipped / Done in 19ms using pnpm v12.4.2'; git status for the three files is clean (committed in bc0bfdb + e6075ca). (e) `npx tsc --noEmit` EXIT=0, no output. (f) `npx vitest run` output: 'Test Files  157 passed (157)' / 'Tests  1247 passed (1247)' / Duration 67.44s; 157 src/**/*.test.ts files confirmed by find; zero 'failed' lines. (g) `docker build -t duckbrain .` EXIT=0 (buildx, image sha256:c7781fcea551, 855MB); the Dockerfile builder stage runs `npm ci` from package*.json, independently reproduced in /tmp/npmci-probe with the repo's package.json+package-lock.json → EXIT=0, 'added 329 packages', installed versions confirmed identical to the refreshed set. Image timestamp 02:21:20 postdates the lockfile regen at 02:19:51, so the cached npm ci layer reflects the current lockfile.
All DEPS-001 requirements verified: all three manifests synced to the 8 refreshed versions with no drift, pnpm --frozen-lockfile and tsc --noEmit exit 0, vitest reports 157 files / 1247 tests passing, and docker build -t duckbrain . exits 0.

Overall: PASS ✓
