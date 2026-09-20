# Verdict: OPS-005

**Task:** Node <22 install-time enforcement (corrected mechanism)
**Evaluated:** 2026-09-20T17:26:03.807370
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v5.0.1 /home/kara/duckbrain
- ✓ **tier2**
  - COMPLETE
  ✓ pnpm-workspace.yaml sets engineStrict: true so a node <22 install FAILS with ERR_PNPM_UNSUPPORTED_ENGINE (A/B verified in a scratch dir); repo-root .npmrc engine-strict=true covers the npm/npm ci path; Dockerfile + Dockerfile.dev build on node >=22; full gate green (tsc, prettier --check src/, unit 160/1275): All four sub-claims reproduced with live command output. (1) pnpm-workspace.yaml:7 has `engineStrict: true` (added in commit 8d13fe4). A/B in scratch dir /tmp/ab3 using the SHIPPED pnpm-workspace.yaml + package.json + pnpm-lock.yaml under a real node v20.20.2 binary (downloaded from nodejs.org): A (engineStrict present) `pnpm install --frozen-lockfile` -> exit 1, 'Error: ERR_PNPM_UNSUPPORTED_ENGINE / Unsupported engine for @testing-library/jest-dom@7.0.1: wanted: {"node":">=22"} (current: {"node":"20.20.2"})'; B (engineStrict removed) same command -> exit 0, 'Done in 862ms using pnpm v12.4.2'. (2) repo-root .npmrc contains exactly `engine-strict=true`. npm A/B in /tmp/ab5 under node v20.20.2: WITH .npmrc -> `npm install` exit 1, 'npm error code EBADENGINE / engine Unsupported engine / Required: {"node":">=22"} / Actual: node v20.20.2'; WITHOUT .npmrc -> exit 0 with only non-fatal 'npm warn EBADENGINE', 'added 20 packages'. (3) Dockerfile:2 `FROM node:22-slim AS builder`, Dockerfile:14 `FROM node:22-slim`; Dockerfile.dev:2 `FROM node:22-slim` (all moved off node:20-slim in 8d13fe4). Live builds: `docker build -t duckbrain-ops005-test .` -> exit 0; `docker build -f Dockerfile.dev -t duckbrain-ops005-dev .` -> exit 0; `docker run --rm --entrypoint node <img> --version` -> v22.23.2 for BOTH images; `npm ci` inside the node:22-slim builder stage succeeded. (4) Full gate: `npx tsc --noEmit` -> exit 0 (no output); `npx prettier --check src/` -> exit 0, 'All matched files use Prettier code style!'; `npx vitest run` -> exit 0, 'Test Files 160 passed (160)' / 'Tests 1275 passed (1275)' — exactly the required 160/1275. No regression: shipped config on node 22 installs cleanly (exit 0).


## Summary

Judge Result: OPS-005

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v5.0.1 /home/kara/duckbrain

Stage tier2: PASS
  COMPLETE
  ✓ pnpm-workspace.yaml sets engineStrict: true so a node <22 install FAILS with ERR_PNPM_UNSUPPORTED_ENGINE (A/B verified in a scratch dir); repo-root .npmrc engine-strict=true covers the npm/npm ci path; Dockerfile + Dockerfile.dev build on node >=22; full gate green (tsc, prettier --check src/, unit 160/1275): All four sub-claims reproduced with live command output. (1) pnpm-workspace.yaml:7 has `engineStrict: true` (added in commit 8d13fe4). A/B in scratch dir /tmp/ab3 using the SHIPPED pnpm-workspace.yaml + package.json + pnpm-lock.yaml under a real node v20.20.2 binary (downloaded from nodejs.org): A (engineStrict present) `pnpm install --frozen-lockfile` -> exit 1, 'Error: ERR_PNPM_UNSUPPORTED_ENGINE / Unsupported engine for @testing-library/jest-dom@7.0.1: wanted: {"node":">=22"} (current: {"node":"20.20.2"})'; B (engineStrict removed) same command -> exit 0, 'Done in 862ms using pnpm v12.4.2'. (2) repo-root .npmrc contains exactly `engine-strict=true`. npm A/B in /tmp/ab5 under node v20.20.2: WITH .npmrc -> `npm install` exit 1, 'npm error code EBADENGINE / engine Unsupported engine / Required: {"node":">=22"} / Actual: node v20.20.2'; WITHOUT .npmrc -> exit 0 with only non-fatal 'npm warn EBADENGINE', 'added 20 packages'. (3) Dockerfile:2 `FROM node:22-slim AS builder`, Dockerfile:14 `FROM node:22-slim`; Dockerfile.dev:2 `FROM node:22-slim` (all moved off node:20-slim in 8d13fe4). Live builds: `docker build -t duckbrain-ops005-test .` -> exit 0; `docker build -f Dockerfile.dev -t duckbrain-ops005-dev .` -> exit 0; `docker run --rm --entrypoint node <img> --version` -> v22.23.2 for BOTH images; `npm ci` inside the node:22-slim builder stage succeeded. (4) Full gate: `npx tsc --noEmit` -> exit 0 (no output); `npx prettier --check src/` -> exit 0, 'All matched files use Prettier code style!'; `npx vitest run` -> exit 0, 'Test Files 160 passed (160)' / 'Tests 1275 passed (1275)' — exactly the required 160/1275. No regression: shipped config on node 22 installs cleanly (exit 0).


Overall: PASS ✓
