# DuckBrain release readiness — 2026-11-13

Certified product candidate: b35a05b6a1072972f1b815cd4d15b55ae3d7be13, re-certified at the 2026-11-15 tip e1a0fae341ce69af0c2d7226429485558e940103 (59 top-level entries each; only .coding-hermes and docs differ, so no product path moved since the certification). Decision: NO CUT; proposed v1.2.0. Subsequent evidence/board carriers are not product candidates. Original November 13 measurement: dab23922a71ea02bf1fc93c01881b891f93258b8; retained historical sections below are superseded by Pass 15, the last section in this file.

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

## Pass 11 — 2026-11-14 11:15 scheduler tick (re-fire)

Carried, not re-decided. Decision remains **NO CUT** for `v1.2.0`, barred by the same two rows. No tag, GitHub Release, npm publish, image push, or tag mutation in this pass.

This tick id fired twice. Pass 10 measured candidate `f494b924ba6a72b2e5db37ca12c5b4ef31ebfb52` at 11:18–11:37Z; the scheduler then re-entered the same tick. The product tree did not move: `git diff --name-only f494b924..31515490` returns exactly three paths, all release bookkeeping — `docs/release-evidence-2026-11-13-1108.md`, `.coding-hermes/board/tasks.jsonl`, `.coding-hermes/board/events.jsonl`. Excluding those, **0 product paths differ**.

### Delta evidence table

| Gate | Re-measured at `31515490` | Result |
| --- | --- | --- |
| Candidate | `31515490e24d0ad049b9f8f4abba4d08a4de90bf` == `origin/main` == `origin/HEAD`; forge default `main`; `wojons/duckbrain` | PASS |
| Exact carrier CI | GitHub Actions run `43590915580`, push on `main`, completed/success; `test=success`, `docker=success` | PASS |
| Change census `v1.1.0..tip` | 503 total, 483 non-merge; `feat=28`, `fix=39`, `perf=4` → material 71; breaking declarations 0, `type!:` subjects 0 | PASS — minor `v1.2.0` |
| Version surfaces | `package.json=1.2.0`; `package-lock.json` root and `packages[""]` both `1.1.0`; README badge `1.1.0`; installed CLI `duckbrain --help` prints `DuckBrain v1.1.0`; shipped `1.1.0` literals at `bin/duckbrain.ts:48`, `src/cli/human.ts:2364`, `src/mcp/server.ts:58`, `src/http/routes/tables.ts:1043`, `src/ssh/client.ts:51`, and a pinned assertion in `src/http/metrics.test.ts:121,193` | BLOCKED — `RELEASE-VERSION-001` |
| CHANGELOG coverage | `[1.2.0]` still has exactly 32 bullets. Preamble still claims `397 commits (379 non-merge; 28 feat, 35 fix, 4 perf)` against measured 503/483 (28/39/4), and `1364dc4f..HEAD` as 142/140/25 against measured 248/29. None of `c915e31e`, `7c0d88e7`, `950a281b`, `0d1b9e53` is cited by SHA or by its own finding id (`INT-CI-027`, `QA-DUCKBRAIN-022`, `-023`, `-021`), which is the citation class this section actually uses | BLOCKED — `RELEASE-2026-11-09-001` |
| Publisher path | Tag-push `.github/workflows/release.yml` only. It refuses unless the tagged commit's `main` push run concluded success, requires `GITHUB_REF_NAME == v$(package.json version)`, builds Release notes by extracting the `[X.Y.Z]` CHANGELOG section verbatim, and refuses when the Release already exists. Still no `scripts/release*`, Makefile release target, or GoReleaser | PASS — owned path |
| Release surface | `git ls-remote` tags: `v1.0.0`, `v1.1.0` only; `gh release list` returns `v1.0.0` only; `v1.2.0` absent; `v1.1.0` still has no Release object | NO CUT |
| Deployed surface | `duckbrain-http.service` listener PID `879548`, started 2026-11-14 02:33:34 -05, `GET http://127.0.0.1:3000/health` → 200 `healthy`; no loaded-commit field in the payload, so freshness against `31515490` stays UNMEASURED | UNMEASURED |
| Open rows | 96 non-terminal: `pending=85`, `in_progress=6`, `blocked=5`; priority 2 P0 / 30 P1 / 40 P2 / 18 P3 / 4 P4 / 2 P5 — identical to Pass 10 | CARRIED |

### Why the blocker matters more than the pass count

`release.yml` derives the Release body from the `[1.2.0]` section, so the stale numeric preamble ships verbatim to end users on every cut until `RELEASE-2026-11-09-001` lands. The preamble is structurally unable to stay true: it is a fixed snapshot that no commit refreshes, so it drifts on every subsequent commit — 106 commits and 4 material fixes of drift since it was written.

### Lane note

Two passes 20 minutes apart on a byte-identical product tree produce no new release information. The lane's `cooldown_s` is 86400, so a second entry for the same tick id is a scheduler re-entry rather than cadence. Gating this lane on a material product commit (or on an owner ruling for `RELEASE-VERSION-001` / `RELEASE-2026-11-09-001`) would be worth more than another scheduled sweep over bookkeeping-only commits.

### Unchanged required unblock

No new row was filed; both blockers remain owned. (1) `RELEASE-VERSION-001` aligns `package-lock.json`, README badge, CLI banner, MCP/API `version` literals and the pinned test assertion to `1.2.0` — classify `src/ssh/client.ts:51 CURRENT_VERSION` first, since it may be a protocol constant rather than the package version. (2) `RELEASE-2026-11-09-001` rewrites the `[1.2.0]` preamble to the measured range and cites the four post-prep material fixes. Then obtain exact-SHA CI on the new tip and cut through the repository-owned tag workflow.

