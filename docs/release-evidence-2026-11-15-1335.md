# DuckBrain v1.2.0 release readiness — pass 17

Tick: `duckbrain-releng-2026-11-15-12-18-45` · sweep 2026-11-15T13:36Z → 13:43Z
Repo: `wojons/duckbrain` · canonical checkout `/home/kara/duckbrain`

**The candidate moved mid-sweep.** This pass opened on `3939701c` with CI red (run
43719513048, test-counts drift). While the sweep ran, the foreman landed `00ca0bc2`
(`chore(ops): sync test-counts to live suite after the OPS-014 crash-bundle rework`),
which closed the drift and turned the tip green. The report is re-anchored to the
newer tip; both observations are kept because the red run is what motivated the fix.

| | |
|---|---|
| candidate tip | `00ca0bc264334ab83c03225a056e624dfb92423d` (origin/main, fetched 13:40Z) |
| candidate tree | `232320b7f59a736ac5cef6b1060d3904e8faeb4b` |
| tree fingerprint (sha256 over `git ls-tree -r`) | `b9ff68dad88798ca8a9e950ba302204664a9cc44539779b9e8f82b3181b7c501` |
| product code | identical to `3939701c`; the delta is `test-counts.json` + foreman artifacts |
| evidence carriers | `68410ea1` (first landing; its own CI run 43721161873 = success); this revision supersedes it |

## Decision: NO CUT

The CI gate that blocked passes 11–16 is now **green**, and so is the judged verdict:
OPS-014 re-judged at the candidate itself (`06a6e9d2`, tier-2 `no_concerns_found`).
Two gates still refuse the cut — one quality, one owner-only. The tag surface is also
split, which is mechanical and must land in the same commit as the tag.

## Gate 1 — CI truth on HEAD: GREEN (run 43719979870)

| run | sha | state |
|---|---|---|
| **43719979870** | **00ca0bc2 (tip)** | **success** — completed 2026-11-15T13:42:39Z |
| 43719513048 | 3939701c | failure — `Assert test-counts.json matches live suite` |
| 43719027899 | 2e75611b (pass-16 addendum) | failure |
| 43718751308 | abbfe327 (pass-16 evidence) | failure |
| 43717514063 | 3dee8fca (OPS-014 first fix) | failure |
| 43716407292 | 0b46c160 | success |

The exact line from the red run (`gh run view 43719513048 --log-failed`), which
`00ca0bc2` fixed:

```
GAP-012 drift: test-counts.json (292 suites, 2468 tests) != live (293 suites, 2481 tests)
```

`00ca0bc2` sets the manifest to `{"suites": 293, "tests": 2481}`, matching the live
suite, and the count gate passes on the next run. Five consecutive push-to-main
failures ran from 13:09Z to 13:37Z; the streak ends here.

QA-DUCKBRAIN-029 is satisfied by that commit and closed on this pass.

## Gate 2 — candidate-bound verdict: PASS (green, supersedes the mid-sweep FAIL)

Mid-sweep the newest tracked verdict was `.gitreins/history/2026-11-15/3a658d32` —
`task_id: OPS-014`, `passed: false`, `commit: 3dee8fca`, `pass_class: judged`. That
FAIL is what blocked passes 11–16.

The foreman re-judged the rework after the test-counts fix and landed `eeaacbd9`.
Observed directly at `.gitreins/history/2026-11-15/06a6e9d2/verdict.json`:
`task_id: OPS-014`, `passed: true`, `pass_class: judged`, `commit:
00ca0bc264334ab83c03225a056e624dfb92423d` — i.e. bound to the release candidate
itself, not to an older tree. OPS-014 is closed on the board and the tier-2 verdict
reads `no_concerns_found`.

Gate 2 is therefore **green**. The crash-attribution rework does carry passing judged
evidence at the exact candidate.

Caveat that survives: the flake documented in INT-CI-038 (P2) —
`tests/http-e2e.int.test.ts` GAP-020 `afterEach` `fs.rmSync` throwing — can red main on
commits unrelated to the change, so a green run on the tagged commit is necessary but
its inverse is not evidence of a bad tree. Re-verify the run attached to the tag
rather than trusting a prior green.

## Gate 3 — version surfaces: SPLIT (blocking, mechanical)

