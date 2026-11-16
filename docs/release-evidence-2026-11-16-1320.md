# DuckBrain release readiness — pass 19

- Tick: `duckbrain-releng-2026-11-16-1320-45` (2026-11-16 13:20Z)
- Repo under release management: `/home/kara/duckbrain` (`wojons/duckbrain`, org derived from `git remote -v`)
- Candidate: `origin/main` = `HEAD` = `9f2ddbeec86e7a3448f7797f1e910c60159f3c75`
- **Decision: NO CUT** (19th consecutive pass). Nothing is tagged, no Release object, no npm publish, no image push, no row closed.
- Authority: a **minor** cut needs no new owner inscription — the owner authorized the v1.2.0 minor cut on 2026-11-11 (recorded in pending `RELEASE-2026-10-26-001`, the canonical cut contract). This pass therefore holds the cut on **readiness gates only**, not on missing authorization. `RELEASE-2026-10-26-001` stays pending and is not closed by this sweep.

## 1. Release inventory since the last release

Remote tags (only two exist): `v1.0.0` → `769fe4ed` (annotated, peeled `f985433d`), `v1.1.0` → `6def80e0` (annotated, peeled `b65ba2e4`).
GitHub Release objects: **one only** (`393259139`, `v1.0.0`, 2026-09-21T20:05:43Z, not draft, not prerelease). `v1.1.0` is a tag with no Release object — pre-existing gap, not new.

Range `v1.1.0^{commit}..9f2ddbee`:

| category | count |
|---|---|
| commits (all) | 558 |
| commits (non-merge) | 537 |
| `feat` (→ minor) | 29 |
| `fix` (→ patch) | 41 |
| `perf` (→ patch) | 10 |
| material total (`feat`+`fix`+`perf`) | 80 |
| `!` bang subjects (→ major) | 0 |
| line-start `BREAKING CHANGE:` footers | 0 |
| non-conventional subjects | 457 |

No breaking signal anywhere in the range, so the semver proposal stays **v1.2.0 (minor)**. No major bump is proposed, therefore no owner confirmation is being requested for one.

## 2. Product identity of the candidate

Production fingerprint = sha256 over `git ls-tree -r <commit>` with `.coding-hermes/`, `.gitreins/` and `docs/release-evidence-*` excluded (tab-field awk, not grep, to avoid the earlier tab-escape mistake):

```
00ca0bc2  e23fb4ac…   736909b5  e23fb4ac…
d63f2853  e23fb4ac…   9f2ddbee  e23fb4ac…   (tip)
```

`git diff --name-status 00ca0bc2..9f2ddbee` with those paths excluded returns **empty**. Every commit since `00ca0bc2` (2026-11-15T13:37Z) is board / ledger / evidence only. The tree the previous passes certified is still the tree at tip — this is carried as measured identity, not assumption.

## 3. CI truth on HEAD

| run id | workflow | head | conclusion | finished |
|---|---|---|---|---|
| `43741076346` | CI (push) | `9f2ddbee` | **success** (jobs: `test` success, `docker` success) | 2026-11-15T17:30:40Z |
| `43798883862` | Recall benchmark (schedule) | `9f2ddbee` | **success** | 2026-11-16T03:33:53Z |

Last red on main: `43727451764` at `a11a1a95` (2026-11-15T15:00Z) — the PERF-015 merge. It was reverted by `d63f2853` and **six consecutive push runs have been green since**: `43728764584`, `43728935732`, `43729027259`, `43733328667`, `43740898480`, `43741076346`. The candidate is CI-green on its own commit, not merely "green somewhere".

## 4. Version hygiene (unchanged, still blocking)

| surface | value | expected |
|---|---|---|
| `package.json` version | 1.2.0 | 1.2.0 ✓ |
| `package-lock.json` root + `packages[""].version` | 1.1.0 | 1.2.0 ✗ |
| `README.md` badge | 1.1.0 | 1.2.0 ✗ |
| `bin/duckbrain.ts:48` banner | `DuckBrain v1.1.0` | 1.2.0 ✗ |
| `src/cli/human.ts:2364` banner | `DuckBrain v1.1.0` | 1.2.0 ✗ |
| `.github/workflows/ci.yml:47` assertion | asserts `DuckBrain v1.1.0` | 1.2.0 ✗ |