## Pass 12 — 2026-11-14 12:05 UTC scheduler tick

Decision: NO CUT. Candidate `b35a05b6a1072972f1b815cd4d15b55ae3d7be13` is `origin/main`; this is a carried product tree relative to pass 11 because the only intervening non-board/non-gitreins path is the dogfood log. The proposed bump remains minor `v1.2.0`; no breaking subject or `BREAKING CHANGE` footer was found. No tag, Release, npm publish, Docker registry push, or existing-tag mutation was performed.

### Evidence table

| Gate | Evidence | Result |
| --- | --- | --- |
| Identity | Canonical release remote `origin=https://github.com/wojons/duckbrain.git`; GitHub `wojons/duckbrain`; forge default `main`; local `HEAD` and `origin/main` both `b35a05b6a1072972f1b815cd4d15b55ae3d7be13` | PASS |
| Baseline | Remote `v1.1.0` tag object `6def80e0f0ddfbed700819e25e99a08d7e0e58ca`, peeled commit `b65ba2e475c106c815d2baab4291983863616e55`; unchanged; `v1.2.0` absent | PASS |
| Change census | `v1.1.0..candidate`: 505 total / 485 non-merge; `feat=28`, `fix=39`, `perf=4`, `docs=28`, `chore=83`, `test=15`, `ci=4`, `style=1`, `other=283`; material `feat/fix/perf=71`; `type!` subjects 0; `BREAKING CHANGE` footers 0 | PASS — minor `v1.2.0` |
| Exact candidate CI | GitHub Actions CI run `43592606330`, push on `main`, completed `success`; test job `132440352679` success and docker job `132441104354` success; exact head SHA matches candidate | PASS |
| Version surfaces | `package.json=1.2.0`; root `package-lock.json` and its root package entry `1.1.0`; README badge `1.1.0`; CI help assertion and CLI help, MCP/API, tables, and SSH version literals still include `1.1.0` | BLOCKED — `RELEASE-VERSION-001` |
| CHANGELOG coverage | `[1.2.0]` remains 32 bullets; numeric preamble remains stale (`397/379`, `28/35/4`, post-prep `142/140/25` versus current `505/485`, `28/39/4`, post-prep `248/29`); cited material gaps remain `c915e31e`, `7c0d88e7`, `950a281b`, `0d1b9e53` | BLOCKED — `RELEASE-2026-11-09-001` |
| Release tooling | Repository-owned publisher is tag-triggered `.github/workflows/release.yml`; no Makefile release target, `scripts/release*`, or GoReleaser. The workflow builds and attempts npm publish using `NPM_TOKEN`, then creates the GitHub Release; Docker is local/operator-only and no registry is configured | PASS — owned path identified |
| Release surface | Remote tags are only `v1.0.0` and `v1.1.0`; only GitHub Release `v1.0.0` exists; `gh release view v1.1.0` returns not found; `v1.2.0` absent | NO CUT |
| GitReins | Latest exact-candidate verdict is not present. The newest available PASS is `b4a8cff9` for `INT-CI-027-R2`, evaluated at `fe22d731`; other recent verdicts are bound to older SHAs. No candidate-bound verdict is borrowed | UNVERIFIED / non-waiving |
| Dogfood/QA | Current dogfood log records FAILED release-relevant findings at the current campaign: concurrent CLI search failed `12/14` parallel invocations while `5/5` sequential passed; CI-pass act leg failed in `9.98s`; teardown required a forced retry. Hosted CI is independently green. Findings are tracked by `QA-DUCKBRAIN-033/034/035/036` and `README-19-R4` | FINDINGS / non-waiving |
| Deployed surface | `duckbrain-http.service` PID `879548`, started `2026-11-14 02:33:35 -05`; `/health` returned HTTP 200 healthy at `2026-11-14T12:05:19Z`, but the payload exposes no loaded commit/source provenance | UNMEASURED freshness |
| Board posture | Remote board has 90 pending, 6 in_progress, and 5 blocked rows; release rows `RELEASE-2026-10-26-001`, `RELEASE-2026-11-01-001`, `RELEASE-2026-11-09-001`, and `RELEASE-VERSION-001` remain non-terminal | FINDINGS |

### Known issues

- `RELEASE-VERSION-001`: version surfaces still disagree, so a v1.2.0 artifact would not have one reliable self-identifying version.
- `RELEASE-2026-11-09-001`: release notes still carry a stale range preamble and four uncited material fixes; `release.yml` publishes this section verbatim.
- `QA-DUCKBRAIN-033` / `README-19-R4`: concurrent CLI search is not reliable; 12 of 14 parallel invocations failed while sequential probes passed.
- `QA-DUCKBRAIN-035`: the clean-machine `act` leg failed during install with no inner error text; the cell is not a hosted-CI substitute.
- `QA-DUCKBRAIN-034`: bunker teardown needed a forced retry; the captured logs were preserved, but teardown automation remains a QA finding.
- Deployed commit provenance is unavailable from `/health`; the running daemon cannot be certified against this candidate.

### Required unblock

1. Land `RELEASE-VERSION-001`, re-run exact-SHA CI, and verify the version-surface drift is gone.
2. At the final candidate, refresh the `[1.2.0]` numeric preamble and add the four missing material citations, then re-run the citation check and exact-SHA CI.
3. Reconcile the open v1.1.0 Release-object decision without moving the immutable `v1.1.0` tag.
4. After all gates are green, use the repository-owned tag workflow; verify the tag, GitHub Release, npm publication result, Release notes, and tag-triggered workflow.

No tag, Release object, registry push, or existing-tag mutation was performed in this pass.


