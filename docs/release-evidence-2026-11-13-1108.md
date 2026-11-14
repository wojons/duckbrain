# DuckBrain release readiness — 2026-11-13

Candidate: dab23922a71ea02bf1fc93c01881b891f93258b8 (origin/main). Decision: NO CUT; proposed v1.2.0, subject to release preparation and re-gating.

Baseline v1.1.0 is annotated tag object 6def80e0f0ddfbed700819e25e99a08d7e0e58ca, peeled b65ba2e475c106c815d2baab4291983863616e55. Range contains 468 non-merge commits: 28 conventional feat, 39 fix, 4 perf, 397 other. No anchored BREAKING CHANGE footer or conventional type! subject found. This is a prefix census, not a full material-change census.

Exact-candidate GitHub CI run 43411530664 succeeded, including test and docker jobs. GitReins exact-candidate verdict not established. Latest tracked history inspected is older than candidate; do not substitute it for an exact-SHA judgment. QA-DUCKBRAIN-030 documents a clean-machine run against 1ddbb85e: native tests passed, CI/native cell failed the OPS-006 heartbeat timing criterion; act install failed, tracked separately in QA-DUCKBRAIN-017-R2. Its row cites a scratch artifact whose durability was not verified here.

Version blocker RELEASE-VERSION-001 remains live: package.json says 1.2.0; package-lock root and package entries, README badge, CLI help banner, and CI help assertion say 1.1.0. CHANGELOG 1.2.0 range preamble still says 379 non-merge, 28 feat, 35 fix, versus current 468/28/39. RELEASE-2026-11-09-001 tracks release note refresh and v1.1.0 missing Release-object decision. RELEASE-2026-10-26-001 has contradictory authorization wording; current releng policy grants minor cuts but that existing row requires reconciliation.

Release tooling: tag-triggered .github/workflows/release.yml and docs/release-artifact-scope.md; package.json and Dockerfile; no release script, Makefile release target, or GoReleaser found in tree inventory. Do not race the tag workflow with manual GitHub release creation. v1.2.0 tag absent at remote check; v1.1.0 tag exists but no GitHub Release, and tag CI 39539627477 failed Run tests. v1.0.0 Release exists with empty body and no assets. No package or image built or published in this no-cut pass; dependency audit not performed.

Live deployment: port 3000 health returned healthy. Installed CLI reports v1.2.0 but its launcher emitted a stale dist-versus-source warning; this does not establish the running server commit or its deployment freshness. Do not restart or rebuild the live service on this evidence.

Unblock: foreman resolves RELEASE-VERSION-001, refreshes release notes and range against the eventual candidate under RELEASE-2026-11-09-001, reconciles release authority wording, and re-runs exact-commit CI and release verification. No tag or release was created or moved in this pass.

## Pass 10 — 2026-11-14 11:15 scheduler tick

Decision: NO CUT. The candidate is `f494b924ba6a72b2e5db37ca12c5b4ef31ebfb52` on `origin/main`, with exact CI run `43589417317` completed successfully. The proposed bump remains minor `v1.2.0`; no major/breaking marker was found. No tag, GitHub Release, npm publish, Docker registry push, or existing-tag mutation was performed.

### Evidence table