Consequence for a cut today: `release.yml` gates on `v$GITHUB_REF_NAME` vs `package.json` (1.2.0 → passes), so the tag would be accepted while `duckbrain help` still announces **v1.1.0**. Tracking row: `RELEASE-VERSION-001` (pending).

CHANGELOG `[1.2.0]` preamble at `CHANGELOG.md:7` still claims **397 commits / 379 non-merge / 28 feat / 35 fix / 4 perf**; measured now: **558 / 537 / 29 / 41 / 10**. `release.yml` (`Write release notes from CHANGELOG`, lines 87-102) slurps that section verbatim into the Release body, so publishing today would ship wrong counts. Tracking row: `RELEASE-2026-11-15-002` (pending).

## 5. Release channel — the reason a tag today is unsafe

- `npm view duckbrain version` → **E404**: the name has never been published from this account. Any publish is a *first* publication.
- `gh api repos/wojons/duckbrain/actions/secrets` → `total_count: 0`; `actions/variables` → `0`. `secrets.NPM_TOKEN` does not exist.
- `.github/workflows/release.yml` step order: `Verify the tagged commit passed CI on main` (:34) → `setup-node` (:57) → `pnpm` (:62) → `Build CLI for npm package` (:67) → **`Publish package to npm`** with `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` (:75-85) → `Write release notes from CHANGELOG` (:87) → `Create Release` / `gh release create --verify-tag` (:103-112).
- Because npm publish precedes Release creation and the token is unset, a `v1.2.0` tag today passes the CI gate, dies at `npm publish`, and leaves a **public tag with no Release object**. Tracking row: `RELEASE-2026-11-15-001` (pending, owner-gated).

Not tagged: no tag was created or moved, and no `gh release create` was run. `--verify-tag` in the workflow also means re-running it requires the tag to already exist — a retry after the token is provisioned needs a fresh tag or a re-dispatch, which is part of why the order matters.

## 6. Deployed artifact staleness (re-measured; earlier premise was wrong)

Live listener on `:3000`: PID **1986129**, started **2026-11-15 10:14:20 -05 (15:14:20Z)**, parent PID 7126 (`systemd --user`), cwd `/home/kara/duckbrain`, `/health` → 200 with `uptime 80272s` matching the process start exactly.

It **is** managed — as a *user* unit, not a system unit. `systemctl list-unit-files 'duckbrain*'` (system) → 0; `systemctl --user` → `duckbrain-http.service` **enabled**, fragment `/home/kara/.config/systemd/user/duckbrain-http.service`, `MainPID=1986129`, `ActiveEnterTimestamp=Sun 2026-11-15 10:14:21 -05`, `NRestarts=0`. A first pass this tick queried only the system bus and would have filed "unit not installed" — that claim is wrong and was discarded before any row was written.

Effective config does reproduce repo intent through drop-ins: `Restart=always`, `RestartSec=3`, `StartLimitIntervalSec=300`, `StartLimitBurst=10`, `MemoryHigh=6442450944` (6G), `MemoryMax=8G`, `NODE_OPTIONS=--max-old-space-size=3072`, `ExecStart=/usr/bin/node bin/duckbrain.js http --port 3000 --bind-all --auth=apikey --rate-limit 600 --unix-socket=/tmp/duckbrain.sock …`. The **installed base unit file predates the repo's copy** (installed 2026-08-01 with `Restart=on-failure` and `UMask=0077`; `ops/systemd/duckbrain-http.service` in-repo is the OPS-001/OPS-014 hardened version) — the behavioural gaps are covered by drop-ins (`10-restart-always.conf`, `10-memory-cap.conf`, `zz-tailnet-bind.conf`), so this is documentation drift, not a live defect.

