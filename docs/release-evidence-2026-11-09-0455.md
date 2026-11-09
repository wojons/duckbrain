# DuckBrain release readiness evidence — 2026-11-09 04:55 scheduler tick

Target: wojons/duckbrain
Canonical repository: /home/kara/duckbrain
Authoritative remote: origin = https://github.com/wojons/duckbrain.git
Default branch: main
Candidate: origin/main = 42de028c05ce76b9f493db4190f3176b4cdeeed4
Candidate parity: local HEAD and origin/main both 42de028c; rev-list divergence 0/0; working tree clean.

## Baseline and change census

Baseline tag: v1.1.0, peeled commit b65ba2e475c106c815d2baab4291983863616e55. Remote tag object remains 6def80e0f0ddfbed700819e25e99a08d7e0e58ca.
Range: v1.1.0..42de028c05ce76b9f493db4190f3176b4cdeeed4.
Total commits: 383.
Conventional census: feat 28, fix 34, perf 5, non-material conventional 249, untyped/other 67, breaking markers 0. The subject-type histogram was also independently checked; the counts reconcile to 383. Material source-path commits: 86 by the release-path filter. The range contains both product changes and substantial board/QA/releng bookkeeping; bookkeeping is excluded from release-note categories, not from the tagged tree.

Semver proposal: v1.2.0 minor. Trigger: feature commits; no BREAKING CHANGE footer or type! marker. The version surface is already prepared: package.json is 1.2.0 and CHANGELOG.md has ## [1.2.0] - 2026-11-03 covering v1.1.0..v1.2.0. The section predates 128 commits on the current tip, including later feat/fix/perf commits, so its Range and contents are stale for this candidate and must be reconciled before any future cut.

## Hosted CI

Exact candidate CI: run 42564075454, https://github.com/wojons/duckbrain/actions/runs/42564075454.
Head SHA: 42de028c05ce76b9f493db4190f3176b4cdeeed4.
Conclusion: success, completed.
Jobs: test success (job completed 2026-11-09T04:55:23Z); docker success (job completed 2026-11-09T04:55:56Z).
This is the required exact-head green CI receipt. Recent historical failure: run 42556842086 on ancestor a128cf6; it is not evidence against the current candidate.

## GitReins and dogfood

No committed GitReins verdict.json covers candidate 42de028c05ce76b9f493db4190f3176b4cdeeed4. The latest committed passing verdict found is for 0d43addb, an ancestor, and therefore is not a current-candidate verdict. A fresh full guard was not launched on the pristine detached candidate because the repository's releng procedure classifies a zero-change pristine-tree guard as degraded/non-evidence; this is an evidence gap, not a pass.

Latest committed dogfood record: duckbrain-dogfood-2026-11-08-04-06-52, duplicate-fire closeout at 0612a976/972aeb00. Core HTTP memory loop passed, but the verdict remains PROMISING-BUT-ROUGH: DF-2026-21 is open for the legacy search redirect dropping query and namespace, and the bunker install leg is install-proven but isolation-UNVERIFIED because network mode is shared. Dogfood does not approve this candidate for release.

## Release tooling and artifacts

Repository-owned publisher: .github/workflows/release.yml. It triggers on v* tags, verifies a successful main CI run for the tagged SHA, extracts the matching CHANGELOG section, and invokes gh release create. docs/release-artifact-scope.md defines the release as a GitHub tag plus GitHub Release notes; it explicitly excludes npm publication and registry image push. No Makefile release target, scripts/release*, or GoReleaser configuration exists. No tag or Release object was created in this pass. v1.2.0 is absent locally and remotely; gh release view v1.2.0 reports not found.

Artifact build/upload was not performed because the cut is blocked before tag mutation by the missing current-candidate GitReins verdict and dogfood approval/evidence gap. Docker registry publication is explicitly out of scope. The package has a bin entry but the release document explicitly says no npm publish.

## Deployed surface and posture

GET http://127.0.0.1:3000/health returned healthy, with no code.loaded_commit or repo_commit provenance fields; deployed freshness is UNMEASURED, not green. The listener is served by node pid 2037161 from /home/kara/duckbrain, started 2026-11-07 05:11:35 -05. Process age is not used as a source revision claim.

Repository posture: public, Apache-2.0 license. GitHub security_and_analysis was null in the returned API object. Branch protection API returned 404 Not Found, so main is unprotected; this is a posture finding, not a release override.

