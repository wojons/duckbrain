# DuckBrain release readiness evidence — 2026-11-10 pass 5

Scheduler tick: `duckbrain-releng-2026-11-10-05-41-03` (pass 5; pass 4 ran at c12ead3f).
Target: wojons/duckbrain. Canonical repository: `/home/kara/duckbrain`.
Authoritative remote: `origin = https://github.com/wojons/duckbrain.git`. Default branch: `main`.

## Identity and candidate

Resolved root `/home/kara/duckbrain`, matched remote `wojons/duckbrain`, GitHub repo `wojons/duckbrain` — all agree.
Candidate: `4e62f5e60da9fbc4f21eef15e595e6b7a0da8135`. Local `HEAD`, `origin/main` and `ls-remote origin refs/heads/main` agree.
Lane checkout was 1 commit behind `origin/main` with a stale sibling append in `events.jsonl`; all checks ran in a detached worktree at the candidate (`/home/kara/.hermes/cache/scratch/release-worktree.jm2E5vbU`), root and remote re-asserted there.

Delta since pass 4's certified tip `c12ead3f`: `git diff --name-only c12ead3..4e62f5e6` = `.coding-hermes/board/events.jsonl`, `.coding-hermes/board/tasks.jsonl` — zero non-board paths, so bookkeeping only. The census below was nonetheless re-counted at the new tip rather than carried.

## Baseline and change census

Baseline tag `v1.1.0`, tag object `6def80e0f0ddfbed700819e25e99a08d7e0e58ca`, peeled commit `b65ba2e475c106c815d2baab4291983863616e55` — unchanged, verified by `git ls-remote origin 'refs/tags/v1.1.0*'`.

Range `v1.1.0..4e62f5e6`: 420 commits, 401 non-merge.
Conventional classes: `feat` 28, `fix` 35, `perf` 5 (4 non-merge), `docs` 22, `chore` 70, `test` 15, `ci` 3, plus board/releng/pm/dogfood/qa bookkeeping and 10 merge commits. Material non-merge (`^(feat|fix|perf)`) = 67.
Breaking markers (`BREAKING CHANGE` footer or `type!:` subject) = 0.

Semver: **minor → v1.2.0**. `v1.2.0` is absent locally and remotely (`git ls-remote --tags origin` shows only v1.0.0 and v1.1.0).

## Correction carried into this pass: the CHANGELOG coverage blocker was already discharged

Passes 2–4 recorded "the `## [1.2.0]` section predates N material commits and must be reconciled" as the live cut blocker. That premise is refuted at this tip.

Six commits already did that reconciliation — `c67d70c9`, `b162c7bc`, `add7d89f`, `12a6628b`, `c2de6ad4`, `e5590b96`, all titled `docs(release): reconcile v1.2.0 changelog coverage`.

Verification method: extract the `## [1.2.0]` section, then test each short SHA of the 25 material non-merge commits in `1364dc4f..HEAD`:

```
awk '/^## \[1.2.0\]/{f=1;next}/^## \[/{f=0}f' CHANGELOG.md > sec.txt
for s in $(git log --no-merges --format='%h %s' 1364dc4f..HEAD \
           | grep -E '^([0-9a-f]+) (feat|fix|perf)' | cut -d' ' -f1); do
  grep -q "$s" sec.txt || echo "MISSING $s"; done
```

Result: **25 material commits, 25 cited, 0 missing**; the section holds 32 product-visible entries.

What remains stale is only the numeric `Range:` preamble (CHANGELOG.md:9-13), which `release.yml` publishes verbatim:

| field | file says | measured at 4e62f5e6 |
|---|---|---|
| total commits | 397 | 420 |
| non-merge commits | 379 | 401 |
| perf commits | 4 | 4 (non-merge) |
| post-prep `1364dc4f..HEAD` | 142 | 165 |

The drift is entirely bookkeeping commits — no product change. It must be refreshed at the cut commit, not now; refreshing it today only re-stales it on the next board commit.

## Hosted CI

Exact candidate run: `42767574607` (workflow CI, event push, status completed, conclusion success) —
<https://github.com/wojons/duckbrain/actions/runs/42767574607>.
Supersedes `42766044169` at `c12ead3f` (also completed/success).
No run is red or absent on the candidate.

`release.yml`'s own precondition — a successful CI **push** run on `main` bound to the tagged SHA — is therefore satisfiable for any tag placed on `4e62f5e6` or a later green tip.