| surface | value | consistent with v1.2.0? |
|---|---|---|
| `package.json` version | `1.2.0` | yes |
| `package-lock.json` root + `packages[""]` | `1.1.0` | **no** |
| `README.md` version badge | `1.1.0` | **no** |
| CLI banner `src/cli/human.ts:2364` | `DuckBrain v1.1.0 - AI Memory System` | **no** |
| CLI banner `bin/duckbrain.js:48` | `DuckBrain v1.1.0 - AI Memory System` | **no** |
| `.github/workflows/ci.yml:47` | greps for the `v1.1.0` banner | asserts the stale string |
| CHANGELOG `[1.2.0]` numeric preamble | written 2026-11-03 at 397/379/28/35/4, post-prep 142/140/25 | **no** |

Tagging v1.2.0 with the banner at v1.1.0 ships a binary that reports the previous
version, and `ci.yml` is written to assert that wrong string, so the banner and the
gate have to move in one commit. Tracked as RELEASE-2026-11-15-002 / RELEASE-VERSION-001.

## Gate 4 — dogfood: FAILED at the last battery; the defect is still open (blocking)

Last battery: `.coding-hermes/dogfood-log.md` trace `duckbrain-dogfood-2026-11-14-10-01-04`,
target `b5b97b344b8eaef219312dd1e250e7b05b61a2bf`, fire `continuation-refire-3`, verdict
**FAILED** — agent `67aeb9f5` DESTROYED-proven. `b5b97b34` is an ancestor of the candidate,
so the battery's target is not "some old tree"; it is the pedigree of this candidate.

| cell / finding | state at candidate |
|---|---|
| QA-DUCKBRAIN-033 (P2) — 12 of 14 parallel `duckbrain search` invocations failed; "the documented CLI cannot be used concurrently" | **pending** |
| QA-DUCKBRAIN-034 (P3) — battery teardown not a teardown; destroy-verify FAIL leaves the ephemeral agent alive | pending |
| QA-DUCKBRAIN-035 (P3) — `ci-pass` unreadable, mis-reported (act ran at 10:28:37Z and failed "Install from a clean store") | pending |
| QA-DUCKBRAIN-036 (P3) — `recall --limit` silently ignored (`--limit 1\|3\|7` all validate as `limit: 10`) | pending |
| README-19-R4 | pending |

The attribution the battery converged on is precise and worth quoting, because it is a
user-facing claim: search is **not** broken single-shot (0.35 s green on an exact replay)
but "**search cannot be trusted under concurrency**" (12/14 failures). No commit in
`b5b97b34..00ca0bc2` addresses it — the only search-related commit in that window,
`978f17e7 perf(PERF-015)`, says `/users` is slow "fork cost, not concurrency". A v1.2.0
cut today would ship a documented CLI verb that fails 86% of the time when two callers
overlap, so the release notes would have to open with it under `## Known issues`.

## Gate 5 owner-only — npm channel unpublished, zero secrets

`npm view duckbrain version` → **E404** (never published). `gh api
repos/wojons/duckbrain/actions/secrets` → `total_count: 0`, so `secrets.NPM_TOKEN`
does not exist. `.github/workflows/release.yml` verifies the tagged commit's
push-to-main CI, checks `tag == v<package.json version>`, builds the CLI, then runs
`npm publish --access public` **before** `gh release create` — so a tag today
publishes the tag and dies at npm, leaving an orphan tag with no Release object.
That is exactly the state `v1.1.0` is already in (tag `b65ba2e4`, no Release object;
the public surface is `v1.0.0` only). Filed as RELEASE-2026-11-15-003 and -001.

Release tooling exists and is authoritative (`.github/workflows/release.yml`,
tag-push triggered). There is no Makefile, no `scripts/release*`, no goreleaser.
`Dockerfile` + `Dockerfile.dev` + a `docker:build` script exist, but the release
workflow builds no image, so a Docker-only publication would be a new path.

## Census since the last release artifact (v1.1.0 → 00ca0bc2)