## Pass 13 — 2026-11-14 13:18 UTC scheduler tick

Decision: NO CUT. The product candidate remains `b35a05b6a1072972f1b815cd4d15b55ae3d7be13`; the current `origin/main` tip is `6940179f08e2727e25f79bdd2662e1e60819909e`, and the 11 intervening paths are only board/evidence bookkeeping (`.coding-hermes/board/events.jsonl`, `.coding-hermes/board/tasks.jsonl`, `docs/release-evidence-2026-11-13-1108.md`). The product tree therefore carries from the prior certification. The proposed bump remains minor `v1.2.0`; no breaking subject or `BREAKING CHANGE` footer was found. No tag, Release, npm publish, Docker registry push, or existing-tag mutation was performed.

### Evidence table

| Gate | Evidence | Result |
| --- | --- | --- |
| Identity | Canonical release remote `origin=https://github.com/wojons/duckbrain.git`; GitHub `wojons/duckbrain`; forge default `main`; product candidate `b35a05b6a1072972f1b815cd4d15b55ae3d7be13`; current carrier tip `6940179f08e2727e25f79bdd2662e1e60819909e` | PASS — candidate carried |
| Baseline | Remote annotated `v1.1.0` tag object `6def80e0f0ddfbed700819e25e99a08d7e0e58ca`, peeled commit `b65ba2e475c106c815d2baab4291983863616e55`; remote tags remain only `v1.0.0` and `v1.1.0`; `v1.2.0` absent | PASS — immutable baseline |
| Change census | `v1.1.0..6940179f`: 516 total / 496 non-merge; classes: `feat=28`, `fix=39`, `perf=4`, `docs=30`, `chore=83`, `test=15`, `ci=4`, `style=1`, `other=292`; material prefix count `feat/fix/perf=71`; breaking subjects `0`; `BREAKING CHANGE` footers `0`. The 11-commit movement from b35 to 694 changes no product source paths | PASS — minor `v1.2.0` remains proposed |
| Exact candidate CI | GitHub Actions CI run `43592606330`, exact product candidate `b35a05b6a1072972f1b815cd4d15b55ae3d7be13`, completed `success`; test job `132440352679` and docker job `132441104354` both success. Current board/evidence carrier `6940179f08e2727e25f79bdd2662e1e60819909e` has separate CI run `43597526076`, completed `success`, with check-runs `2` and check-suites `1` | PASS — candidate and carrier separately bound |
| Version surfaces | `package.json=1.2.0`; root `package-lock.json` and root package entry `1.1.0`; README badge `1.1.0`; CI help assertion, `bin/duckbrain.ts`, `src/cli/human.ts`, MCP/API, tables, SSH, and metrics test literals still include `1.1.0` | BLOCKED — `RELEASE-VERSION-001` |
| CHANGELOG coverage | `[1.2.0]` has 32 bullets. Numeric preamble still says `397/379` and `28/35/4`; measured at the carried product candidate is `505/485` and `28/39/4`. Four post-prep material commits remain uncited: `c915e31e` (`INT-CI-027-R2`), `7c0d88e7` (`QA-DUCKBRAIN-022`), `950a281b` (`QA-DUCKBRAIN-023`), and `0d1b9e53` (`QA-DUCKBRAIN-021`). The current carrier re-measurement is `516/496`, with the same product candidate and no product-path change | BLOCKED — `RELEASE-2026-11-09-001` |
| Release tooling | Repository-owned publisher is tag-triggered `.github/workflows/release.yml`; no Makefile release target, `scripts/release*`, or GoReleaser. It requires exact main CI success, matching `package.json` version, then runs `npm publish` using `NPM_TOKEN` before `gh release create`; `gh secret list` reports zero repository secrets. Dockerfile exists but no registry publish is configured; `pnpm run build:cli`, `pnpm pack --dry-run` (`duckbrain-1.2.0.tgz`), and `pnpm docs:check` all passed in a detached checkout, but no artifact was published | BLOCKED for publish — npm credential absent |
| GitReins | No committed verdict evaluates exact product candidate `b35a05b6a1072972f1b815cd4d15b55ae3d7be13` or current carrier `6940179f08e2727e25f79bdd2662e1e60819909e`; latest inspected PASS records are bound to older commits | UNVERIFIED / non-waiving |
| Dogfood/QA | Latest committed dogfood report `docs/dogfood/2026-11-14-cli-search-abort-and-fresh-install.md` targets `b5b97b344b8eaef219312dd1e250e7b05b61a2bf`: CLI `search` aborts `rc=134` with a glibc heap assertion; clean-machine tests are `291/292` files and `2467/2468` tests; parallel search and harness findings remain tracked by `QA-DUCKBRAIN-033/034/035/036` and `README-19-R4` | FINDINGS / non-waiving |
| Deployed surface | `duckbrain-http.service` PID `879548`, started `2026-11-14 02:33:35 -05`; `/health` returned healthy, but payload has no loaded commit/source provenance (`commit`, `commitSha`, `sourceRevision` all null) | UNMEASURED freshness |
| Release surface | `gh release list` shows only `v1.0.0`; `gh release view v1.1.0` and `v1.2.0` both report not found; `v1.0.0` has zero assets and an empty body. Remote `v1.1.0` remains unchanged | NO CUT |
| Board posture | Remote board distribution is `pending=90`, `in_progress=6`, `blocked=5`, `complete=487`; release rows `RELEASE-2026-10-26-001`, `RELEASE-2026-11-01-001`, `RELEASE-2026-11-09-001`, and `RELEASE-VERSION-001` remain non-terminal | FINDINGS |

### Known issues

