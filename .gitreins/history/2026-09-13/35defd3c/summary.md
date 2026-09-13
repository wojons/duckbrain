# Verdict: OPS-004

**Task:** Repair live embedding provider health
**Evaluated:** 2026-09-13T02:13:55.615774
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: [90m9:08PM[0m [32mINF[0m [1mscanned ~7545693 bytes (7.55 MB) in 1.34s[0m
[90m9:08PM[0m [32m
  ✓ tests:
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  118 passed (118)
      Tests  1020 passed (1020)

- ✓ **tier2**
  - COMPLETE
  ✓ A real semantic query completes, /health reports embedding.healthy=true, provider choice is fail-closed and documented, and regression tests prevent an auth/config mismatch from being reported healthy.: (1) Real semantic query: recallTool({namespace:'coding-hermes-boardctl',query:'embedding provider health',limit:3}) with live env (openai/qwen3-embedding-8b/openrouter/4096/30000ms) returned 'RECALL OK' with a scored memory (score 0.49965619701174013). (2) /health healthy=true: live daemon :3000 polled 5x -> status=healthy, embedding.healthy=True, provider=openai (5/5); fresh probeEmbeddingHealth() with live env -> {provider:'openai',healthy:true,note:'ok'}. (3) Fail-closed: src/embedding/preflight.ts ok=checks.every(c=>c.verdict!=='fail'), asymmetric=reachability pass && usability fail, summary 'FAIL (closed)'; src/cli/embedding-preflight.ts runEmbeddingPreflightCli returns 1 when !ok (live preflight exit 0 on usable path). (4) Documented: docs/guide/embeddings.md lines 154-290 (exit codes, check table, verified signal table, config precedence incl. systemd env-at-start, latency table, rollback), plus README.md and docs/api/http-api.md. (5) Regression tests: src/embedding/health-dogfood020.test.ts describe('OPS-004...') covers auth-class distinction (credential_not_presented vs credential_rejected), 'names the auth class in the /health note when the credential never arrives' (asserts healthy=false), 'fails closed on the OPS-004 asymmetric condition (/models 200, /embeddings 401)', and secret redaction. Full suite: npx vitest run -> Test Files 118 passed (118), Tests 1020 passed (1020), EXIT=0.
All sub-parts verified with live evidence: a real semantic query returns scored results, live /health reports embedding.healthy=true with provider=openai, the preflight fails closed on the asymmetric condition, the runbook is documented, and the OPS-004 regression tests plus the full 1020-test suite pass.

## Summary

Judge Result: OPS-004

Stage tier1: PASS
    ✓ secrets: [90m9:08PM[0m [32mINF[0m [1mscanned ~7545693 bytes (7.55 MB) in 1.34s[0m
[90m9:08PM[0m [32m
  ✓ tests:
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  118 passed (118)
      Tests  1020 passed (1020)


Stage tier2: PASS
  COMPLETE
  ✓ A real semantic query completes, /health reports embedding.healthy=true, provider choice is fail-closed and documented, and regression tests prevent an auth/config mismatch from being reported healthy.: (1) Real semantic query: recallTool({namespace:'coding-hermes-boardctl',query:'embedding provider health',limit:3}) with live env (openai/qwen3-embedding-8b/openrouter/4096/30000ms) returned 'RECALL OK' with a scored memory (score 0.49965619701174013). (2) /health healthy=true: live daemon :3000 polled 5x -> status=healthy, embedding.healthy=True, provider=openai (5/5); fresh probeEmbeddingHealth() with live env -> {provider:'openai',healthy:true,note:'ok'}. (3) Fail-closed: src/embedding/preflight.ts ok=checks.every(c=>c.verdict!=='fail'), asymmetric=reachability pass && usability fail, summary 'FAIL (closed)'; src/cli/embedding-preflight.ts runEmbeddingPreflightCli returns 1 when !ok (live preflight exit 0 on usable path). (4) Documented: docs/guide/embeddings.md lines 154-290 (exit codes, check table, verified signal table, config precedence incl. systemd env-at-start, latency table, rollback), plus README.md and docs/api/http-api.md. (5) Regression tests: src/embedding/health-dogfood020.test.ts describe('OPS-004...') covers auth-class distinction (credential_not_presented vs credential_rejected), 'names the auth class in the /health note when the credential never arrives' (asserts healthy=false), 'fails closed on the OPS-004 asymmetric condition (/models 200, /embeddings 401)', and secret redaction. Full suite: npx vitest run -> Test Files 118 passed (118), Tests 1020 passed (1020), EXIT=0.
All sub-parts verified with live evidence: a real semantic query returns scored results, live /health reports embedding.healthy=true with provider=openai, the preflight fails closed on the asymmetric condition, the runbook is documented, and the OPS-004 regression tests plus the full 1020-test suite pass.

Overall: PASS ✓
