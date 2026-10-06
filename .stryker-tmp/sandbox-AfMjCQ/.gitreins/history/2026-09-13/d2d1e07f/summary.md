# Verdict: OPS-004

**Task:** Repair live embedding provider health
**Evaluated:** 2026-09-13T02:58:38.186596
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: [90m9:54PM[0m [32mINF[0m [1mscanned ~7562208 bytes (7.56 MB) in 1.46s[0m
[90m9:54PM[0m [32m
  ✓ tests:
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  118 passed (118)
      Tests  1027 passed (1027)

- ✓ **tier2**
  - COMPLETE
  ✓ A real semantic query completes, /health reports embedding.healthy=true, provider choice is fail-closed and documented, and regression tests prevent an auth/config mismatch from being reported healthy.: All four sub-claims verified with live + test evidence. (1) REAL SEMANTIC QUERY: `node scripts/embedding-preflight.js` with the daemon's real key → EXIT=0, 'PASS: openai/qwen/qwen3-embedding-8b embedded a live vector (4096 dims)'; `createAutoProviders()`+`embed()` live → 'REAL EMBED OK dims= 4096 provider= openai/qwen/qwen3-embedding-8b'. (2) /health healthy=true: `createHealthHandler()` (src/cli/http.ts:239) run with the fixed code + live env → HTTP 200, body {"status":"healthy","embedding":{"provider":"openai","healthy":true,"providers":[{"id":"openai","healthy":true,"note":"ok"}]}}. (3) FAIL-CLOSED: empty API key → preflight EXIT=1 'FAIL (closed) ... credential_not_presented ... [reachable-but-unusable: the OPS-004 asymmetric condition]'; real key → EXIT=0. Runtime recall.ts:701-745 surfaces semanticError when no provider can embed (never a silent unfiltered list); providers.ts:521-528 keeps an explicit provider a hard requirement with no fallback. (4) DOCUMENTED: docs/guide/embeddings.md (311 lines) adds the OPS-004 preflight runbook, config precedence, verified signal table, remote-vs-local latency, rollback steps and skip-verdict semantics; docs/api/http-api.md documents the classed /health notes + preflight pointer; README.md updated. (5) REGRESSION TESTS: `npx vitest run` → EXIT=0, 'Test Files 118 passed (118)', 'Tests 1027 passed (1027)'; src/embedding/health-dogfood020.test.ts 39 passed (20 OPS-004 tests). Key guards: 'fails closed on the OPS-004 asymmetric condition (/models 200, /embeddings 401)' (line 722) asserts report.ok=false, asymmetric=true, usability.failure_class='credential_not_presented'; 'names the auth class in the /health note when the credential never arrives' (line 682) asserts healthy=false and note contains 'auth: credential not presented'; 'auto fails closed ONLY when no candidate proves usability' (line 1129) asserts CLI exit 1. `npx tsc --noEmit` EXIT=0, zero LSP diagnostics. Caveat (not a code defect): the running daemon pid 183596 started 14:34, before fix commit 646b2a3 (21:50), so it still serves the pre-fix note 'The operation was aborted due to timeout'; the fixed code returns healthy=true.
All OPS-004 sub-claims verified: a real 4096-dim embed completes live, the fixed /health handler returns embedding.healthy=true (HTTP 200), provider choice fails closed (exit 1 on auth mismatch, exit 0 on real key), the behavior is documented in docs/guide/embeddings.md + docs/api/http-api.md, and 1027/1027 tests pass including regression tests pinning the auth/config mismatch to unhealthy.

## Summary

Judge Result: OPS-004

Stage tier1: PASS
    ✓ secrets: [90m9:54PM[0m [32mINF[0m [1mscanned ~7562208 bytes (7.56 MB) in 1.46s[0m
[90m9:54PM[0m [32m
  ✓ tests:
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  118 passed (118)
      Tests  1027 passed (1027)


Stage tier2: PASS
  COMPLETE
  ✓ A real semantic query completes, /health reports embedding.healthy=true, provider choice is fail-closed and documented, and regression tests prevent an auth/config mismatch from being reported healthy.: All four sub-claims verified with live + test evidence. (1) REAL SEMANTIC QUERY: `node scripts/embedding-preflight.js` with the daemon's real key → EXIT=0, 'PASS: openai/qwen/qwen3-embedding-8b embedded a live vector (4096 dims)'; `createAutoProviders()`+`embed()` live → 'REAL EMBED OK dims= 4096 provider= openai/qwen/qwen3-embedding-8b'. (2) /health healthy=true: `createHealthHandler()` (src/cli/http.ts:239) run with the fixed code + live env → HTTP 200, body {"status":"healthy","embedding":{"provider":"openai","healthy":true,"providers":[{"id":"openai","healthy":true,"note":"ok"}]}}. (3) FAIL-CLOSED: empty API key → preflight EXIT=1 'FAIL (closed) ... credential_not_presented ... [reachable-but-unusable: the OPS-004 asymmetric condition]'; real key → EXIT=0. Runtime recall.ts:701-745 surfaces semanticError when no provider can embed (never a silent unfiltered list); providers.ts:521-528 keeps an explicit provider a hard requirement with no fallback. (4) DOCUMENTED: docs/guide/embeddings.md (311 lines) adds the OPS-004 preflight runbook, config precedence, verified signal table, remote-vs-local latency, rollback steps and skip-verdict semantics; docs/api/http-api.md documents the classed /health notes + preflight pointer; README.md updated. (5) REGRESSION TESTS: `npx vitest run` → EXIT=0, 'Test Files 118 passed (118)', 'Tests 1027 passed (1027)'; src/embedding/health-dogfood020.test.ts 39 passed (20 OPS-004 tests). Key guards: 'fails closed on the OPS-004 asymmetric condition (/models 200, /embeddings 401)' (line 722) asserts report.ok=false, asymmetric=true, usability.failure_class='credential_not_presented'; 'names the auth class in the /health note when the credential never arrives' (line 682) asserts healthy=false and note contains 'auth: credential not presented'; 'auto fails closed ONLY when no candidate proves usability' (line 1129) asserts CLI exit 1. `npx tsc --noEmit` EXIT=0, zero LSP diagnostics. Caveat (not a code defect): the running daemon pid 183596 started 14:34, before fix commit 646b2a3 (21:50), so it still serves the pre-fix note 'The operation was aborted due to timeout'; the fixed code returns healthy=true.
All OPS-004 sub-claims verified: a real 4096-dim embed completes live, the fixed /health handler returns embedding.healthy=true (HTTP 200), provider choice fails closed (exit 1 on auth mismatch, exit 0 on real key), the behavior is documented in docs/guide/embeddings.md + docs/api/http-api.md, and 1027/1027 tests pass including regression tests pinning the auth/config mismatch to unhealthy.

Overall: PASS ✓