## Decision

NO-GO; no tag, Release object, force-move, or artifact publication performed.

The candidate is semver-minor due and exact-head CI is green, but this release is not verified: no current GitReins verdict binds to the candidate, dogfood is PROMISING-BUT-ROUGH with an open API finding and isolation-unverified install leg, the existing CHANGELOG 1.2.0 section omits later material commits, and deployed provenance is unmeasured. Existing v1.1.0 remains untouched. Re-run after the evidence gaps are closed, the changelog range is reconciled, and exact candidate gates are re-established.

---

## Pass 2 — 2026-11-09T05:42Z (re-delivery of tick duckbrain-releng-2026-11-09-04-55-44)

Pass 1 of this tick recorded candidate `42de028c`. The tip has since moved and every
carried blocker was re-probed. This pass measures the delta, refutes two of Pass 1's
blockers, and restates the decision on the evidence that survives.

### Converged candidate and delta

- Fetched tip: `origin/main = c5eb456ab7cbfccdf448420fc19be1d87b967344`; `git ls-remote origin refs/heads/main` returns the same 40-character SHA; local `origin/main` agrees.
- Pass 1 candidate `42de028c05ce76b9f493db4190f3176b4cdeeed4` → `c5eb456a`: 3 commits.
- Path delta `git diff --name-only 42de028c..c5eb456a`: `.coding-hermes/board/tasks.jsonl`, `docs/release-evidence-2026-11-09-0455.md`. No product-source path. Bookkeeping only; the Pass 1 material baseline carries forward.

### Census re-derived at the new tip

