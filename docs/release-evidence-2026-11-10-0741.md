# DuckBrain release readiness evidence — 2026-11-10 pass 6

Scheduler tick: `duckbrain-releng-2026-11-10-05-41-03`.
Target: `wojons/duckbrain`. Canonical repository: `/home/kara/duckbrain`.
Authoritative remote: `origin = https://github.com/wojons/duckbrain.git`. Default branch: `main`.

## Identity and certified candidate

The repository root, matched GitHub remote, and target repository agree. The candidate was fetched into a clean detached worktree:

- candidate: `9d9de8cd909d1d13db9b88192e1fb0f2bf87f04d`
- `origin/main`: same SHA
- `git ls-remote origin refs/heads/main`: same SHA
- exact CI: run `42772430719`, completed/success, workflow `CI`, event `push`; jobs `test` and `docker` both success
- local lane checkout was behind and carried a sibling's dirty `events.jsonl`; it was not used for release checks

Delta from the prior certified candidate `4e62f5e60da9fbc4f21eef15e595e6b7a0da8135` is three bookkeeping-only files: `.coding-hermes/board/events.jsonl`, `.coding-hermes/board/tasks.jsonl`, and `docs/release-evidence-2026-11-10-0541.md`. No product source path changed.

## Baseline and semver census

Baseline tag: `v1.1.0`, tag object `6def80e0f0ddfbed700819e25e99a08d7e0e58ca`, peeled commit `b65ba2e475c106c815d2baab4291983863616e55`. The remote tag is unchanged.

Range `v1.1.0..9d9de8cd`: 422 inclusive commits, 403 non-merge commits, and 167 commits after version-prep `1364dc4f` (164 non-merge). Conventional subject census over the inclusive range: `feat` 28, `fix` 35, `perf` 5, `docs` 23, `chore` 70, `test` 15, `ci` 3, other/board/releng/QA/PM/bookkeeping 243, total 422. No declared `BREAKING CHANGE` footer or `type!:` subject was found.

Semver proposal: `v1.2.0` minor. It is due by feature commits and does not require owner confirmation. `v1.2.0` is absent locally and remotely.

The `## [1.2.0]` section contains 32 product-visible entries and cites all 25 material non-merge commits in `1364dc4f..HEAD` (25/25, 0 missing). Its numeric preamble remains stale because it was intentionally not rewritten before the cut: it says 397/379/4/142 while the current candidate measures 422/403/5/167 for inclusive/non-merge/perf/post-prep totals. This is a cut-time refresh task, not a missing-coverage blocker.

## Release contract and prior artifacts

Repository-owned publication is `.github/workflows/release.yml`: an annotated `v*` tag triggers a workflow that verifies a successful `CI` push run on `main` for the exact tagged SHA, extracts the matching CHANGELOG section, and runs `gh release create --verify-tag`. No Makefile release target, `scripts/release*`, or GoReleaser configuration exists.

`docs/release-artifact-scope.md` defines the public release as the annotated Git tag, GitHub Release notes, and source tree. It explicitly excludes npm publication and container-registry pushes. A local Docker build is in scope as operator evidence only.

Existing release reality:

- `v1.0.0`: GitHub Release exists with an empty body and zero assets.
- `v1.1.0`: immutable remote tag exists, but `gh release view v1.1.0` reports not found. Its old tag workflow run `39539627477` and main push run `39539619427` both failed; the tag was not moved.
- `v1.2.0`: no tag and no Release object.

## Version hygiene blocker

The candidate still fails `RELEASE-VERSION-001`:

- `package.json`: `1.2.0`
- `README.md:3` version badge: `1.1.0`
- `.github/workflows/ci.yml:47`: hard-coded `DuckBrain v1.1.0 - AI Memory System`
- `src/cli/human.ts:2313`: help banner hard-coded to `DuckBrain v1.1.0 - AI Memory System`
- live candidate probe: `duckbrain --version` prints `duckbrain v1.2.0`, while `duckbrain help` prints `DuckBrain v1.1.0 - AI Memory System`

`pnpm docs:check` passed and its self-test passed, but the current docs checker does not check the README badge. This does not clear the row's acceptance criteria. Tagging now would publish a v1.2.0 artifact with contradictory identity, and the current CI assertion is green precisely because it asserts the stale value.

## Independent checks

- Repository CI run `42772430719`: green on the certified candidate; test and Docker jobs green, including lint, type check, CLI build, CLI E2E, full tests, integration tests, red-proof gate, and Docker build.
- GitReins: no committed verdict binds the candidate. The newest committed passing verdict is for ancestor `0d43addb`; this is an evidence gap, not a release-contract gate.
- Dogfood: latest committed record remains `PROMISING-BUT-ROUGH`; `DF-2026-21` records a legacy `/api/search` redirect that drops query and namespace, and the install leg is install-proven but isolation-unverified. The repository release scope does not make dogfood a publish gate.
- Local repository validators: `pnpm docs:check` PASS; `pnpm docs:check --self-test` PASS; `pnpm build:cli` PASS.
- Package strategy probe: `pnpm pack` PASS, producing `duckbrain-1.2.0.tgz` (SHA-256 `33ebd8f560650c6e361d955b9b21f79ad5b4045be306a99928f856dd46592b9c`). npm publication is explicitly out of scope.
- Docker strategy probe: `docker build --tag duckbrain:releng-9d9de8c .` PASS; local image digest `sha256:1991e544be23870998b8294dc40fff1fa8e7b7458ae18082abde65fd6ef2a868`. No registry push was performed.
- Deployed surface: `GET http://127.0.0.1:3000/health` reports `status: healthy` and embedding provider healthy, but exposes no loaded commit or stale field. Deployed freshness is UNMEASURED; `OBSDB-007` owns redeploy/provenance.
- Public posture: public, not archived, Apache-2.0; main branch protection API returns 404; GitHub `security_and_analysis` is null at this token scope; repository Actions secrets count is 0.
- Dependencies: `DEP-DUCKBRAIN-001` remains a pending P3 census of 23 outdated Node packages without an advisory-backed release blocker. No automatic dependency update was performed.

## Decision

**NO-GO — do not tag or create a GitHub Release in this pass.**

The minor release is due and releng-authorized, and exact-SHA CI is green. The cut is withheld because `RELEASE-VERSION-001` is still pending and the shipped CLI, README badge, and CI assertion disagree with `package.json`. The cut-time CHANGELOG numeric preamble also needs to be refreshed on the final tag candidate. No tag, Release object, force-move, npm publication, or registry push was performed. Existing `v1.1.0` remains unchanged.

Unblock sequence: land `RELEASE-VERSION-001`; re-fetch and re-certify the new green tip; refresh the CHANGELOG Range preamble at that final SHA; decide whether to back-fill `v1.1.0` or record the existing tag-only decision; then create `v1.2.0` and verify the Release body, immutable tag, and tag workflow.