| metric | value |
|---|---|
| commits in range (all) | 544 |
| non-merge commits | 524 |
| `feat` | 29 |
| `fix` | 41 |
| `perf` | 9 |
| material (`feat`+`fix`+`perf`) | 79 |
| `!` breaking subjects | 0 |
| `BREAKING CHANGE` footers | 0 |
| `chore` / `board` bookkeeping | 84 / 216 |

Post-prep anchor `1364dc4f` → tip: 289 commits (285 non-merge, 37 material).

Semver: 29 features, 0 breaking → **minor, v1.2.0**. No major bump is proposed, so no
explicit user confirmation is required on the version axis.

## Deployed-binary staleness

| item | value |
|---|---|
| daemon | `duckbrain-http.service` PID 879548, started 2026-11-14 02:33:34 -05 |
| command | `node bin/duckbrain.js http --port 3000 --bind-all --auth=apikey …` |
| `/health` | 200 `healthy`, uptime 107983 s, embedder `qwen/qwen3-embedding-8b` healthy |
| built artifact | `dist/bin/duckbrain.js` mtime **2026-11-13 23:25** |
| candidate commit time | 2026-11-15T13:37:38Z (00ca0bc2) |

The running daemon predates the OPS-014 crash-attribution work by two days, so the
artifact built to make the next SEGV attributable is not deployed. The suite says so
itself: `[duckbrain] STALE BUILD: dist/ is 119212s older than src/`. Filed as
RELEASE-2026-11-15-004. `/health` carries no loaded-commit field, so freshness can
only be inferred from `dist/` mtime.

## Open blockers in scope of a cut

- OPS-014 (P1) — crash attribution; rework landed as `3939701c` + `00ca0bc2`, then
  re-judged at `00ca0bc2` and **closed**: verdict `06a6e9d2`, tier-2 PASS
  (`no_concerns_found`). No longer a blocker.
- RELEASE-VERSION-001 / RELEASE-2026-11-15-002 — version surfaces split across four
  files plus the `ci.yml` grep, and the CHANGELOG `[1.2.0]` preamble is stale and
  silent on OPS-014.
- RELEASE-2026-11-15-001 — owner gate: `NPM_TOKEN` provisioning + explicit
  confirmation of first npm publication.
- RELEASE-2026-11-15-003 — `v1.1.0` tag without a Release object.
- RELEASE-2026-11-15-004 — deployed daemon older than the candidate.
- QA-DUCKBRAIN-033 (P2, pending) — 12 of 14 parallel `search` calls fail; documented
  CLI unusable concurrently. Open at the candidate (see Gate 4).
- TESTQ-2026-11-13-1 (P2, pending) — `http-cors-example-app-001` temp-`.git`
  teardown race (ENOTEMPTY).
- Board posture: 5 blocked, 6 in_progress, 96 pending; 2 open P0
  (HARDEN-DUCKBRAIN-001, CLI-GODMODE-001).

## Side effects of this pass

No tag created, moved, or deleted. No Release object. No npm publish. No image build
or push. No live unit started, stopped, or restarted. No product file touched. Board
rows touched: RELEASE-2026-11-09-001 (rolling, pass 17), RELEASE-2026-10-26-001,
RELEASE-2026-11-15-002, RELEASE-2026-11-15-003 (new), RELEASE-2026-11-15-004 (new),
RELEASE-2026-11-15-005 (new — dogfood FAILED / QA-DUCKBRAIN-033 blocker),
QA-DUCKBRAIN-029 (closed — satisfied by `00ca0bc2`, run 43719979870).

## What would flip the decision

1. ~~A GitReins verdict bound to the candidate tree with `passed: true`.~~ **DONE** —
   `06a6e9d2`, OPS-014, `passed: true`, commit `00ca0bc2`.
2. A dogfood battery at the candidate that passes the search-concurrency cell — or an
   owner-accepted `## Known issues` entry for QA-DUCKBRAIN-033 (12/14 parallel
   `search` calls fail) in the v1.2.0 notes.
3. Version surfaces unified at 1.2.0 in one commit (lockfile, README badge, both CLI
   banners, the `ci.yml` grep) with the CHANGELOG preamble re-measured, and that
   commit green on push-to-main.
4. Owner: `NPM_TOKEN` provisioned plus explicit confirmation of first npm publication
   — otherwise the only honest options are source-only or Docker-only publication,
   which is an owner decision, not a releng one.
