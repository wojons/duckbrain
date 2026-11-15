# DuckBrain v1.2.0 release readiness — pass 18

Tick: `duckbrain-releng-2026-11-15-12-18-45` · sweep 2026-11-15T14:33Z → 14:45Z
Repo: `wojons/duckbrain` · canonical checkout `/home/kara/duckbrain`

**No product change since pass 17.** The published tip advanced three commits
(`68410ea1` → `eeaacbd9` → `736909b5`) and then a fourth (`cd508436`), but the
product tree is **byte-identical** to the pass-17 candidate: verified by hashing
`git ls-tree -r` with the board, `.gitreins/` and `docs/release-evidence-*`
filtered out — both `00ca0bc2` and `736909b5` hash to
`e23fb4ac756d3f3de97a7ddd1664a990def04cc30d697c3f52f5522b0c0c2922`.

| | |
|---|---|
| published product tip | `736909b512e4420757515f73a0e6fc8350298dfc` (origin/main) |
| tip tree | `f6850d7017f31b61858dff09d42e46b8b2e7c071` |
| full-tree fingerprint (sha256 over `git ls-tree -r`) | `177918b91e0c7e9982367c95d1176ffcf18f33bb49801f5f7222a6da72e2aa55` |
| product-only fingerprint (board/ledger/evidence filtered) | `e23fb4ac…0c0c2922` — identical to pass-17 candidate `00ca0bc2` |
| pass-17 candidate | `00ca0bc264334ab83c03225a056e624dfb92423d` (tree `232320b7`) |
| delta `00ca0bc2..736909b5` | `.coding-hermes/board/{board,events,tasks}.jsonl`, `.gitreins/tasks.yaml`, `+docs/release-evidence-2026-11-15-1335.md` — no product file |
| newest commit | `cd508436` `chore(board): dispatch PERF-015 (serial, slots=1) + wave manifest` (pushed, CI in flight at sweep close) |

## Decision: NO CUT

Same verdict as passes 11–17, on fresher evidence. The product tip is green and
judged; six gates still refuse the cut, and a product change is in flight that
will move the tree within the hour.

1. **Owner-only channel (decisive).** `npm view duckbrain` = E404 and
   `gh api repos/wojons/duckbrain/actions/secrets` = `total_count: 0`. The
   release workflow publishes to npm *before* it creates the GitHub Release, so a
   tag today puts a public tag on a commit and then dies — exactly the orphan
   state `v1.1.0` is in. → row `RELEASE-2026-11-15-001` (owner-gated).
2. **Tag surface is split and must land with the tag.** Three different versions
   are live: `package.json` 1.2.0, `package-lock.json` 1.1.0, README badge and
   both CLI banners 1.1.0 (CI greps the 1.1.0 banner). → `RELEASE-VERSION-001`.
3. **CHANGELOG preamble numbers are stale.** Written 2026-11-03 with
   397/379/28/35/4; measured now at the tip: **547 total, 527 non-merge, 29
   `feat`, 41 `fix`, 9 `perf`, 79 material non-merge, 0 bang subjects, 0
   `BREAKING CHANGE` footers**. → `RELEASE-2026-11-15-002`.
4. **The served build predates the candidate.** → `RELEASE-2026-11-15-004`.
5. **`v1.1.0` has no GitHub Release object.** → `RELEASE-2026-11-15-003`.
6. **A product change is in flight.** Foreman tick
   `duckbrain-foreman-2026-11-15-14-22-51` dispatched `PERF-015` at 14:35:19Z
   (worktree `/home/kara/worktrees/duckbrain-PERF-015`, base `736909b5`), with a
   control arm measuring `GET /users` at 171.3 s / 74 authors on the live daemon.
   Tagging now would tag a tree that is about to change.

Bump class is unchanged: **minor** → `v1.2.0` from baseline `v1.1.0`
(`b65ba2e4`). No major proposed: zero breaking markers in the range.

## Gate 1 — CI truth on the candidate: GREEN

| run | sha | state |
|---|---|---|
| **43723152609** | **736909b5 (published product tip)** | **success** — 2026-11-15T14:13:13Z |
| 43721839296 | eeaacbd9 | success — 13:59:05Z |
| 43721161873 | 68410ea1 | success — 13:51:12Z |
| 43719979870 | 00ca0bc2 (pass-17 candidate) | success — 13:37:38Z |
| 43719513048 | 3939701c | failure — test-counts drift (fixed by `00ca0bc2`) |
| 43725269409 | cd508436 (board-only commit) | **in progress at sweep close** (started 14:36:20Z) |

