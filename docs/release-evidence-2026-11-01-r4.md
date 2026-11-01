# DuckBrain release readiness evidence — 2026-11-01 r4

Scheduler tick: duckbrain-releng-2026-11-01-14-00-02
Target: wojons/duckbrain
Canonical repository: /home/kara/duckbrain
Authoritative remote: git@github.com:wojons/duckbrain.git
Forge project: wojons/duckbrain
Default branch: main

## Candidate and baseline

Candidate: origin/main at 771d5e0b1f270039c8ffceafcfc2a083f1a4ff6b
VCS proof: git ls-remote origin refs/heads/main = 771d5e0b1f270039c8ffceafcfc2a083f1a4ff6b
Local canonical checkout was stale/dirty (HEAD 0b422bff, origin/main 771d5e0b); release evidence is bound to the fetched remote candidate, not the dirty carrier checkout.
Baseline tag: v1.1.0
Remote tag object: 6def80e0f0ddfbed700819e25e99a08d7e0e58ca
Remote peeled commit: b65ba2e475c106c815d2baab4291983863616e55
Tag was not moved or rewritten.
Range: v1.1.0..candidate

## Change census

Total commits: 222
feat: 15
fix: 21
perf: 2
docs: 12
chore: 53
ci: 2
test: 9
refactor: 0
build: 0
other: 108
Breaking-change footer: 0
Type ! marker: 0
Semver proposal: v1.2.0 (minor; no major marker)

## Hosted CI

Exact candidate CI: run 41320203597, https://github.com/wojons/duckbrain/actions/runs/41320203597
Head SHA: 771d5e0b1f270039c8ffceafcfc2a083f1a4ff6b
Workflow/event: CI / push
Conclusion: success
Job test: success, job 124888570191, 35 successful steps
Job docker: success, job 124889437515, 9 successful steps

Previous candidate red run: 41315780696 on 4cd55464d4c5efd1b0ab1c439ac525c25a399084; test failed at Run tests and docker was skipped. It is not evidence against the current candidate, but remains historical context.
Tag-trigger workflow exists in .github/workflows/release.yml and triggers on v* tags. It installs dependencies, runs tests, and creates a GitHub Release; it does not publish package or Docker assets.

## GitReins and dogfood

No GitReins verdict.json covers candidate 771d5e0b1f270039c8ffceafcfc2a083f1a4ff6b. The latest local verdict for INT-CI-035 covers 0b422bff and has overall passed=false because the tier1 secrets scope check remains red, although tier2 and product tests passed.

Latest committed dogfood report located: docs/dogfood/2026-10-27-cli-install-integration.md and diagnostics Run 18. Verdict: PROMISING-BUT-ROUGH; it includes partial/unproven install evidence and does not approve the current candidate for release.

## Release surface and version hygiene

package.json version: 1.1.0
CHANGELOG.md: [Unreleased] exists; no [1.2.0] heading.
Repository-owned release tooling: .github/workflows/release.yml only. No Makefile release target, scripts/release*, GoReleaser config, release docs, npm publish configuration, or configured Docker registry push was found.
Existing GitHub Release objects: v1.0.0 only, with an empty body and zero assets. gh release view v1.1.0 returns not found. Existing v1.1.0 tag remains present remotely and unchanged.

## Deployed binary freshness

The live duckbrain-http.service runs from /home/kara/duckbrain and was started 2026-11-01 04:08:41 -05. The current candidate commit is timestamped 10:14:10 -05. The live CLI reports duckbrain v1.1.0. The deployed process therefore predates the candidate and its exact source revision is not independently stamped; deployment freshness is UNVERIFIED/stale relative to candidate, not a source-release verdict.

## Open blockers and decision

Open release-relevant board rows include RELEASE-2026-10-26-001 (owner authorization and release-surface/version-prep gate), RELEASE-2026-11-01-001 (this rolling readiness row), QA-DUCKBRAIN-PERF-3 (QA launch guard failure), and DF-2026-20 (GitReins secrets-scope disagreement). The repository board also contains the current release acceptance blockers named by prior sweeps; no release-cut authorization was found.

Decision: NO-GO / NOT AUTHORIZED. The current candidate has green exact-head CI, but cutting v1.2.0 remains blocked by absent owner authorization, missing version-prep commit, incomplete artifact strategy/release workflow, no current-candidate all-green GitReins verdict, dogfood not approved, and deployment freshness unverified. No tag, Release object, force-move, or artifact publication was performed.

Unblock path: record OWNER DECISION: RELEASE-2026-10-26-001 APPROVE_V1_2_0_CUT; prepare package.json 1.2.0 plus a dated CHANGELOG section; document/repair artifact publication; obtain a current non-degraded GitReins verdict and candidate dogfood approval; then re-run exact-head and tag-triggered CI before any authorized tag or Release mutation.
