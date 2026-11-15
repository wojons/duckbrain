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

## Decision: NO CUT

The CI gate that blocked passes 11–16 is now **green**. The cut is still refused on
two other gates — one engineering, one owner-only — and because the tag surface
itself is not ready.

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

## Gate 2 — candidate-bound verdict: NONE (blocking)

Newest tracked verdict for this project: `.gitreins/history/2026-11-15/3a658d32/verdict.json`
— `task_id: OPS-014`, `passed: false`, `commit: 3dee8fca`, `pass_class: judged`,
`tier2_skipped: false`.

No verdict exists bound to `3939701c` or to `00ca0bc2`, and `.gitreins/tasks.yaml`
still lists OPS-014 as in flight. A cut today would ship the crash-attribution rework
— the change that touches the daemon's memory discipline — with the only judged
evidence for it being a FAIL on its first iteration.

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

## Gate 4 owner-only — npm channel unpublished, zero secrets

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

- OPS-014 (P1, pending) — crash attribution; rework landed as `3939701c` +
  `00ca0bc2`; **no verdict bound to either**.
- RELEASE-VERSION-001 / RELEASE-2026-11-15-002 — version surfaces split across four
  files plus the `ci.yml` grep, and the CHANGELOG `[1.2.0]` preamble is stale and
  silent on OPS-014.
- RELEASE-2026-11-15-001 — owner gate: `NPM_TOKEN` provisioning + explicit
  confirmation of first npm publication.
- RELEASE-2026-11-15-003 — `v1.1.0` tag without a Release object.
- RELEASE-2026-11-15-004 — deployed daemon older than the candidate.
- TESTQ-2026-11-13-1 (P2, pending) — `http-cors-example-app-001` temp-`.git`
  teardown race (ENOTEMPTY).
- Board posture: 5 blocked, 6 in_progress, 96 pending; 2 open P0
  (HARDEN-DUCKBRAIN-001, CLI-GODMODE-001).

## Side effects of this pass

No tag created, moved, or deleted. No Release object. No npm publish. No image build
or push. No live unit started, stopped, or restarted. No product file touched. Board
rows touched: RELEASE-2026-11-09-001 (rolling, pass 17), RELEASE-2026-10-26-001,
RELEASE-2026-11-15-002, RELEASE-2026-11-15-003 (new), RELEASE-2026-11-15-004 (new),
QA-DUCKBRAIN-029 (closed — satisfied by `00ca0bc2`, run 43719979870).

## What would flip the decision

1. A GitReins verdict bound to the candidate tree with `passed: true`.
2. Version surfaces unified at 1.2.0 in one commit (lockfile, README badge, both CLI
   banners, the `ci.yml` grep) with the CHANGELOG preamble re-measured, and that
   commit green on push-to-main.
3. Owner: `NPM_TOKEN` provisioned plus explicit confirmation of first npm publication
   — otherwise the only honest options are source-only or Docker-only publication,
   which is an owner decision, not a releng one.