Four consecutive green push-to-main runs after the drift fix. The one open run is
on a board-only commit whose product tree is identical to a green tip.

## Gate 2 — candidate-bound verdict: PASS (carried forward)

`.gitreins/history/2026-11-15/06a6e9d2/verdict.json` — `task_id: OPS-014`,
`passed: true`, `commit: 00ca0bc2`, `pass_class: judged`. That commit's product
tree is byte-identical to `736909b5`/`cd508436`, so the verdict still binds to
what would ship. Known gap, unchanged: **no verdict is bound to a release task**
— the credited evidence is the OPS-014 judgement on the same product tree.

## Gate 3 — release surface

* Tags: `v1.1.0` (→ `6def80e0` on origin), `v1.0.0`. `v1.2.0` absent.
* GitHub Releases: `v1.0.0` only — **`v1.1.0` tag exists with no Release object**.
* Release tooling: `.github/workflows/release.yml` is authoritative (tag-push;
  asserts the tagged commit's push-to-main CI is green; requires tag ==
  `v<package.json version>`; `npm publish` precedes `gh release create`).
  No Makefile release target, no `scripts/release*`, no goreleaser. Dockerfile +
  `docker:build` script exist; the workflow builds no image.
* Channel state: `npm view duckbrain` = E404; Actions secrets = 0.

## Gate 4 — version surfaces (split)

| surface | value |
|---|---|
| `package.json` | 1.2.0 |
| `package-lock.json` (root + `packages[""]`) | 1.1.0 |
| `README.md` badge | 1.1.0 |
| `src/cli/human.ts:2364` banner | `DuckBrain v1.1.0` |
| `bin/duckbrain.js` banner | `DuckBrain v1.1.0` |
| `.github/workflows/ci.yml:47` help-output assertion | greps `DuckBrain v1.1.0` |

## Gate 5 — deployed surface (stale)

* `duckbrain-http.service` active, PID 879548, started 2026-11-14 02:33:35 -05.
* `dist/bin/duckbrain.js` mtime 2026-11-13 23:25:22 -05; newest `src/**/*.ts`
  2026-11-15 08:32:14 -05 → **build is 119,212 s older than source**.
* `/health` at 14:36:16Z: 200, `"status":"healthy"`, uptime 111,761 s, embedding
  healthy (`qwen/qwen3-embedding-8b`). No loaded-commit field, so the deployed
  commit cannot be proven from the endpoint — staleness is inferred from mtimes.
  (One earlier probe in this sweep returned 503 / 33.6 s; the immediate re-probe
  returned 200 / 3.5 ms. Recorded as host-load variance, not a daemon fault.)

## Gate 6 — board posture at sweep close

489 complete / 98 pending / 6 in_progress / 5 blocked. Two open P0 contract rows:
`HARDEN-DUCKBRAIN-001`, `CLI-GODMODE-001`. All five releng rows below are still
pending and their premises re-verified this pass.

## Open blockers (unchanged, re-verified)

| row | state |
|---|---|
| `RELEASE-2026-11-15-001` | P1 owner-gated: npm/secret channel unset → tag today orphans |
| `RELEASE-VERSION-001` | package.json vs lock vs README vs banners vs CI assertion |
| `RELEASE-2026-11-15-002` | CHANGELOG [1.2.0] preamble numbers stale (397→547 range) |
| `RELEASE-2026-11-15-003` | `v1.1.0` has no GitHub Release object |
| `RELEASE-2026-11-15-004` | served dist predates the candidate by 119,212 s |
| `RELEASE-2026-11-15-005` | dogfood FAILED at candidate pedigree (12/14 parallel `search`) |
| `QA-DUCKBRAIN-030…037`, `DOGFOOD-033`, `README-19-R2…R4` | QA/QA-battery residues, still open |
| `PERF-015` | in flight — will move the product tree |

## Side effects

No tag created, moved or deleted. No GitHub Release created. No npm publish. No
image build or push. No unit started, stopped or restarted. No product file
touched. Only this artifact (and the rolling releng row) were written.
