# DuckBrain release evidence — pass 8 (2026-11-11 10:14Z)

Satellite tick: `duckbrain-releng-2026-11-11-10-03-09`. Scope: verification only. Pass 7 is retained below.
Decision: **NO-GO** — no tag, no Release object, no force-move, `v1.1.0` untouched.

Certified candidate: `9cdf6d5d583153c0863a1c4cf2b5b3734ebdf8a7`.

## Current pass — 2026-11-11 10:14Z

### Candidate and baseline

- Canonical remote: `origin=https://github.com/wojons/duckbrain.git` (`wojons/duckbrain`); default branch `main`.
- `HEAD`, `origin/main`, and `git ls-remote origin refs/heads/main` agree at `9cdf6d5d583153c0863a1c4cf2b5b3734ebdf8a7`; parity is `0/0`.
- Baseline `v1.1.0` remains immutable: remote annotated tag object `6def80e0f0ddfbed700819e25e99a08d7e0e58ca`, peeled commit `b65ba2e475c106c815d2baab4291983863616e55`.
- Delta from the prior certified candidate `a8ee14f2` is bookkeeping only: `docs/release-evidence-2026-11-10-0751.md` plus `.coding-hermes/board/tasks.jsonl`, with no shipped-code path. The intervening `d3740340` candidate was followed by the board carrier `9cdf6d5d`.

### Commit census and semver

`v1.1.0..9cdf6d5d` contains 451 commits total and 432 non-merge commits. Conventional-prefix counts are: `feat` 28, `fix` 38, `perf` 5, `docs` 25, `chore` 73, `board` 172, `test` 15, other 95. The post-prep range `1364dc4f..9cdf6d5d` contains 196 commits. No declared `type!:` subject was found. A `BREAKING CHANGE` text hit came from the prose of the prior readiness commit, not a breaking-change footer; verified declaration count is zero. Proposed bump remains `v1.2.0` minor, not major.

The current tip adds three material fix commits after the earlier coverage measurement: `7c0d88e7`, `950a281b`, and `0d1b9e53`. The `[1.2.0]` section still has 32 entries, but the per-SHA citation check reports those three as missing. This reopens CHANGELOG coverage as an executable blocker; the stale numeric preamble is also still reserved for the final cut-time refresh.

### Hosted CI

Exact candidate CI is green: run `43001175002`, `CI`, head SHA `9cdf6d5d583153c0863a1c4cf2b5b3734ebdf8a7`, completed/success. Jobs `test` and `docker` both succeeded; the test job completed all integration and red-proof steps. The preceding candidate run `43000488174` on `d3740340` also completed/success. Older runs `43000417834` and `43000042042` failed on their own SHAs and are not inherited onto this candidate.

### Release tooling and artifacts

The repository-owned release path is `.github/workflows/release.yml`: an annotated `v*` tag triggers exact-main-CI verification and `gh release create --verify-tag` using the matching CHANGELOG section. No Makefile release target, `scripts/release*`, GoReleaser config, npm publish step, or configured Docker registry push exists. The documented scope explicitly keeps npm and registry publication out of release; Docker is local/operator-built only. Package strategy evidence from the prior pass remains `pnpm pack` and local Docker build, not published assets.

Version hygiene is not ready: `package.json` is `1.2.0`, while `package-lock.json` is `1.1.0`, the README badge is `1.1.0`, and both CLI help literals plus the CI help assertion still say `1.1.0`. The open `RELEASE-VERSION-001` row remains live.

Release surface: only GitHub Release `v1.0.0` exists. `v1.1.0` has a remote tag but no Release object; `v1.2.0` tag and Release are absent. No tag, Release, artifact publication, or force-move was performed.

### GitReins, dogfood, deployed posture

No current all-green GitReins verdict is bound to `9cdf6d5d`. The latest stored verdicts are bound to other commits; the current working verdict is stale/degraded evidence and includes a dirty-tree count, so it is not a candidate release gate. Dogfood/QA remains non-waiving evidence: open release-relevant rows include `QA-DUCKBRAIN-022` (in progress), `QA-DUCKBRAIN-028` (judge hang), `PERF-DUCKBRAIN-002` (blocked on owner-gated production compaction), and `DF-0923-05-R2` (packaging/upgrade path). These are not a repo-defined publication precondition, but they remain open posture findings. Deployed binary provenance remains unmeasured; the live service exposes no loaded-commit field.

### Decision and unblock path

**NO-GO.** Exact candidate CI is green, but the cut is blocked by version-surface drift and the newly re-opened three-SHA CHANGELOG citation gap. The existing pending rows `RELEASE-2026-11-09-001` and `RELEASE-VERSION-001` remain the canonical follow-up rows; no duplicate RELEASE row was filed. Unblock in order: land the version-surface fix; cite `7c0d88e7`, `950a281b`, and `0d1b9e53` in the `[1.2.0]` section; at the final tag commit refresh the measured Range preamble; re-run exact-SHA CI; then create `v1.2.0` once all cut gates are green. Keep `v1.1.0` unchanged.

## 1. Candidate identity

| Item | Value |
|---|---|
| Candidate | `a8ee14f2ccf1f61d28007ad76a6d56ba04daf2ec` |
| `origin/main` (local ref) | `a8ee14f2` |
| `git ls-remote origin refs/heads/main` | `a8ee14f2` (agrees — no sibling push raced this pass) |
| Baseline tag | `v1.1.0` — local object `6def80e0`, peeled `b65ba2e` (unchanged) |
| Delta from pass-6 candidate `9d9de8cd` | 1 commit: `a8ee14f2` = `docs/release-evidence-2026-11-10-0741.md` + board `tasks.jsonl` — bookkeeping only, no product path |