- `RELEASE-VERSION-001`: package metadata is `1.2.0` while shipped version surfaces and the CI help assertion still say `1.1.0`; a v1.2.0 artifact would self-identify inconsistently.
- `RELEASE-2026-11-09-001`: `release.yml` publishes the stale `[1.2.0]` section verbatim; its numeric range and four material citations remain uncorrected.
- `README-19-R4` / `QA-DUCKBRAIN-033`: concurrent CLI search is unreliable; the dogfood campaign recorded 12/14 parallel failures while sequential probes passed.
- `DOGFOOD-033`: the fresh-machine suite failed 1 of 2468 tests under parallel load; isolated execution passed.
- `QA-DUCKBRAIN-035` and `QA-DUCKBRAIN-034`: the local `act` install leg is not a hosted-CI substitute, and bunker teardown required a forced retry.
- Deployed commit provenance is unavailable from `/health`; the running daemon cannot be certified against this candidate.

### Required unblock

1. Land `RELEASE-VERSION-001`, then obtain new exact-SHA CI on the resulting tip.
2. At the final candidate, refresh the `[1.2.0]` preamble and add the four missing material citations; rerun the citation check and exact-SHA CI.
3. Resolve npm publication authorization/credentials or make the repository-owned workflow's intended artifact scope executable; the current workflow cannot complete with zero repository secrets.
4. After those gates are green, use the repository-owned tag workflow and verify the remote tag, tag CI, GitHub Release, notes, and publication result. Do not move `v1.1.0`.

No tag, Release object, npm publish, Docker push, or existing-tag mutation was performed in this pass.

## Pass 14 — 2026-11-14 13:44 UTC scheduler tick (re-fire of `duckbrain-releng-2026-11-14-11-15-29`)

Decision: NO CUT — and this pass carries the first CI red on the release tip. The product candidate remains `b35a05b6a1072972f1b815cd4d15b55ae3d7be13`; `origin/main` is now `0e855e40` (board record of pass 13) via `33de38cf` (pass-13 evidence). `git diff --name-only b35a05b6 0e855e40` yields exactly three bookkeeping paths (`.coding-hermes/board/events.jsonl`, `.coding-hermes/board/tasks.jsonl`, `docs/release-evidence-2026-11-13-1108.md`), so the product tree still carries from certification. No tag, Release, npm publish, Docker push, or existing-tag mutation was performed.

### Evidence table

| Gate | Evidence | Result |
| --- | --- | --- |
| Identity | Canonical remote `origin=https://github.com/wojons/duckbrain.git`; GitHub `wojons/duckbrain`; default `main`; product candidate `b35a05b6`; carrier tip `0e855e40` | PASS — candidate carried |
| Baseline | Remote tags remain only `v1.0.0` and `v1.1.0`; `v1.1.0` object `6def80e0f0ddfbed700819e25e99a08d7e0e58ca` unchanged; `v1.2.0` absent | PASS — immutable baseline |
| Change census | `v1.1.0..0e855e40`: 518 total / 498 non-merge; non-merge classes `chore=83`, `fix=39`, `docs=31`, `feat=28`, `test=15`, `perf=4`, `ci=4`, `style=1`, `revert=1`; breaking subjects `0`; `BREAKING CHANGE` footers `0` | PASS — minor `v1.2.0` remains proposed |
| Exact candidate CI | Product candidate `b35a05b6` run `43592606330` success (test `132440352679`, docker `132441104354`) — unchanged from pass 13 | PASS — candidate receipt valid |
| Carrier CI on tip | `33de38cf` run `43599598086` **failure**; `0e855e40` run `43599849297` **failure**. Both: `Test Files 292 passed (292)`, `Tests 2468 passed (2468)`, `Errors 1 error`, exit 1 — an unhandled teardown error originating in `src/cli/http-cors-example-app-001.test.ts` (`EnvironmentTeardownError: [vitest-worker]: Closing rpc while "onUserConsoleLog" was pending` at 33de38cf; `Error: ENOTEMPTY: directory not empty, rmdir '/tmp/cors-example-app-jELn1A/taskboard/.git'` at 0e855e40). Previous green carrier receipt was `6940179f` run `43597526076` | **RED — cut gate closed** |
| Release-workflow consequence | `release.yml` step 1 requires the tagged sha's push-to-main CI run conclusion `== success`; a tag pushed on a red/intermittent tip fails there before notes or publish, so the cut cannot be certified while this recurs | BLOCKED |
| Version surfaces | `package.json=1.2.0` (and live `duckbrain --version` prints `v1.2.0`) vs `README.md:3` badge `1.1.0`, `src/mcp/server.ts:58` `1.1.0`, `src/ssh/client.ts:51` `CURRENT_VERSION="1.1.0"`, `src/http/routes/tables.ts:1043` `1.1.0` (plus `src/http/metrics.test.ts:121,193`) | BLOCKED — `RELEASE-VERSION-001` |
| CHANGELOG coverage | `[1.2.0]` preamble still claims `397` commits / `379` non-merge / `28 feat` / `35 fix` / `4 perf`; measured at `0e855e40` is `518` / `498` / `28` / `39` / `4`. Four material commits remain uncited: `c915e31e`, `7c0d88e7`, `950a281b`, `0d1b9e53` | BLOCKED — `RELEASE-2026-11-09-001` |
| Release tooling | Repository-owned publisher is tag-triggered `.github/workflows/release.yml` (no Makefile target, `scripts/release*`, or GoReleaser). CI workflow triggers on push to `main`/`develop` only; `release.yml` triggers on `v*` tags; `gh secret list --repo wojons/duckbrain` returns zero secrets, so its `npm publish` step cannot authenticate | BLOCKED for publish — credential absent, owner-gated |
| GitReins | Newest committed verdict `.gitreins/history/2026-11-14/b4a8cff9/verdict.json` binds task `INT-CI-027-R2` to commit `fe22d731` — neither the candidate `b35a05b6` nor the tip `0e855e40` | UNVERIFIED / non-waiving |
| Dogfood/QA | Latest committed dogfood report still targets `b5b97b34`; `QA-DUCKBRAIN-033/034/035/036` and `README-19-R4` remain open | FINDINGS / non-waiving |
| Deployed surface | PID `879548` started `2026-11-14 02:33:34 -05`, cwd `/home/kara/duckbrain`, entry `bin/duckbrain.js` mtime `2026-11-06 23:21`, `dist/bin/duckbrain.js` mtime `2026-11-13 23:25`; `/health` payload carries no `commit`/`commitSha`/`sourceRevision` | UNMEASURED freshness |
| Release surface | `gh release list` shows only `v1.0.0`; `gh release view v1.1.0` → "release not found" | NO CUT |