## GitReins and dogfood

`docs/release-artifact-scope.md` is the repository's release authority and names neither GitReins nor dogfood; its cut checklist is exact-SHA CI + a `## [X.Y.Z]` CHANGELOG section + matching `package.json` version + annotated tag + untouched previous tag. Both are recorded here as evidence, not as publish gates.

- GitReins: no committed verdict.json covers `4e62f5e6`; the latest committed passing verdict is on an ancestor. Evidence gap, not a pass.
- Dogfood: latest record remains PROMISING-BUT-ROUGH; `DF-2026-21` open (legacy search redirect), bunker install leg install-proven but isolation-UNVERIFIED.

## Release tooling and previous artifacts

Repository-owned publisher: `.github/workflows/release.yml` (tag-triggered; verifies the tagged commit's main CI run via API, extracts the matching CHANGELOG section, `gh release create --verify-tag`, refuses to overwrite). No Makefile release target, no `scripts/release*`, no GoReleaser. `docs/release-artifact-scope.md` explicitly excludes npm publish and registry image push; Docker is a local build only.

- `v1.0.0` Release object: exists, **body empty, zero assets**.
- `v1.1.0`: tag exists, **no Release object** (`gh release view v1.1.0` → not found); its original tag run `39539627477` died at "Run tests" under the pre-repair workflow.
- `v1.2.0`: not cut.

v1.1.0 is immutable here; it needs an explicit back-fill or a written tag-only decision (owned by RELEASE-2026-11-09-001 part B).

## Deployed surface

`/health` on `127.0.0.1:3000` answers `status: healthy`, uptime 247560 s (~2.87 d, boot ≈ 2026-11-07), embedding provider healthy. The payload exposes **no** `code.loaded_commit` / `repo_commit` / `stale` field, so deployed-binary staleness is **UNMEASURED** — recorded as such rather than inferred from process age. `OBSDB-007` owns the redeploy of the current tree.

## Public posture

| surface | state |
|---|---|
| visibility | public, not archived |
| license | Apache-2.0 |
| default branch | main |
| branch protection on main | **unprotected** (`GET /branches/main/protection` → 404 "Branch not protected") |
| secret scanning / push protection | UNVERIFIED — `security_and_analysis` empty at this token's scope |

## Dependencies

`DEP-DUCKBRAIN-001` (P3, pending): 23 Node packages behind per the `check-deps` scan of 2026-11-09. No advisory-backed finding surfaced this pass, so nothing was promoted. Deferred per skill §6 (patch/minor batch at release time, majors never automatic); the row already carries "plan upgrade, do not auto-apply".

## Open blockers

Board state at the candidate: 2 × P0, 29 × P1, 26 × P2, 13 × P3, 2 × P4 across pending/blocked/in_progress.

Release-relevant:

1. **RELEASE-VERSION-001** (P2 → **P1** this pass): `package.json` is 1.2.0 while `README.md:3` badge, `.github/workflows/ci.yml:47` assertion and `src/cli/human.ts:2313` help banner all still say 1.1.0. CI is green *because* it asserts the stale string. This is now the **only** agent-executable blocker between `main` and the v1.2.0 tag.
2. **RELEASE-2026-11-09-001** (P1): restored to `pending` this pass. A foreman event at 06:15:39Z (id 8604) had set it to `blocked` with `blocked_reason: null`, leaving the only cut-prep row undispatched with nothing recording why. Acceptance criteria rewritten to the work that actually remains (cut-time Range refresh; v1.1.0 release-object decision).
3. `HARDEN-DUCKBRAIN-001` (P0, pending) and 28 other P1s are product-hardening rows, not release-surface rows; they do not gate a minor cut under this repo's own release contract.

## Decision

**NO-GO on the tag this pass — one small dev row away.**

Minor bump v1.2.0 is due and releng-authorized (features present, no breaking change, exact-SHA CI green). It is withheld only because the version surfaces disagree, which would ship an artifact whose `--version` says 1.2.0 and whose `help` says v1.1.0. No tag was created, moved or deleted; no Release object was created; v1.1.0 remains `6def80e0`.

Unblock sequence: land RELEASE-VERSION-001 → land RELEASE-2026-11-09-001 part A (Range preamble at the cut SHA) → tag `v1.2.0` on the green tip → `release.yml` publishes from the CHANGELOG section → verify `gh release view`, tag-SHA CI and tag-run CI.