The real staleness finding is ordering:
- `dist/bin/duckbrain.js` mtime **2026-11-15 17:41:27 -05 (22:41:27Z)**.
- Process start **15:14:20Z**, i.e. the artifact was rebuilt **7h27m after** the daemon started, and `NRestarts=0` proves the rebuild did not restart it.
- So the live process is executing the build that existed at 10:14 local, not the one on disk now. Whether the two are content-identical is **unprovable**: source mtime is 15:13:21Z (checkout), the product tree has not changed since `00ca0bc2`, and neither `dist/` nor `/health` carries a build/commit stamp.
- The ops tick's `foreman_note` of 2026-11-15 10:57 local ("all arms hold") was true when measured and is now superseded by the 17:41 rebuild. Row `RELEASE-2026-11-15-004` stays **pending** with corrected evidence; do not restart on this evidence alone, and do not close it on the 10:57 measurement.

## 7. Verdicts and dogfood

- GitReins: `OPS-014` **PASS** at `00ca0bc2` (history dated 2026-11-15). Because the product tree at tip is byte-identical to `00ca0bc2`, that pass carries to the candidate at tree level. `PERF-015` **FAIL** at `a11a1a95` (merged, then reverted by `d63f2853`) — that verdict is against code no longer on main. No verdict is bound to `9f2ddbee` itself.
- Dogfood: last battery is **2026-11-14**, target `b5b97b34`, verdict **FAILED** (12 of 14 parallel `duckbrain search` calls failed). Product diff `b5b97b34..9f2ddbee` is **8 files** (`src/ops/crash-attribution.ts` + test, `scripts/crash-attribution.js`, `ops/systemd/duckbrain-http.service`, `docs/guide/deployment.md`, `docs/dogfood/2026-11-14-…md`, `skills/duckbrain-usage/SKILL.md`, `test-counts.json`). The battery therefore **predates** the OPS-014 crash-attribution work and does not bind the candidate. No battery exists at `9f2ddbee`. Tracking row: `RELEASE-2026-11-15-005`.

## 8. Open blockers

| row | status | why it blocks a cut |
|---|---|---|
| `RELEASE-2026-10-26-001` | pending | canonical v1.2.0 cut contract; authorized, not satisfiable while the rows below are open |
| `RELEASE-2026-11-15-001` | pending | npm channel unclaimed + 0 Actions secrets; workflow order orphans the tag (owner-gated) |
| `RELEASE-VERSION-001` | pending | five stale `1.1.0` surfaces; tag passes the gate, CLI still says v1.1.0 |
| `RELEASE-2026-11-15-002` | pending | CHANGELOG `[1.2.0]` counts wrong (397/379/28/35/4 vs 558/537/29/41/10) and are slurped into the Release body |
| `RELEASE-2026-11-15-003` | pending | `v1.1.0` tag has no Release object |
| `RELEASE-2026-11-15-004` | pending | live build older than on-disk artifact (rebuild at 22:41Z, no restart); no build stamp to measure freshness — premise re-measured this pass |
| `RELEASE-2026-11-15-005` | pending | dogfood pedigree does not bind the candidate |
| `RELEASE-2026-11-15-006` | pending | (see row) |
| `PERF-015` | in_progress | attempt 3 in flight; attempt 2 rejected (authors 17 vs control 21). Will move the product tree |

Board totals at tip: 489 `complete`, 104 `pending`, 6 `in_progress`, 5 `blocked`.

## 9. What would make the next cut possible

1. Provision `NPM_TOKEN` (or make the npm publish step conditional / reorder Release before publish) → clears `-001`.
2. Fix the five stale `1.1.0` literals → clears `RELEASE-VERSION-001`.
3. Re-measure and rewrite the CHANGELOG `[1.2.0]` preamble → clears `-002`.
4. Land or abandon `PERF-015` so the tree stops moving.
5. Re-run a clean-machine dogfood battery at the eventual candidate SHA → clears `-005`.

Until 1-4 hold, `v1.2.0` should not be tagged. This pass creates no tag.
