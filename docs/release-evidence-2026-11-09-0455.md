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
