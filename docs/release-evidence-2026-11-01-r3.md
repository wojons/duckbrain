DuckBrain release readiness evidence
Scheduler tick: duckbrain-releng-2026-11-01-14-00-02
Target: wojons/duckbrain

Decision: NO-GO. No tag, GitHub Release, or artifact was created.

Candidate and identity
- Verified GitHub remote: https://github.com/wojons/duckbrain.git; provider repo wojons/duckbrain; default branch main.
- Current canonical candidate: origin/main at 4cd55464d4c5efd1b0ab1c439ac525c25a399084.
- git ls-remote origin refs/heads/main matches 4cd55464d4c5efd1b0ab1c439ac525c25a399084.
- Existing remote v1.1.0 annotated tag object is 6def80e0f0ddfbed700819e25e99a08d7e0e58ca and peels to b65ba2e475c106c815d2baab4291983863616e55. It was not moved.

Semver census
- Range: v1.1.0..4cd55464d4c5efd1b0ab1c439ac525c25a399084.
- Total: 221 commits, reconciled with git rev-list --count.
- Conventional subjects: feat 15, fix 21, perf 2, docs 12, chore 53, test 9, ci 2, refactor 0, build 0, other 109.
- No BREAKING CHANGE/BREAKING-CHANGE footer and no conventional type! marker.
- Proposed version: v1.2.0 (minor). Proposal only; no owner authorization to cut was found.

CI
- Exact candidate CI run 41315780696: FAILURE, https://github.com/wojons/duckbrain/actions/runs/41315780696.
- Test job 124875387627 failed at Run tests. The suite reported 245/246 files and 2051/2051 tests passed, then cleanup failed with ENOTEMPTY while removing /tmp/duckbrain-activity-nsattr-AIdfEI at src/http/routes/activity-namespace-attribution.test.ts:142.
- Docker job 124875785965 was SKIPPED because the test job failed.
- Earlier green run 41226572863 is bound to the previous candidate 0b422bff, not the current candidate, and is stale for release gating.

GitReins and dogfood
- No current-candidate all-green GitReins verdict exists. Latest stored task verdicts are failed overall because the standing tier-1 sensitive-path scope issue remains; none covers 4cd55464.
- Latest committed dogfood evidence is Run 18 (2026-10-27), commit db695496, verdict PROMISING-BUT-ROUGH; fresh-install evidence is partial/unproven and no current-candidate approval exists.
- Open release-relevant rows include RELEASE-2026-10-26-001, QA-DUCKBRAIN-PERF-3 (P1), ROLLOUT-DUCKBRAIN-001, DF-2026-20, DF-2026-7, QA-DUCKBRAIN-016, and REVIEW-DUCKBRAIN-005. INT-CI-035 is complete on the board, but its current exact-head CI evidence is superseded by the red run above.

Version and artifact surface
- package.json remains 1.1.0; CHANGELOG has Unreleased but no v1.2.0 heading.
- Repository-owned release path is .github/workflows/release.yml. It is tag-triggered, installs dependencies, runs tests, and creates a GitHub Release; it publishes no package or Docker image.
- No Makefile release target, scripts/release*, GoReleaser, npm publish workflow, or configured Docker registry push was found. Dockerfile exists but CI uses push:false.
- gh release list shows only Release v1.0.0. gh release view v1.1.0 reports release not found. Historical v1.1.0 workflow run 39539627477 failed at Run tests and skipped Create Release.
- duckbrain-http.service is inactive while port 3000 answers healthy; the answering process is unidentified and no version-bearing live endpoint was established. Deployed-binary freshness is UNVERIFIED.

Authorization and decision
- Existing pending RELEASE-2026-10-26-001 requires the exact owner decision: OWNER DECISION: RELEASE-2026-10-26-001 APPROVE_V1_2_0_CUT. No such authorization was found.
- NO-GO: exact-head CI is red, Docker CI is skipped, current-candidate GitReins/dogfood approval is absent, version preparation is missing, artifact publication is incomplete, and authorization is absent.
- No tag, Release object, force-move, or artifact mutation was performed.
