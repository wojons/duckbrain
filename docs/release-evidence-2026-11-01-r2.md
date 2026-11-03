DuckBrain release readiness evidence
Scheduler tick: duckbrain-releng-2026-11-01-14-00-02
Target: wojons/duckbrain

Decision: NO-GO. No tag, GitHub Release, or artifact was created.

Candidate and identity
- Verified remote: https://github.com/wojons/duckbrain.git (GitHub repo wojons/duckbrain).
- Current canonical candidate: origin/main at 4cd55464d4c5efd1b0ab1c439ac525c25a399084.
- Candidate is the releng evidence commit `releng: file DuckBrain v1.2.0 readiness evidence`.
- Canonical checkout /home/kara/duckbrain is dirty with board, GitReins, and wave bookkeeping; release evidence is kept separate from that checkout.
- Existing remote tags: v1.0.0 and v1.1.0. v1.1.0 annotated tag object is 6def80e0f0ddfbed700819e25e99a08d7e0e58ca and peels to b65ba2e475c106c815d2baab4291983863616e55. No tag was moved or created.

Semver census
- Range: v1.1.0..4cd55464d4c5efd1b0ab1c439ac525c25a399084.
- Total commits: 221.
- Conventional subjects: feat 15, fix 21, perf 2, docs 12, chore 53, test 9, ci 2, refactor 0, build 0, other 107.
- No BREAKING CHANGE/BREAKING-CHANGE footer and no conventional type! marker found.
- Proposed next version: v1.2.0 (minor). This is a proposal only; no authorization was found.

CI evidence
- Exact candidate CI run 41315780696: FAILURE, https://github.com/wojons/duckbrain/actions/runs/41315780696.
- Exact candidate test job 124875387627: failure at `Run tests`; 245/246 test files and 2051/2051 tests passed, then cleanup failed with `ENOTEMPTY: directory not empty, rmdir '/tmp/duckbrain-activity-nsattr-AIdfEI'` at src/http/routes/activity-namespace-attribution.test.ts:142.
- Exact candidate docker job 124875785965: SKIPPED because test failed.
- The earlier exact 0b422bff candidate had CI 41226572863 green, but the remote advanced to 4cd55464 and its exact candidate CI is red; the older green receipt is stale for release gating.
- Other recent CI failures are on ancestor SHAs: 41225214177 (51d2661e), 41204157454 (bdb69e36), 41198684258 (468c1f3c), 41170479624 (2d5c9ff), 41170348191 (e39a1110), and 41164398404 (d0294aea).
- Workflows inventory: CI, Recall benchmark, and tag-triggered Release. Release workflow runs tests then creates a Release object; it publishes no package or Docker image.

GitReins and dogfood
- No current-candidate all-green GitReins verdict exists. Recent stored verdicts are task-specific and fail the standing harness-sensitive-path tier-1 baseline (`.gitreins/**` excluded from gitleaks scope); the latest relevant records do not cover 4cd55464.
- Latest committed dogfood evidence is Run 18 (2026-10-27), commit db695496, verdict PROMISING-BUT-ROUGH. Fresh-install evidence is partial/unproven and open findings remain; no current-candidate dogfood approval exists.
- Pending release-relevant board findings include RELEASE-2026-10-26-001 (owner-gated v1.2.0 cut), QA-DUCKBRAIN-PERF-3 (P1), ROLLOUT-DUCKBRAIN-001, INT-CI-035, DF-2026-20, DF-2026-7, QA-DUCKBRAIN-016, and REVIEW-DUCKBRAIN-005.

Version and artifact surface
- package.json version remains 1.1.0; CHANGELOG has Unreleased but no v1.2.0 version-preparation heading.
- Project-owned release path: .github/workflows/release.yml. No Makefile release target, scripts/release*, GoReleaser, npm publish workflow, or configured Docker registry push was found.
- Dockerfile exists, but CI uses `push: false`; no publishable registry artifact strategy is configured.
- `gh release list` shows only Release v1.0.0. `gh release view v1.1.0` is not found. Historical v1.1.0 tag workflow run 39539627477 failed at Run tests and skipped Create Release.
- The live `duckbrain-http.service` unit is inactive while http://127.0.0.1:3000/health answered 200 from an unidentified process; no version-bearing live endpoint was established. Deployed-binary freshness is therefore UNVERIFIED, with stale-deployment findings already recorded in dogfood evidence.

Authorization and decision
- No owner authorization to cut v1.2.0 was found. The pending release row explicitly requires: `OWNER DECISION: RELEASE-2026-10-26-001 APPROVE_V1_2_0_CUT`.
- NO-GO: exact-head CI is red, Docker CI is skipped, current-candidate GitReins/dogfood approval is absent, version preparation is missing, artifact publication is incomplete, and cut authorization is absent.
- No tag, Release object, force-move, or artifact mutation was performed.