### New blocking finding

`TESTQ-2026-11-13-1` (P2, pending) describes exactly this defect — `http-cors-example-app-001.test.ts` dying at suite teardown — first observed at `253f31da` (run `43415616493`). It has now recurred on two consecutive tips (`33de38cf`, `0e855e40`) whose only changed paths are bookkeeping, which rules out content causation and makes the test's teardown race the sole reason CI is red on `main`. Because `release.yml` refuses to publish without a green push-to-main run on the tagged sha, this P2 row is presently the hard gate on an owner-authorized v1.2.0 cut and should be escalated to P1 and dispatched before any further cut prep. Fix hint for the foreman: the suite removes its temporary `taskboard/.git` while a spawned git child can still be writing into it, and the worker RPC can still be logging at close — the teardown needs to await child exit and use a retrying recursive force-remove rather than a bare `rmdir`.

### Required unblock (ordered, supersedes the pass-13 list)

1. Fix the `http-cors-example-app-001` teardown race (`TESTQ-2026-11-13-1`) and obtain a green push-to-main CI run on the resulting tip.
2. Land `RELEASE-VERSION-001` (four stale surfaces above), then obtain new exact-SHA CI on the resulting tip.
3. At the final candidate, refresh the `[1.2.0]` preamble and add the four missing material citations; rerun the citation check and exact-SHA CI.
4. Resolve npm publication authorization/credentials, or record that the repository-owned workflow's publish scope is intentionally owner-gated.
5. Only then tag through the repository-owned workflow; verify remote tag, tag CI, Release, notes, and publication. Never move `v1.1.0`.

Side effect disclosed: this pass fast-forwarded the canonical checkout onto `origin/main` and landed an orphaned unpushed board-only QA commit (originally `24ca0eb2`, rebased to `59f8149d`, annotating `DOGFOOD-033` and `QA-DUCKBRAIN-017-R2`) so the board write could proceed on a tip that matches the remote.

### Pass 14 addendum — CI intermittency correction (same tick, after push)

The carrier CI reading above is red at `33de38cf` and `0e855e40` but NOT a stable red. Four consecutive push-to-main runs on `main`:

| Commit | Run | Conclusion |
| --- | --- | --- |
| `33de38cf` | `43599598086` | failure — `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending` (`http-cors-example-app-001.test.ts`) |
| `0e855e40` | `43599849297` | failure — `ENOTEMPTY: directory not empty, rmdir '/tmp/cors-example-app-jELn1A/taskboard/.git'` (same file) |
| `9a170af5` | `43600750621` | success — `test` + `docker` |
| `f2235e6b` (this pass's board commit) | `43601139600` | success — `test` + `docker` |

So the defect is intermittent: two consecutive reds followed by two greens, with 2468/2468 tests passing in every run and failure isolated to the same suite's teardown. This does not soften the cut gate — it sharpens it. `release.yml` hard-fails when the tagged sha's push-to-main run is not `success`, so a green reading at tag time is luck rather than certification, and a red tag run would abort the release mid-flight. `TESTQ-2026-11-13-1` therefore remains a cut gate (recommend P1) but is now correctly characterized as a flaky teardown, not a broken main.



## Pass 15 — 2026-11-15 12:18 UTC scheduler tick (re-fire of `duckbrain-releng-2026-11-15-12-18-45`)

Decision: **NO CUT**. Proposed bump unchanged: **minor `v1.2.0`**. This pass re-measured everything at the current tip instead of carrying pass 14's readings; it did not create a second readiness row (the same tick id's earlier fire already filed `RELEASE-2026-11-15-001`, `RELEASE-2026-11-15-002` and refreshed `RELEASE-VERSION-001`).

### Evidence table

