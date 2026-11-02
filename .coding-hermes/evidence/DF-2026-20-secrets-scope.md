# DF-2026-20 — tier1 secrets scope disagreement: root cause + fix evidence

Date: 2026-11-02 · Shipped tool: pipx gitreins 0.17.1 (`~/.local/bin/gitreins`,
installed from `file:///home/kara/gitreins`) · Tree: duckbrain origin/main
(03f98adb) → fix branch `wt/DF-2026-20`.

## Root cause (two defects, neither was a .gitreins/** scope disagreement)

1. **The real failure — builtin credential-store PATH class on tracked
   `.npmrc` / `.env.example`.** Both scanners already exclude harness state in
   the shipped tool: the generated gitleaks config allowlists
   `(^|/)\.gitreins/.*` (`harness_state_allowlist_paths`, TRUST-002) and the
   builtin prunes `HARNESS_STATE_DIRS` + skips `_is_harness_state_path`
   per-file. The five 2026-10-30 verdicts (55043021/761c8c9f/3786436f/
   ed0feed3/a38df962) failed because gitreins 0.17.1's builtin cross-check
   fails credential-store PATHs REGARDLESS of content (REVIEW-GITREINS-027),
   deliberately checked BEFORE `.gitleaks.toml` allowlists (GR-GAP-007), and
   duckbrain tracks `.npmrc` + `.env.example` at the repo root. gitleaks
   (content-based, honouring repo config) was clean in every one of them —
   the disagreement was builtin-path-class vs gitleaks-content on TRACKED
   files, never harness-state scope.

2. **The misdiagnosis amplifier — verdict summaries picked the wrong line.**
   `_secrets_step_run` echoed `secrets: harness state excluded from gitleaks
   scope (.gitreins/**)` UNCONDITIONALLY as the first output line, and
   `Pipeline._summarize_stage` renders a failing step's detail as the first
   non-blank output line when no pytest-shaped failure line matches (no
   `FAILED x::` lines exist in secrets output). Result: every secrets FAIL —
   including all five verdicts and DF-2026-10's b54dd019/2d680b63 — was
   narrated as a harness-state scope disagreement. DF-2026-20 was filed on
   exactly that misreading; DF-2026-10's closure (03238e4d, repo-config-text
   test only) never touched the shipped tool, so the failure persisted.

## Fix

- **Tool (shipped pipx venv 0.17.1, `engine/pipeline.py` + `engine/types.py`)**:
  (a) the harness-state exclusion echo moved into the gitleaks-FAILURE branch
  only (TRUST-002 diagnosis path preserved — it now follows the findings
  evidence instead of preceding it); (b) `_summarize_stage` prefers
  `_SECRETS_FINDING_LINE` evidence (builtin `SENSITIVE PATH (credential-store
  path class)` lines, gitleaks `Finding:` blocks) over the first-line
  fallback. Ported to the gitreins source repo on branch `wt/DF-2026-20-port`.
- **Repo (this commit)**: `guards.sensitive_paths.allow: [".npmrc",
  ".env.example"]` in `.gitreins/config.yaml` — the sanctioned, auditable
  escape for the path class (each pass records `sensitive-path override
  applied:` notes; never silent). Regression tests extended in
  `src/test/gitleaks-scope.test.ts`: every tracked credential-store path must
  be override-covered (red-proved: fails when the override is stashed), and
  every tracked `.gitreins/**` file must stay inside the gitleaks harness
  exclusion.

## RED — shipped tool, pre-fix tree (2026-11-02 02:22, exit=1)

    secrets: harness state excluded from gitleaks scope (.gitreins/**)   <- first line = what summaries blamed
    secrets: scanners=gitleaks+builtin cross-check
    secrets: gitleaks: clean
    Secrets scan: 2 potential findings
    secrets: builtin cross-check: Potential secrets found:
    .npmrc: SENSITIVE PATH (credential-store path class) — ...
    .env.example: SENSITIVE PATH (credential-store path class) — ...
    secrets: builtin cross-check status: 2 findings
    exit=1

Byte-identical failure shape to verdict 55043021
(`.gitreins/history/2026-10-30/55043021/verdict.json`, committed).

## Summarizer probe — patched `_summarize_stage` on the red output

    SUMMARY: ✗ secrets: .npmrc: SENSITIVE PATH (credential-store path class) — staging this file is blocked regardless of co
    OK: failing step now names the finding, not the scope banner

## BLUE — shipped tool (patched) + override (2026-11-02 02:25, exit=0)

    secrets: scanners=gitleaks+builtin cross-check
    secrets: gitleaks: clean
    secrets: builtin cross-check: Scanned 1010 files — clean (excluded harness state: .gitreins/**)
    sensitive-path override applied: .npmrc
    sensitive-path override applied: .env.example
    secrets: builtin cross-check status: clean
    exit=0

AC1: secrets leg PASS; the PASS output prints the scanners' harness-state
agreement (`excluded harness state: .gitreins/**`) and carries no harness-state
scope message (AC2 — the message now exists only in the gitleaks-failure
diagnosis branch). Same tree produced exit=1 red before the fix.

## Reproduction commands

    # step command builder/runner: ~/.hermes/cache/scratch/df-2026-20-evidence/
    #   build_step_cmd.py, run_secrets_step.sh, probe_summarize.py
    # red/blue logs: .../df-2026-20-evidence/{red-origin-main,blue-fixed}.log
    # test red-proof: `git stash push -- .gitreins/config.yaml` → vitest red → pop

## Residual disclosure

- The live pipx venv carries the pipeline.py/types.py patch in place
  (site-packages). A future `pipx upgrade` replaces it — the identical change
  is committed on gitreins branch `wt/DF-2026-20-port` (with unit tests) so
  the next release carries it. Re-running the five verdicts' full judges was
  not needed: the disputed leg is the secrets step, exercised above against
  the same tree with the shipped tool; tier1 tests were PASS in all five.
