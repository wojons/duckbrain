DuckBrain release readiness evidence
Scheduler tick: duckbrain-releng-2026-11-01-14-00-02
Target: wojons/duckbrain
Canonical candidate: origin/main at 0b422bff2009af2773f8c2cb2be7ca461feec132
Clean detached worktree: /home/kara/.hermes/cache/scratch/duckbrain-release-20261101-140002

Decision: NO-GO; no tag, GitHub Release, or artifact was created.

Identity and candidate
- origin: https://github.com/wojons/duckbrain.git
- origin/main: 0b422bff2009af2773f8c2cb2be7ca461feec132
- candidate worktree HEAD: 0b422bff2009af2773f8c2cb2be7ca461feec132
- canonical checkout was dirty in board/gitreins/wave bookkeeping, so all release evidence ran in the clean detached worktree.
- existing tags: v1.1.0 and v1.0.0; v1.1.0 is annotated and peels to b65ba2e475c106c815d2baab4291983863616e55.
- remote v1.1.0 tag remains 6def80e0f0ddfbed700819e25e99a08d7e0e58ca; it was not moved.

Commit and semver census
- range: v1.1.0..0b422bff2009af2773f8c2cb2be7ca461feec132
- total: 220
- conventional subjects: feat 15, fix 21, perf 2, docs 12, chore 53, refactor 0, test 9, other 108
- breaking markers: none found in commit bodies or type! subjects.
- proposed next version: v1.2.0 (minor; feat commits present, no major marker).

CI
- exact candidate run 41269365141: completed success on 0b422bff2009af2773f8c2cb2be7ca461feec132.
- exact run job: recall-benchmark success, 19/19 listed steps successful.
- recent CI includes failures on ancestor SHAs 51d2661e (run 41225214177), bdb69e36 (41204157454), 468c1f3c (41198684258), 2d5c9ffa (41170479624), e39a1110 (41170348191), and d0294aea (41164398404); these do not prove the current candidate red, but remain part of recent history.
- workflow inventory: CI, Recall benchmark, Release. Release is tag-triggered.

GitReins
- fresh command: gitreins guard --full --scope working-tree --json
- result: pass, exit 0, generated 2026-11-01T14:16:38.423858+00:00, degraded=false, skippedSteps=[], changedFileCount=1, checks secrets=pass and tests=pass.
- scope is working-tree and gitleaks is not run in that scope; this is bounded evidence, not a full repository secret-scan claim.
- repository verdict history has no fresh all-green verdict bound to the current candidate; recent stored verdicts are predominantly failed task-specific records on earlier commits.

Dogfood and blockers
- latest committed dogfood evidence is Run 18 / 2026-10-27 at db695496, verdict PROMISING-BUT-ROUGH. It records successful isolated HTTP/CLI write/read/search/consolidate probes but partial/unproven fresh-install evidence and open findings DF-2026-9/10.
- dogfood log also records unresolved release-relevant findings including stale deployed production code (DF-2026-3) and a recurring P1 clean-machine QA row (QA-DUCKBRAIN-PERF-3); no current dogfood approval for this candidate was found.
- pending board blockers at the candidate: RELEASE-2026-10-26-001 (owner-gated v1.2.0 cut), ROLLOUT-DUCKBRAIN-001 (P2), QA-DUCKBRAIN-PERF-3 (P1), INT-CI-035 (P2), DF-2026-20 (P2), DF-2026-7 (P2), QA-DUCKBRAIN-016 (P4), and REVIEW-DUCKBRAIN-005 (P3).

Version and release surface
- package.json version: 1.1.0; CHANGELOG has an Unreleased section, but no v1.2.0 version-prep section.
- project-owned release path: .github/workflows/release.yml, triggered by v* tags; it installs dependencies, runs pnpm test:run, and creates a GitHub Release with no assets.
- no Makefile release target, scripts/release*, GoReleaser configuration, npm publish workflow, or configured Docker registry push was found.
- Dockerfile exists and CI's Docker build uses push:false; it is not a publishable registry artifact strategy.
- existing v1.1.0 GitHub Release is absent (gh release view v1.1.0: release not found); only v1.0.0 is listed. The historical v1.1.0 release workflow run 39539627477 failed at Run tests and skipped Create Release.

Authorization and release action
- no explicit owner authorization to cut v1.2.0 was found. The existing pending RELEASE-2026-10-26-001 explicitly requires OWNER DECISION: RELEASE-2026-10-26-001 APPROVE_V1_2_0_CUT.
- because authorization is absent, and the repository lacks a complete artifact strategy/release tooling, no tag or Release object was created.