| Gate | Evidence | Result |
| --- | --- | --- |
| Identity | GitHub `wojons/duckbrain` (public); release remote `origin=https://github.com/wojons/duckbrain.git`; forge default branch `main`; `HEAD == origin/main == ls-remote` at `e1a0fae341ce69af0c2d7226429485558e940103` | PASS |
| Baseline | Annotated tag object `6def80e0f0ddfbed700819e25e99a08d7e0e58ca`, peeled `b65ba2e475c106c815d2baab4291983863616e55`; unchanged | PASS |
| Product identity | Certified product candidate `b35a05b6` vs tip `e1a0fae3`: 59 top-level entries each, only `.coding-hermes` and `docs` differ; `src/`, `bin/`, `package.json`, `scripts/`, `.github/` byte-identical (last product commit touching `src/` or `bin/` is `c915e31e`, 2026-11-12) | PASS — product tree carried |
| Change census | `v1.1.0..e1a0fae3`: **516 non-merge**, 485 conventional, 31 non-conventional. `feat=28`, `fix=39`, `perf=9`, `docs=31`, `chore=83`, `test=15`, `ci=4`, `board=215`, `dogfood=13`, `releng=10`, `qa=7`, `qa-cron=6`, `tables=5`, `pm=5`, `evidence=4`, `ops=4`, plus 6 one-off types (style, revert, cleanup, foreman, gitreins, supervisor, wip). Material `feat+fix+perf=76`; `!` subjects `0`; line-start `BREAKING CHANGE` footers `0` | PASS — minor `v1.2.0` |
| Exact candidate CI | GitHub Actions run `43714546414`, `push` on `main`, `completed/success` at `e1a0fae3`; job `test=success`, job `docker=success` | PASS |
| CI stability | Last red is run `43681602671` at `6dffd705` (2026-11-15T05:33:40Z): job `test` failed at step "Run tests", job `docker` skipped. Seven consecutive push-to-main successes follow it (06:04Z → 12:34Z). The failing test case for that red is **UNVERIFIED this pass** — `gh run view --log-failed` returned 0 bytes; `TESTQ-2026-11-13-1` (P2, pending) remains the tracking row for the `http-cors-example-app-001` teardown flake | PASS at tip / flake row open |
| Release channel | `gh release list` returns only `v1.0.0`. Tag `v1.1.0` (`b65ba2e4`) still has **no Release object**; `v1.2.0` absent locally and remotely; remote tags are only `v1.0.0`, `v1.1.0` | NO CUT |
| npm channel | `npm view duckbrain` → `E404 Not Found` from `registry.npmjs.org`: the package has **never been published**, so any publish is a **first publication** on that distribution channel and needs explicit owner confirmation | BLOCKED — `RELEASE-2026-11-15-001` |
| Publish credentials | `gh api repos/wojons/duckbrain/actions/secrets --jq .total_count` → `0`. `release.yml` orders: verify tagged commit's CI → pnpm build:cli → `npm publish` with `NODE_AUTH_TOKEN=secrets.NPM_TOKEN` → notes → `gh release create`. With zero secrets the publish step dies **after the tag is already public**, and the Release object is never created — exactly the orphan state `v1.1.0` is in | BLOCKED — `RELEASE-2026-11-15-001` |
| Version surfaces | `package.json` `1.2.0`; stale `1.1.0` literals at `src/cli/human.ts:2364` and `bin/duckbrain.ts:48`; README badge `README.md:3` says `1.1.0`; CI asserts the stale banner at `.github/workflows/ci.yml:47`. Live: `node bin/duckbrain.js help` prints `DuckBrain v1.1.0 - AI Memory System` while `--version` prints `duckbrain v1.2.0` | BLOCKED — `RELEASE-VERSION-001` |
| CHANGELOG | `[1.2.0] - 2026-11-03` section exists at line 7 and is what `release.yml` slurps verbatim as the Release body, but its preamble claims 397 commits / 379 non-merge / 28 `feat` / 35 `fix` / 4 `perf` / 67 material, against measured 516 non-merge / 28 / 39 / 9 / 76 at this candidate | BLOCKED — `RELEASE-2026-11-15-002` |
| Release tooling | Owned path is tag-triggered `.github/workflows/release.yml` (no Makefile release target, no `scripts/release*`, no GoReleaser). It refuses a tag whose tagged-SHA main run is not `success`, refuses a tag that does not equal `package.json` version, and refuses an existing Release | PASS — owned path identified |
| GitReins | Newest tracked verdict `.gitreins/history/2026-11-14/b4a8cff9/verdict.json` is task-bound to commit `fe22d731` (tier1 PASS, tier2 PASS) — **not** the candidate. No candidate-bound verdict exists; nothing borrowed | UNVERIFIED / non-waiving |
| Dogfood / QA | No candidate-bound clean-machine battery this pass. Open findings on the board: `DOGFOOD-033` (P2, fresh-machine suite RED — realtime-fanout heartbeat), `QA-DUCKBRAIN-033` (P2, 12/14 concurrent CLI calls fail), `QA-DUCKBRAIN-037` (P2, production `docker compose up` false-green), `QA-DUCKBRAIN-032`/`-036` (P3) | FINDINGS / non-waiving |
| Deployed surface | `duckbrain-http.service`, PID `879548`, started 2026-11-14 02:33:34 -05; `GET http://127.0.0.1:3000/health` → 200, `status=healthy`, embedding provider healthy. `/health` exposes no loaded commit, so freshness versus this candidate is UNMEASURED (do not restart on this evidence). Installed CLI `/home/kara/.hermes/node/bin/duckbrain --version` → `v1.2.0` | UNMEASURED freshness |
| Posture | Public GitHub repo, forge default `main`. No credential or secret material was read beyond the Actions-secret **count** | PASS |

### Blocker classes (this pass)

| Class | Count | Items |
| --- | --- | --- |
| Owner gate + credential (first publication) | 1 | npm channel never published (registry 404) and repository has 0 Actions secrets → `NPM_TOKEN` absent → tag push produces a public orphan tag. `RELEASE-2026-11-15-001` |
| Product defect open on the candidate tree | 1 | Version surfaces still say `1.1.0` while `package.json` says `1.2.0`, and CI pins the stale string. `RELEASE-VERSION-001` |
| Prep / evidence debt | 2 | CHANGELOG `[1.2.0]` numeric preamble stale by 119 commits (`RELEASE-2026-11-15-002`); no candidate-bound GitReins verdict or clean-machine battery |
| Flake gate | 1 | `TESTQ-2026-11-13-1` — `http-cors-example-app-001` teardown flake; `release.yml` has no retry, so a red tag run aborts the release mid-flight |
| Premise falsified | 0 | — |