| Gate | Evidence | Result |
| --- | --- | --- |
| Identity | GitHub `wojons/duckbrain`; canonical remote `origin=https://github.com/wojons/duckbrain.git`; forge default `main`; candidate and `origin/main` agree at `f494b924ba6a72b2e5db37ca12c5b4ef31ebfb52` | PASS |
| Baseline | Annotated `v1.1.0` object `6def80e0f0ddfbed700819e25e99a08d7e0e58ca`, peeled commit `b65ba2e475c106c815d2baab4291983863616e55`; unchanged | PASS |
| Change census | `v1.1.0..candidate`: 499 total, 479 non-merge; `feat=28`, `fix=39`, `perf=4`, `docs=27`, `chore=83`, `test=15`, `ci=4`, `style=1`, `other=278`; material `feat/fix/perf=71`; breaking declarations `0` | PASS — minor `v1.2.0` |
| Exact candidate CI | GitHub Actions run `43589417317`, push on `main`, completed/success; `test=success`, `docker=success`; check-runs `2`, check-suites `1` | PASS |
| Version surfaces | `package.json=1.2.0`; root `package-lock.json=1.1.0`; README badge, CLI help, MCP/API version literals still include `1.1.0` | BLOCKED — `RELEASE-VERSION-001` |
| CHANGELOG coverage | `[1.2.0]` section has 32 bullets but misses material commits `c915e31e`, `7c0d88e7`, `950a281b`, `0d1b9e53`; numeric range preamble still claims 397/379 rather than measured 499/479 | BLOCKED — `RELEASE-2026-11-09-001` |
| Release tooling | Authoritative publisher is tag-triggered `.github/workflows/release.yml`; no Makefile release target, `scripts/release*`, or GoReleaser. Workflow runs npm publish, but publication is credential/owner-gated; docs explicitly exclude manual npm and registry publication. Docker is local/operator-only | PASS — owned path identified |
| GitHub release surface | Remote tags are only `v1.0.0` and `v1.1.0`; only GitHub Release `v1.0.0` exists; `v1.1.0` has no Release object; `v1.2.0` absent | NO CUT |
| GitReins | No committed verdict evaluates the exact candidate; latest tracked verdicts are bound to older commits, including `0d43addb` and `3996f42b`; no candidate PASS is borrowed | UNVERIFIED / non-waiving |
| Dogfood/QA | Latest committed dogfood report `docs/dogfood/2026-11-14-cli-search-abort-and-fresh-install.md` is FAILED at `b5b97b34`: `search` aborts with rc=134; fresh-machine suite is 291/292 files and 2467/2468 tests; evidence is stale to the candidate and remains a known issue | FINDINGS / non-waiving |
| Deployed surface | `GET http://127.0.0.1:3000/health` HTTP 200, healthy embedding provider; endpoint exposes no loaded commit/source provenance; daemon PID 879548 started Nov 14 02:33 | UNMEASURED freshness |
| Local package/build probes | `pnpm pack --dry-run` produced package manifest for `duckbrain-1.2.0.tgz`; `pnpm docs:check` PASS. These are strategy evidence, not published assets; no registry push occurred | PASS / not published |
| Open posture | Board census: 2 P0, 30 P1, 40 P2, 18 P3, 4 P4, 2 P5 open. Release-specific blockers are `RELEASE-VERSION-001` and `RELEASE-2026-11-09-001`; current dogfood findings include `README-19-R3`, `README-23`, `DOC-25`, `DOGFOOD-032`, `DOGFOOD-033` | FINDINGS |

### Known issues

- `README-19-R3`: documented `duckbrain search` aborts with rc=134 / glibc heap assertion; workaround is HTTP search or CLI `remember`/`recall` until fixed.
- `DOGFOOD-033`: fresh-machine full suite failed 1 of 2468 tests under parallel load; isolated test passes, so reproducibility under clean-machine load remains open.
- `README-23`, `DOC-25`, and `DOGFOOD-032`: shipped example/config and CLI-output documentation defects remain open; use the corrected API shapes documented in the dogfood evidence.
- Deployed commit provenance is unavailable from `/health`; the running daemon cannot be certified against this candidate.

### Required unblock

1. Land `RELEASE-VERSION-001`: align package-lock, README, CLI/MCP/API version surfaces with `package.json=1.2.0`, then obtain new exact-SHA CI.
2. At the final candidate, update the `[1.2.0]` Range preamble and add citations for `c915e31e`, `7c0d88e7`, `950a281b`, and `0d1b9e53`; re-run the citation check and exact-SHA CI.
3. Reconcile the open `v1.1.0` Release-object decision in `RELEASE-2026-11-09-001`; do not move the immutable tag.
4. Re-run the final release checks, then use the repository-owned tag workflow. Verify the new tag, GitHub Release, Release notes, and tag-triggered workflow before delivery.
