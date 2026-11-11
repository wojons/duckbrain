# DuckBrain release evidence — pass 9 (2026-11-11 11:17Z)

Satellite tick: `duckbrain-releng-2026-11-11-10-03-09`. Scope: verification only.
Decision: **NO-GO** — no tag, no Release object, no force-move; `v1.1.0` remains untouched.

Certified candidate: `ed8d7b3c8117c45e31f0ea5d2331faf9be3d5fa3`.

## Candidate and baseline

- Target remote: `origin=https://github.com/wojons/duckbrain.git` (`wojons/duckbrain`), default branch `main`.
- Canonical product root is `/home/kara/duckbrain`; the detached release worktree is clean at the fetched `origin/main` candidate.
- `git ls-remote origin refs/heads/main`, local `origin/main`, and the detached candidate all agree at `ed8d7b3c8117c45e31f0ea5d2331faf9be3d5fa3`. The owning checkout is behind by two commits and carries unrelated dirty board/gitreins/wave files; those were not used as candidate evidence.
- Baseline `v1.1.0` remains immutable: remote annotated tag object `6def80e0f0ddfbed700819e25e99a08d7e0e58ca`, peeled commit `b65ba2e475c106c815d2baab4291983863616e55`.
- Since pass-8 candidate `9cdf6d5d`, only two release-evidence/board bookkeeping commits landed: `43874011` and `ed8d7b3c`. No shipped-code path changed.

## Change census and semver

`v1.1.0..ed8d7b3c` contains 453 commits total and 434 non-merge commits (`git describe`: `v1.1.0-453-ged8d7b3c`). Conventional material prefixes are `feat=28`, `fix=38`, `perf=5`; no `type!:` subject or `BREAKING CHANGE` footer declaration was found. The proposed bump remains `v1.2.0` minor.

The post-prep range `1364dc4f..ed8d7b3c` contains 198 commits and 28 material `feat`/`fix`/`perf` commits. The `[1.2.0]` section cites 25/28; the three missing citations are `7c0d88e7` (storage malformed-line warning), `950a281b` (distinct `/api/keys` counts), and `0d1b9e53` (invalid config fails loudly). All three touch product source and tests, so this is a live release-notes blocker, not bookkeeping.

## Hosted CI

Exact candidate CI is green: run `43005825541`, workflow `CI`, event `push`, head SHA `ed8d7b3c8117c45e31f0ea5d2331faf9be3d5fa3`, completed/success. Jobs: `test=success` and `docker=success`. The test job's named steps, including clean install, type check, CLI E2E, tests, integration tests, and red-proof gate, all concluded success. Runs `43000417834`, `43000042042`, and `42992188387` were failures on their own older SHAs and are not inherited onto this candidate.

## Repository-owned release path and artifacts

The repository-owned publisher is `.github/workflows/release.yml`; it requires an annotated `v*` tag, verifies a successful main CI push run for the exact tagged commit, extracts the matching CHANGELOG section, and calls `gh release create --verify-tag`. No Makefile release target, `scripts/release*`, or GoReleaser config exists. `package.json`/`pnpm-lock.yaml` identify a Node/npm package and `Dockerfile` exists, but `docs/release-artifact-scope.md` explicitly excludes npm publication and registry pushes; Docker is local/operator-built only. No registry is configured. Prior local package/Docker build evidence is not reused as a candidate release gate.

Release objects: `gh release list --repo wojons/duckbrain` shows only `v1.0.0`; `gh release view v1.1.0` is not found. The `v1.1.0` tag has no Release object, and `v1.2.0` tag and Release are absent. No tag, Release, artifact publication, or force-move was performed.

## Version hygiene and deployed posture

Version hygiene remains blocked: `package.json=1.2.0`, but `package-lock.json` root/package version is `1.1.0`, the README badge is `1.1.0`, `.github/workflows/ci.yml` asserts `DuckBrain v1.1.0`, and `src/cli/human.ts` still prints `DuckBrain v1.1.0`. The open `RELEASE-VERSION-001` row remains live.

The live daemon `/health` returned HTTP 200 and healthy embedding status, but exposes no loaded commit or source provenance. The installed CLI reports `duckbrain v1.2.0` while warning that its `dist/` is stale relative to `src/`; this is a deployed/build staleness observation, not candidate artifact evidence. `OBSDB-007` owns deployed freshness.

## GitReins and dogfood

No stored all-green GitReins verdict is bound to candidate `ed8d7b3c`; newest stored passing verdicts are bound to older commits such as `0d43addb` and `3996f42b`. Current verdict evidence is therefore stale/degraded and not a candidate gate. Dogfood remains non-waiving repository evidence: the latest 2026-11-11 run is `DOES-NOT-DELIVER` due to the documented offline keyword fallback crashing the daemon, with `README-19-R2` open; its install leg later collected and teardown was verified, but isolation remained unverified. Other open posture rows include `QA-DUCKBRAIN-022`, `QA-DUCKBRAIN-028`, `PERF-DUCKBRAIN-002`, and `DF-0923-05-R2`. The repository's release contract does not make GitReins or dogfood approval a publication precondition, but these findings remain visible.

## Decision and unblock path

**NO-GO.** CI is green on the exact candidate, but release is blocked by two live readiness defects: version-surface drift (`RELEASE-VERSION-001`) and missing CHANGELOG citations for `7c0d88e7`, `950a281b`, and `0d1b9e53` (`RELEASE-2026-11-09-001`). The final cut also needs its numeric CHANGELOG Range preamble refreshed at the exact tag SHA. No release mutation was attempted.

Unblock in order: land the version-surface fix; add the three missing material SHA citations to `[1.2.0]`; at the final candidate SHA refresh the measured Range preamble; obtain exact-SHA CI success; then create and push annotated `v1.2.0` through the repository-owned workflow and verify the Release object/body and tag commit. Preserve `v1.1.0` unchanged.

## Evidence table

| Gate | Evidence | Result |
|---|---|---|
| Identity | `wojons/duckbrain`, candidate `ed8d7b3c`, remote/default branch agree | PASS |
| Baseline tag | `v1.1.0` object `6def80e0`, peeled `b65ba2e`; no move | PASS |
| Semver | 453 total / 434 non-merge; 28 feat / 38 fix / 5 perf; 0 breaking | PASS — v1.2.0 proposed |
| Exact candidate CI | Run `43005825541`; test and docker success | PASS |
| Version surfaces | package 1.2.0 vs lockfile/README/CI/help 1.1.0 | BLOCKED |
| CHANGELOG coverage | 25/28 post-prep material SHAs cited; three named misses | BLOCKED |
| GitReins | No candidate-bound all-green verdict | UNVERIFIED / non-waiving |
| Dogfood | Latest run DOES-NOT-DELIVER; README-19-R2 open | FINDINGS / non-waiving |
| Release object | Only v1.0.0 exists; v1.1.0 Release absent; v1.2.0 absent | BLOCKED until cut |
| Deployed provenance | `/health` healthy but no loaded-commit field; local CLI dist stale | UNMEASURED / STALE observation |

No board row was duplicated. The canonical follow-up rows remain `RELEASE-2026-11-09-001` and `RELEASE-VERSION-001`; this artifact is the pass-9 evidence receipt.