## 2. Change inventory, `v1.1.0..a8ee14f2`

| Metric | Measured |
|---|---|
| Commits, inclusive | 423 |
| Commits, non-merge | 404 |
| Commits after the CHANGELOG prep commit `1364dc4f` | 168 (165 non-merge) |
| `feat` | 28 |
| `fix` | 35 |
| `perf` | 5 |
| `docs` | 24 |
| `chore` | 70 |
| `board` | 160 |
| `test` | 15 |
| `ci` | 3 |
| `style` | 1 |
| `refactor` / `build` | 0 / 0 |
| Breaking subjects (`type!:` / `type(scope)!:`) | 0 |
| `BREAKING CHANGE` footers | 0 |

Semver proposal: **v1.2.0 (minor)** — `feat` present, zero breaking changes. No major bump is proposed, so the "explicit confirmation before tagging a major" rule is not engaged.

## 3. CI truth on the candidate

| Item | Value |
|---|---|
| Run | `42776086645` (`wojons/duckbrain`) |
| Head SHA | `a8ee14f2` (exact candidate) |
| Status | completed / **success** |
| Jobs | `test` success, `docker` success |

This is an exact-head run: no red, so the "never release on red CI" gate is not the blocker.

## 4. Version hygiene (gate BLOCKED — open)

| Surface | Value | Verdict |
|---|---|---|
| `package.json` | `1.2.0` | refreshed |
| `package-lock.json` (root) | `1.1.0` | **stale** (not cited by any earlier pass) |
| `README.md:3` badge | `1.1.0` | **stale** |
| `.github/workflows/ci.yml:47` | `DuckBrain v1.1.0 - AI Memory System` | **stale** — and CI asserts it, so green CI is not evidence of a correct stamp |
| `src/cli/human.ts:2313` | `DuckBrain v1.1.0 - AI Memory System` | **stale** — this is the string `--help` prints |

Tagging now would publish a `v1.2.0` artifact whose own help banner announces `v1.1.0`. Tracked as `RELEASE-VERSION-001` (P1, pending).

## 5. CHANGELOG state

- The `[1.2.0]` section covers **25/25** post-prep material `feat`/`fix`/`perf` commits (0 missed) and holds 32 entries. No new material commit has landed since the earlier coverage reconciliation, so pass 5's coverage finding stands refuted.
- Only the numeric preamble is stale: file says 397 inclusive / 379 non-merge / 4 `perf` / 67 material / 142 post-prep; measured 423 / 404 / 5 / 25 / 168. That rewrite is arithmetic over measured data and belongs at the final tag SHA, not now.

## 6. Authorization (gate BLOCKED — needs an owner ruling)

The board carries two **contradictory** authorization rules for the same cut:

- `RELEASE-2026-10-26-001` part (B): requires the literal inscription `OWNER DECISION: RELEASE-2026-10-26-001 APPROVE_V1_2_0_CUT` in the row.
- `RELEASE-2026-11-09-001`: states a minor cut is a releng action under standing authority and that "no owner inscription is required".

No inscription exists. `grep` over `tasks.jsonl` and `events.jsonl` returns only prose that *requires* the token (one `worker_summary` even redacts it as `OWNER ***`). The pass-6 evidence recorded "releng-authorized" by reading the looser row; this pass records the conflict instead of resolving it unilaterally. **The stricter gate governs until Bane rules**, consistent with the standing doctrine that an unanswered offer is not consent.

DuckBrain ledger cross-check: **UNVERIFIED** — MCP `search` and `recall` each timed out at 300 s (2 attempts). There is no ledger evidence for or against an approval; that leg is a named hole, not a null result.

## 7. Artifacts and deployment

| Check | Result |
|---|---|
| `v1.2.0` tag, local or remote | absent (both) |
| `gh release list` | only `v1.0.0` — `v1.1.0` has no Release object |
| Force-move of an existing tag | none performed |
| Deployed surface `GET /health` | healthy (uptime 249986 s, pid 2037161); **no loaded-commit field**, so deployed freshness stays UNMEASURED (OBSDB-007) |

## 8. Carried, not re-measured at `a8ee14f2`

The delta from `9d9de8cd` is docs + board only, so these pass-6 measurements still describe the candidate's product code: `pnpm docs:check` + `--self-test` PASS, `build:cli` PASS, `pnpm pack` → `duckbrain-1.2.0.tgz` PASS, `docker build` PASS. Re-running them at this SHA would measure the same tree and is deferred to the cut.

## 9. Board actions this pass

- `RELEASE-2026-11-01-001` (standing candidate row): `[RELENG REFRESH 2026-11-10 07:55]` appended to `foreman_note`.
- `RELEASE-2026-10-26-001` (cut row): `blocked_on` set to `RELEASE-VERSION-001`; `blocked_reason` rewritten to name both open gates and the authorization contradiction.
- Event `8607` (`task_updated`, actor `duckbrain-releng`) filed.

## 10. What unblocks the cut

1. **Bane ruling on authorization** — either inscribe the token, or have `RELEASE-2026-10-26-001` part (B) amended to match the standing-authority reading.
2. `RELEASE-VERSION-001` lands: all five version surfaces agree at 1.2.0 (foreman work — it is a code edit, not releng's).
3. At the final SHA: refresh the CHANGELOG preamble arithmetic, then tag `v1.2.0`, `gh release create`, verify `gh release view` plus an exact-head CI run on the tag commit.