- `git rev-list --count v1.1.0..c5eb456a` = **386** (supersedes Pass 1's 383 at `42de028c`).
- Conventional classes: feat 28, fix 34, perf 5, breaking markers 0.
- Material path-filtered commits (`--no-merges`, paths `src bin docs/*.md package.json .github`) = 92.
- Commit messages carrying a `[ci skip]`-class directive: 8 (recorded because CI absence on such commits is by construction, not a gap).
- Semver trigger unchanged: feature commits → **minor**, v1.2.0. No `BREAKING CHANGE` footer and no `type!` marker in the range.

### Hosted CI at the exact tip

- `gh api repos/wojons/duckbrain/actions/runs?head_sha=c5eb456a…` → `total=1`, run **42566159832**, `CI`, event `push`, `completed/success`,
  https://github.com/wojons/duckbrain/actions/runs/42566159832
- Jobs: `test` success 05:14:48Z → 05:17:40Z; `docker` success 05:17:43Z → 05:18:27Z.
- This supersedes Pass 1's receipt (run 42564075454 at `42de028c`).
- Recent red is an ancestor, not the candidate: run 42556842086, `failure` on `a128cf6f`, 2026-11-09T03:31Z, 1m43s. Later tips are green.

### Re-probe of every carried blocker

1. **"No current-candidate GitReins verdict" — REFUTED AS A GATE.** `docs/release-artifact-scope.md` contains zero mentions of `gitreins` (`grep -c -i gitreins` = 0) and its cut checklist names only: exact-SHA CI, CHANGELOG section, package.json version, annotated tag, Release object, previous-tag immutability. A step the repo's own release doc never requires is an absence, not a skipped gate. The verdict state itself is unchanged and still true: the newest committed verdicts bind `609c9718` and `0d43addb`, both ancestors of the candidate.
2. **"Dogfood is PROMISING-BUT-ROUGH, so no release" — REFUTED AS A GATE.** Same doc, zero mentions of `dogfood` (`grep -c -i dogfood` = 0). The dogfood record still stands as written (duplicate-fire closeout `0612a976`/`972aeb00`, DF-2026-21 open for the legacy search redirect, bunker install isolation UNVERIFIED under shared network mode) — it is product-quality evidence, not a publish precondition for this repository.
3. **"CHANGELOG 1.2.0 section does not cover the candidate" — STILL LIVE, and it is now the only cut blocker.** `CHANGELOG.md:7` opens `## [1.2.0] - 2026-11-03` and line 9 states `Range: v1.1.0..v1.2.0 — 254 commits`. The version-prep commit is `1364dc4f` (2026-11-03T17:51:12-05). `git rev-list --count 1364dc4f..origin/main` = 131, and 24 of those commits carry `feat`/`fix`/`perf`. `release.yml` lines 60-70 extract exactly the `## [1.2.0]` section and publish it as the Release body, so tagging now would publish notes that silently omit 24 material changes.
4. **v1.1.0 release surface — UNCHANGED, still incomplete.** Tag `v1.1.0` = `b65ba2e475c106c815d2baab4291983863616e55` (object `6def80e0f0ddfbed700819e25e99a08d7e0e58ca`), pushed 2026-10-20. Its tag-triggered Release run **39539627477** failed 2026-10-21T03:37:50Z at `Run tests` under the pre-`1364dc4f` workflow. `gh release list --repo wojons/duckbrain` returns only `Release v1.0.0`. Since releases are immutable here and tags never move, v1.1.0 needs an explicit decision: back-fill `gh release create v1.1.0 --verify-tag` with the 1.1.0 notes after proving that commit's main CI was green, or record that v1.1.0 ships tag-only.
5. **Deployed surface — STALE and now DEGRADED, provenance still UNMEASURED.** Listener `0.0.0.0:3000` is node pid 2037161, started 2026-11-07 05:11:35 -05 (elapsed 1-19:13), command `node bin/duckbrain.js http --port 3000 --bind-all --auth=apikey`. 23 commits have landed on `origin/main` since that start. `GET /health` now returns `"status":"degraded"` with the embedding health probe timing out (`providers[0].note`: probe exceeded its 8000ms health budget) — Pass 1 recorded `healthy`, so this changed between passes. `/health` still carries no build/revision field, so provenance remains UNMEASURED rather than green. The redeploy is already owned by open row OBSDB-007; no parallel row filed.
6. **Posture — UNCHANGED.** Public repository, Apache-2.0. Branch-protection API returns 404 (`main` unprotected). Carried from Pass 1 as a posture finding, not a release override; no new row.
7. **Authorization — CORRECTED.** Row RELEASE-2026-10-26-001 arm B conditions the v1.2.0 tag on an `OWNER DECISION: APPROVE_V1_2_0_CUT` inscription. A patch/minor cut is standing releng authority; only a major/breaking cut escalates. That gate never existed and the row's reasoning is corrected in this pass.

### Open-row census (measured before filing this pass)

- Non-terminal rows (`pending|blocked|in_progress|review`): **31** — 20 pending, 8 blocked, 3 in_progress, 0 review.
- Open P0: 1 — `HARDEN-DUCKBRAIN-001`, the long-running HARDENING LOOP **umbrella contract row** (carries only a `detail.fingerprint`); it is not a gate defect and does not set Decision-1 rule 2.
- Open P1: 15.
- Delta from this pass: one prep row filed (`RELEASE-2026-11-09-001`), one row refreshed (`RELEASE-2026-10-26-001`). No row closed; nothing was fixed in this pass, so nothing is closed.

### Release tooling

- Driver: `.github/workflows/release.yml` (tag `v*` push → verify exact-SHA green `CI` push run on main/develop → extract `## [X.Y.Z]` from CHANGELOG → `gh release create --verify-tag`). No Makefile release target, no `scripts/release*`, no GoReleaser.
- Scope per `docs/release-artifact-scope.md`: annotated tag + GitHub Release notes + source tree. No npm publish, no container-registry push. Docker image remains an operator-local build.
- `v1.2.0` absent locally and remotely (`git tag -l v1.2.0` empty; `git ls-remote --tags origin` lists only v1.0.0 and v1.1.0). Pass 1's statement that v1.1.0 has no Release object is confirmed.

### Decision (Pass 2)

**NO-GO / no tag cut in this pass.** The release is DUE (Decision-1: feature commits + exact-SHA green CI → minor, v1.2.0), and the two blockers Pass 1 used — no GitReins candidate verdict, dogfood not approving — are refuted by the repository's own release document. What remains is one mechanical prep item: the `## [1.2.0]` CHANGELOG section must cover `v1.1.0..<certified tip>` before the tag, because `release.yml` publishes that section verbatim.

No tag was created, moved, or deleted; no Release object was created; no artifact was built. `v1.1.0` remains at `6def80e0` and `v1.0.0` is untouched.

Filed for the foreman: `RELEASE-2026-11-09-001` (changelog reconciliation + v1.1.0 release-surface decision), both with executable acceptance criteria. Refreshed: `RELEASE-2026-10-26-001` (authorization gate removed, current candidate and CI bound, prep contract restated).
