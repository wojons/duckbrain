# DuckBrain release readiness — 2026-11-13

Certified product candidate: b35a05b6a1072972f1b815cd4d15b55ae3d7be13 (product tree certified at origin/main; current tip 6940179f08e2727e25f79bdd2662e1e60819909e is bookkeeping-only carrier movement). Decision: NO CUT; proposed v1.2.0. Subsequent evidence/board carriers are not product candidates. Original November 13 measurement: dab23922a71ea02bf1fc93c01881b891f93258b8; retained historical sections below are superseded by Pass 13.

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