### Known issues that must ship in any future release notes

- `DOGFOOD-033` — fresh-machine full suite is RED (`realtime-fanout` heartbeat under load); workaround: run the suite on a quiet host.
- `QA-DUCKBRAIN-033` — the documented CLI cannot be used concurrently (12 of 14 parallel invocations fail); workaround: one CLI process at a time.
- `QA-DUCKBRAIN-037` — production `docker compose up` is a false-green first run.
- `DOGFOOD-032` — CLI verbs pollute stdout with internal debug lines (`[duckbrain] Cleared stale DuckDB connections`).
- `QA-DUCKBRAIN-036` — `duckbrain recall --limit` is silently ignored.
- `DOGFOOD-033`/`TESTQ-2026-11-13-1` — release CI can red on an unrelated suite teardown.

### Required unblock (ordered)

1. `RELEASE-VERSION-001` — fix the four stale `1.1.0` surfaces (CLI help literal in both `src/cli/human.ts:2364` and `bin/duckbrain.ts:48`, README badge, and the `ci.yml:47` assertion that pins the stale banner), then obtain a fresh exact-SHA CI run on the resulting tip.
2. `RELEASE-2026-11-15-002` — re-state the `[1.2.0]` preamble at the cut SHA and normalize `package.json` `bin` (`npm pkg fix`) so the published tarball is not silently rewritten.
3. Owner — mint an npm automation token with publish rights on the unscoped public package `duckbrain`, add it as the `NPM_TOKEN` repository secret, and state first-publication approval. **Without this, pushing a `v1.2.0` tag publishes a public tag and fails the release**, leaving the same orphan the repo already carries for `v1.1.0`.
4. Fix or accept `TESTQ-2026-11-13-1`; `release.yml` hard-fails on a non-`success` tagged run.
5. Only then tag through `release.yml` and verify remote tag, tag CI, Release object, notes body, and npm publication. Never move `v1.1.0`.

### Mutation scope

No tag created or moved, no Release object created, no npm publish, no Docker image push, no existing row closed. This pass appends this section and rebinds the rolling row `RELEASE-2026-11-09-001` to candidate `e1a0fae3`, this artifact's digest, and CI run `43714546414`; the board carrier commit that binds the digest follows this evidence commit.

## Pass 16 — 2026-11-15 13:19 UTC scheduler tick (re-fire of `duckbrain-releng-2026-11-15-12-18-45`)

Verification-only pass at tip `3dee8fca` (`fix(OPS-014): quote NODE_OPTIONS ...`, 2026-11-15 08:09:01 -05), which is `origin/main`. Decision: **NO CUT** for `v1.2.0`. The candidate moved two commits past pass 15 (`d4462fd6` → `0b46c160` carrier → `3e2b8708` feat OPS-014 → `3dee8fca` fix OPS-014) and both new gates are worse, not better.

### Evidence table

| Surface | Verified this pass | Verdict |
| --- | --- | --- |
| Candidate | `git rev-parse HEAD` = `3dee8fca` = `origin/main`; two commits past the pass-15 tip | — |
| **CI on the candidate** | `gh api repos/wojons/duckbrain/actions/runs/43717514063` → workflow `CI`, head `3dee8fca`, event `push`, created `2026-11-15T13:09:28Z`, **conclusion `failure`**; the only failing job is `test` and its only failing step is `Assert test-counts.json matches live suite` (`docker` skipped) | **RED — hard blocker (new)** |
| Last green | `43716407292` at `0b46c160`, success, `12:56:44Z`. Main went red exactly when the OPS-014 pair landed on top of the releng carrier | attribution |
| Count drift cause | `test-counts.json` says `{"suites":292,"tests":2468}`; the gate measured 293 suites / 2476 tests. OPS-014 added `src/ops/crash-attribution.test.ts` (+1 suite, +8 tests) and did not regenerate the manifest in the same commit, which the manifest's own `provenance` field requires | **recurrence** |
| Registry (last 8 main runs) | `3dee8fca` failure · `0b46c160` success · `a15e43c7` failure · `e1a0fae3` success · `d4462fd6` success · `1b9e722f` success · `ffb14fcb` success · `7e77a18e` success | 2 of 8 red |
| **GitReins** | `.gitreins/history/2026-11-15/3a658d32/verdict.json` → task `OPS-014`, commit `3dee8fca49f5e45436da015bdc608fd4e26e3c4e`, **`passed:false`**. Tier-2 FAIL: cgroup peaks resolved from the invoking worker scope, V8 report collection by filename prefix, no test asserting peak provenance. Rework live in `/home/kara/worktrees/duckbrain-OPS-014` (attempt 2) | **FAIL on candidate (new)** |
| Prior verdict | `.gitreins/history/2026-11-14/b4a8cff9` is task-bound to `fe22d731` — 44 commits behind. Nothing borrowed | non-waiving |
| Census | `v1.1.0..HEAD`: 540 commits, 520 non-merge, 29 `feat`, 40 `fix`, 9 `perf`, **0** breaking (no `BREAKING CHANGE` body, no `!` commit) → minor; `v1.2.0` is the right number. `1364dc4f..HEAD`: 285 / 281 / 36 material | minor confirmed |
| Version surfaces | `package.json` 1.2.0 vs `package-lock.json` root 1.1.0 (line 3) and `packages[""].version` 1.1.0 (line 9); `src/cli/human.ts:2364` and `bin/duckbrain.ts` still print `DuckBrain v1.1.0 - AI Memory System`; `README.md:3` badge 1.1.0; `.github/workflows/ci.yml:47` greps for the stale banner so CI is green **on a wrong value** | BLOCKED — `RELEASE-VERSION-001` |
| CHANGELOG | `[1.2.0] - 2026-11-03` preamble still claims 397 / 379 / 28 / 35 / 4 and post-prep 142 / 140 / 25 against measured 540 / 520 / 29 / 40 / 9 and 285 / 281 / 36. **New:** `grep -iE 'OPS-014\|crash attribution\|crash-attribution\|memory cap\|NODE_OPTIONS' CHANGELOG.md` → 0 hits, so the section does not mention OPS-014 at all, and pass-15's "every material commit is cited" no longer holds | BLOCKED — `RELEASE-2026-11-15-002` (3 items now) |
| npm channel | `registry.npmjs.org` → E404; never published. `actions/secrets` → `total_count=0`, so `NPM_TOKEN` is unset. `release.yml` orders verify → build → npm publish → notes → `gh release create`, so a tag push dies with the tag public and no Release object | BLOCKED — `RELEASE-2026-11-15-001` |
| Authorization | `APPROVE_V1_2_0_CUT` appears 2× in `tasks.jsonl` and 1× in `events.jsonl`; **all** occurrences sit inside requirement text or an audit event. No event on the board is authored by an owner actor | BLOCKED — `RELEASE-2026-10-26-001` part (B) |
| Deployed surface | `duckbrain-http.service` PID 879548 started `2026-11-14 02:33:34 -05`, executing `dist/bin/duckbrain.js` built `2026-11-13 23:25:22` (nearest commit `fe22d731`). Tip is **44 commits ahead** of that build, and `bin/duckbrain.js` prefers a prebuilt `dist` (the trap filed as `QA-DUCKBRAIN-026`). `/health` exposes no loaded commit | STALE — owner-gated, do not restart on this evidence |
| Release tooling | Owned path is tag-triggered `.github/workflows/release.yml` (no Makefile release target, no `scripts/release*`, no GoReleaser). It refuses a tag whose tagged-SHA main run is not `success`, refuses a tag ≠ `package.json` version, refuses an existing Release | PASS — owned path identified |
| Dogfood / QA | No candidate-bound clean-machine battery this pass. Open: `DOGFOOD-033`, `QA-DUCKBRAIN-033`, `-037`, `-032`, `-036`, `-026` | FINDINGS / non-waiving |
| Posture | Public repo, default branch `main`. No credential material read beyond the Actions-secret **count** | PASS |

