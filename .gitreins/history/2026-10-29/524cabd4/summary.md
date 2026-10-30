# Verdict: DF-2026-10

**Task:** Fix DF-2026-10 scope regression test
**Evaluated:** 2026-10-29T10:48:20.137620
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✗ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✓ The DF-2026-10 gitleaks scope regression test must pass against the committed .gitleaks.toml and prove .gitreins is allowlisted without broadening source exemptions: Ran `npx vitest run src/test/gitleaks-scope.test.ts` (config test_command is `npx vitest run`) → exit_code 0, output: 'Test Files 1 passed (1) / Tests 1 passed (1)'. Also ran `npx vitest run src/test/` → exit_code 0, 'Test Files 3 passed (3) / Tests 14 passed (14)'. The test (src/test/gitleaks-scope.test.ts:18-27) parses the committed .gitleaks.toml [allowlist].paths block, asserts `harnessPattern` toBe "\\.gitreins/.*", asserts the regex matches '.gitreins/history/verdict.json' and '.gitreins/logs/guard.log' (true), and asserts it does NOT match 'src/index.ts' and 'src/git-reins.ts' (false) — i.e. allowlisting is scoped to .gitreins and does not broaden source exemptions. Independently reproduced against HEAD's config: patterns = [tests/.*, \.test\., \.spec\., \.md$, docs/.*, examples/.*, fixtures/.*, \.opencode/.*, namespaces/.*, \.gitreins/.*, \.gitleaks\.toml, \.pre-commit-config\.yaml]; regex \.gitreins/.* → .gitreins/history/verdict.json true, .gitreins/logs/guard.log true, src/index.ts false, src/git-reins.ts false, src/gitreins.ts false, src/secret.ts false. Commit 44339dbe added exactly one line '''\.gitreins/.*''' to .gitleaks.toml with no other path changes (git diff 44339dbe^ 44339dbe confirms 1 insertion). Working tree .gitleaks.toml is identical to HEAD (git diff HEAD -- .gitleaks.toml empty), so the test runs against the committed config. Test is wired into the default suite via vitest.config.ts:7 `include: ["src/**/*.test.ts"]`. Commit 03238e4d made the test CommonJS-safe (import.meta.dirname → __dirname), which is why it now passes. [resolution 0.06; .gitleaks.toml]
The DF-2026-10 gitleaks scope regression test passes (1/1, exit 0) against the committed .gitleaks.toml and asserts .gitreins/.* is allowlisted while src paths remain in scope, with the config change limited to a single added path.

## Summary

Judge Result: DF-2026-10

Stage tier1: FAIL
    ✗ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✓ The DF-2026-10 gitleaks scope regression test must pass against the committed .gitleaks.toml and prove .gitreins is allowlisted without broadening source exemptions: Ran `npx vitest run src/test/gitleaks-scope.test.ts` (config test_command is `npx vitest run`) → exit_code 0, output: 'Test Files 1 passed (1) / Tests 1 passed (1)'. Also ran `npx vitest run src/test/` → exit_code 0, 'Test Files 3 passed (3) / Tests 14 passed (14)'. The test (src/test/gitleaks-scope.test.ts:18-27) parses the committed .gitleaks.toml [allowlist].paths block, asserts `harnessPattern` toBe "\\.gitreins/.*", asserts the regex matches '.gitreins/history/verdict.json' and '.gitreins/logs/guard.log' (true), and asserts it does NOT match 'src/index.ts' and 'src/git-reins.ts' (false) — i.e. allowlisting is scoped to .gitreins and does not broaden source exemptions. Independently reproduced against HEAD's config: patterns = [tests/.*, \.test\., \.spec\., \.md$, docs/.*, examples/.*, fixtures/.*, \.opencode/.*, namespaces/.*, \.gitreins/.*, \.gitleaks\.toml, \.pre-commit-config\.yaml]; regex \.gitreins/.* → .gitreins/history/verdict.json true, .gitreins/logs/guard.log true, src/index.ts false, src/git-reins.ts false, src/gitreins.ts false, src/secret.ts false. Commit 44339dbe added exactly one line '''\.gitreins/.*''' to .gitleaks.toml with no other path changes (git diff 44339dbe^ 44339dbe confirms 1 insertion). Working tree .gitleaks.toml is identical to HEAD (git diff HEAD -- .gitleaks.toml empty), so the test runs against the committed config. Test is wired into the default suite via vitest.config.ts:7 `include: ["src/**/*.test.ts"]`. Commit 03238e4d made the test CommonJS-safe (import.meta.dirname → __dirname), which is why it now passes. [resolution 0.06; .gitleaks.toml]
The DF-2026-10 gitleaks scope regression test passes (1/1, exit 0) against the committed .gitleaks.toml and asserts .gitreins/.* is allowlisted while src paths remain in scope, with the config change limited to a single added path.

Overall: FAIL ✗
