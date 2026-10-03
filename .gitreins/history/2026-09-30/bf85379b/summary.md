# Verdict: HEALTH-KEYS-UNDEFINED-001

**Task:** Fix fresh-install /health degraded: keys_error Namespace undefined
**Evaluated:** 2026-09-30T00:16:27.003038
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v5.0.1 /home/kara/duckbrain
- ✓ **tier2**
  - COMPLETE
  ✓ curl /health on a fresh empty daemon returns 200 status=healthy (or at minimum not degraded due to keys probe); probeKeysStore passes the resolved default namespace name; grep confirms no raw 'undefined' interpolation in list_keys path; pnpm test:run green: All four sub-claims verified with hard evidence. (1) END-TO-END: started a real daemon (npx tsx bin/duckbrain.ts http --port 3399) with DUCKBRAIN_NAMESPACES_PATH=<empty tmpdir>; `curl -w HTTP=%{http_code} /health` returned HTTP=200 and body {"status":"healthy",...,"keys_error":null,"deadline_exceeded":[]} with no 'undefined' anywhere. The parent commit 653a105 under identical conditions returned HTTP=503 {"status":"degraded","keys_error":"Namespace 'undefined' does not exist"} — the exact reported bug, now fixed. (2) probeKeysStore (src/mcp/tools/list_keys.ts:388-410) now calls resolveNamespaceName(namespace) (src/mcp/tools/shared.ts:25 -> namespace || config.defaultNamespace || "default") and passes `namespace: resolvedNamespace` into runKeysQuery; it also returns null for a missing/empty namespace dir (fresh install). (3) grep -rn "'undefined'|\"undefined\"" src/mcp/tools/list_keys.ts src/cli/http.ts src/mcp/tools/shared.ts -> exit 1, no matches; runKeysQuery (list_keys.ts:164-176) throws `Namespace '${namespaceName}' does not exist` using the resolved name, never the raw arg. (4) TESTS: targeted `npx vitest run src/cli/http-health-dbgap035.test.ts src/mcp/tools/list-keys-dbgap035.test.ts` -> exit 0, 'Test Files 2 passed (2) / Tests 10 passed (10)'; full suite `npx vitest run` (= pnpm test:run) -> 'Test Files 188 passed (188) / Tests 1504 passed (1504)' GREEN. A first full-suite run showed one flaky failure in src/http/routes/memories-validuntil-retr011.test.ts (afterAll repo-config equality, cross-test config pollution from concurrent namespace-registry writes); that file passes in isolation (6/6), does not touch list_keys/probeKeysStore/keys_error, and the suite is green on re-run — pre-existing flakiness, not attributable to this change. New test src/cli/http-health-dbgap035.test.ts:118-146 asserts empty namespaces root -> 200/healthy/keys_error null/no 'undefined'.
The keys probe now resolves the config default namespace instead of interpolating raw undefined, and a real fresh-install daemon returns 200 healthy with keys_error null (parent commit reproduced the 503 'Namespace undefined' bug); full vitest suite is green at 188 files / 1504 tests.

## Summary

Judge Result: HEALTH-KEYS-UNDEFINED-001

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v5.0.1 /home/kara/duckbrain

Stage tier2: PASS
  COMPLETE
  ✓ curl /health on a fresh empty daemon returns 200 status=healthy (or at minimum not degraded due to keys probe); probeKeysStore passes the resolved default namespace name; grep confirms no raw 'undefined' interpolation in list_keys path; pnpm test:run green: All four sub-claims verified with hard evidence. (1) END-TO-END: started a real daemon (npx tsx bin/duckbrain.ts http --port 3399) with DUCKBRAIN_NAMESPACES_PATH=<empty tmpdir>; `curl -w HTTP=%{http_code} /health` returned HTTP=200 and body {"status":"healthy",...,"keys_error":null,"deadline_exceeded":[]} with no 'undefined' anywhere. The parent commit 653a105 under identical conditions returned HTTP=503 {"status":"degraded","keys_error":"Namespace 'undefined' does not exist"} — the exact reported bug, now fixed. (2) probeKeysStore (src/mcp/tools/list_keys.ts:388-410) now calls resolveNamespaceName(namespace) (src/mcp/tools/shared.ts:25 -> namespace || config.defaultNamespace || "default") and passes `namespace: resolvedNamespace` into runKeysQuery; it also returns null for a missing/empty namespace dir (fresh install). (3) grep -rn "'undefined'|\"undefined\"" src/mcp/tools/list_keys.ts src/cli/http.ts src/mcp/tools/shared.ts -> exit 1, no matches; runKeysQuery (list_keys.ts:164-176) throws `Namespace '${namespaceName}' does not exist` using the resolved name, never the raw arg. (4) TESTS: targeted `npx vitest run src/cli/http-health-dbgap035.test.ts src/mcp/tools/list-keys-dbgap035.test.ts` -> exit 0, 'Test Files 2 passed (2) / Tests 10 passed (10)'; full suite `npx vitest run` (= pnpm test:run) -> 'Test Files 188 passed (188) / Tests 1504 passed (1504)' GREEN. A first full-suite run showed one flaky failure in src/http/routes/memories-validuntil-retr011.test.ts (afterAll repo-config equality, cross-test config pollution from concurrent namespace-registry writes); that file passes in isolation (6/6), does not touch list_keys/probeKeysStore/keys_error, and the suite is green on re-run — pre-existing flakiness, not attributable to this change. New test src/cli/http-health-dbgap035.test.ts:118-146 asserts empty namespaces root -> 200/healthy/keys_error null/no 'undefined'.
The keys probe now resolves the config default namespace instead of interpolating raw undefined, and a real fresh-install daemon returns 200 healthy with keys_error null (parent commit reproduced the 503 'Namespace undefined' bug); full vitest suite is green at 188 files / 1504 tests.

Overall: PASS ✓
