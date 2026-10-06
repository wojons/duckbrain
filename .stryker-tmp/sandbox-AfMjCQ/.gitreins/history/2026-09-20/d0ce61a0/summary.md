# Verdict: DF-0919-04

**Task:** /health aggregate ignores unconfigured providers
**Evaluated:** 2026-09-20T02:31:05.734238
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: RUN  v4.1.10 /home/kara/duckbrain
- ✓ **tier2**
  - COMPLETE
  ✓ src/embedding/health.ts distinguishes CONFIGURED from UNCONFIGURED embedding providers: a provider with no credentials configured (keyless openai, note 'missing API key') does NOT drag the /health aggregate to degraded/unhealthy, while still appearing in providers[] with healthy:false and its note. A provider that IS configured and fails (timeout / HTTP error / capability gate) still degrades the aggregate. New tests in src/embedding/health-dogfood020.test.ts cover keyless-openai + healthy-local aggregate healthy, keyless-openai-alone not fake-green, configured-openai HTTP 500 still degrading, and providers[] still listing the keyless provider. Full npx vitest run green and tsc clean on the merged tree.: src/embedding/health.ts:159-165 adds providerConfigured() (openai configured iff cfg.apiKey !== ""; lmstudio/ollama always true). classifyUnhealthy (line ~178) returns 'missing API key (DUCKBRAIN_EMBEDDING_API_KEY)' only for unconfigured openai. Aggregate is healthy = winner !== "" (line ~322); winner is set only by a real embed probe on a provider that passed its cheap gate, and openai's isHealthy returns Boolean(cfg.apiKey) (providers.ts:409), so keyless openai never wins and cannot degrade the aggregate. The keyless provider is still pushed into providers[] with healthy:false + its note (line ~289). A configured openai that fails its embed probe leaves winner==="" -> healthy:false. /health consumes embedding.healthy for degraded/503 (src/cli/http.ts:312,324). Tests: src/embedding/health-dogfood020.test.ts:372 (keyless openai + healthy lmstudio -> healthy true), :389 (keyless openai alone -> healthy false), :405 (configured openai HTTP 500 -> healthy false, note /embed HTTP 500/), :430 (providers[] lists keyless openai with note 'missing API key (DUCKBRAIN_EMBEDDING_API_KEY)'). Command evidence: `npx vitest run src/embedding/health-dogfood020.test.ts -t "DF-0919-04"` -> 'Tests 5 passed | 39 skipped (44)'; full `npx vitest run` -> 'Test Files 155 passed (155), Tests 1226 passed (1226)', EXIT=0; `npx tsc --noEmit` -> exit 0, no output; LSP diagnostics empty.
health.ts now excludes unconfigured (keyless) providers from the /health aggregate while still listing them, configured failures still degrade, and the new DF-0919-04 tests plus full vitest run and tsc are all green.

## Summary

Judge Result: DF-0919-04

Stage tier1: FAIL
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: RUN  v4.1.10 /home/kara/duckbrain

Stage tier2: PASS
  COMPLETE
  ✓ src/embedding/health.ts distinguishes CONFIGURED from UNCONFIGURED embedding providers: a provider with no credentials configured (keyless openai, note 'missing API key') does NOT drag the /health aggregate to degraded/unhealthy, while still appearing in providers[] with healthy:false and its note. A provider that IS configured and fails (timeout / HTTP error / capability gate) still degrades the aggregate. New tests in src/embedding/health-dogfood020.test.ts cover keyless-openai + healthy-local aggregate healthy, keyless-openai-alone not fake-green, configured-openai HTTP 500 still degrading, and providers[] still listing the keyless provider. Full npx vitest run green and tsc clean on the merged tree.: src/embedding/health.ts:159-165 adds providerConfigured() (openai configured iff cfg.apiKey !== ""; lmstudio/ollama always true). classifyUnhealthy (line ~178) returns 'missing API key (DUCKBRAIN_EMBEDDING_API_KEY)' only for unconfigured openai. Aggregate is healthy = winner !== "" (line ~322); winner is set only by a real embed probe on a provider that passed its cheap gate, and openai's isHealthy returns Boolean(cfg.apiKey) (providers.ts:409), so keyless openai never wins and cannot degrade the aggregate. The keyless provider is still pushed into providers[] with healthy:false + its note (line ~289). A configured openai that fails its embed probe leaves winner==="" -> healthy:false. /health consumes embedding.healthy for degraded/503 (src/cli/http.ts:312,324). Tests: src/embedding/health-dogfood020.test.ts:372 (keyless openai + healthy lmstudio -> healthy true), :389 (keyless openai alone -> healthy false), :405 (configured openai HTTP 500 -> healthy false, note /embed HTTP 500/), :430 (providers[] lists keyless openai with note 'missing API key (DUCKBRAIN_EMBEDDING_API_KEY)'). Command evidence: `npx vitest run src/embedding/health-dogfood020.test.ts -t "DF-0919-04"` -> 'Tests 5 passed | 39 skipped (44)'; full `npx vitest run` -> 'Test Files 155 passed (155), Tests 1226 passed (1226)', EXIT=0; `npx tsc --noEmit` -> exit 0, no output; LSP diagnostics empty.
health.ts now excludes unconfigured (keyless) providers from the /health aggregate while still listing them, configured failures still degrade, and the new DF-0919-04 tests plus full vitest run and tsc are all green.

Overall: FAIL ✗