### What changed since pass 15

Pass 15 concluded NO CUT at `e1a0fae3`/`d4462fd6` with three gates (version surfaces, npm owner gate, authorization) plus prep debt. This pass adds two independent, agent-verifiable blockers on the new tip: **CI is red** (count gate) and the **candidate carries a FAIL judge verdict** (OPS-014). Neither existed at `d4462fd6`. The three pass-15 gates are unchanged and still open. Net: the candidate is further from releasable, not closer.

### Blocker classes (this pass)

| Class | Count | Items |
| --- | --- | --- |
| CI red on the candidate | 1 | `43717514063` — `test-counts.json` 292/2468 vs live 293/2476. Class row `QA-DUCKBRAIN-029` refreshed to this instance |
| Candidate judge verdict FAIL | 1 | `.gitreins/history/2026-11-15/3a658d32` on `3dee8fca`; rework in flight, no PASS covers this tip |
| Owner gate + credential | 1 | npm never published + 0 Actions secrets → `RELEASE-2026-11-15-001` |
| Product defect on the candidate tree | 1 | version surfaces split, CI pins the stale string → `RELEASE-VERSION-001` |
| Prep / evidence debt | 1 | `RELEASE-2026-11-15-002` — preamble stale, OPS-014 uncovered, npm bin normalization |
| Authorization ambiguity | 1 | literal inscription still absent as an owner event → `RELEASE-2026-10-26-001` part (B) |
| Premise falsified | 0 | — |

### Required unblock (ordered, supersedes the pass-15 list)

1. **Fix the count gate after the OPS-014 rework lands** — regenerate `test-counts.json` from the live vitest summary (generator: `scripts/sync-agents-md-counts.sh`) in the *same* commit as the final suite/test change, then obtain a green exact-SHA run on the new tip. Doing it before the rework lands will drift again, because the rework adds three tests by design.
2. `RELEASE-VERSION-001` — fix the four stale `1.1.0` surfaces (`src/cli/human.ts:2364`, `bin/duckbrain.ts`, `README.md:3`, and the `ci.yml:47` assertion that pins the banner) plus `package-lock.json` root fields, then re-green CI.
3. `RELEASE-2026-11-15-002` — restate the `[1.2.0]` preamble at the tag SHA, add the missing OPS-014 entry, normalize `package.json` `bin`.
4. Owner — mint an npm automation token with publish rights on the unscoped public package `duckbrain`, add it as the `NPM_TOKEN` secret, and state first-publication approval.
5. Owner — one sentence settling `APPROVE_V1_2_0_CUT` either way; releng will not tag on the looser reading.
6. Only then tag through `release.yml` and verify remote tag, tag CI, Release object, notes body, npm publication. Never move `v1.1.0`.

### Mutation scope

No tag created or moved, no Release object, no npm publish, no Docker push, no daemon restart, no row closed, no worker dispatched by releng. Board writes this pass: `RELEASE-2026-10-26-001` (canonical contract re-bound to `3dee8fca` + run `43717514063`), `RELEASE-2026-11-15-002` (numbers refreshed, third item added), `QA-DUCKBRAIN-029` (premise refreshed to the current instance) and audit events `8706`–`8708`.
