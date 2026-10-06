# Verdict: DF-0924-05

**Task:** P0 UI dead on hardened auth deployments: hardcoded namespace, zero credentials, 429 storm
**Evaluated:** 2026-09-24T18:20:07.435631
**Result:** ✗ FAIL

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v5.0.1 /home/kara/duckbrain
- ✗ **tier2**
  - INCOMPLETE
  ✗ On an --auth=apikey scratch daemon: (1) UI boots with the server-reported currentNamespace (no queries against hardcoded 'default'); (2) all API calls attach X-API-Key from a user-entered token persisted in localStorage, with a visible token entry point; (3) 401/404 failures do not retry more than once (no 429 storm); (4) packages/ui pnpm build + pnpm test green including new regression tests; (5) root npx vitest run + npx tsc --noEmit remain green and AGENTS.md counts match live if root suite counts change: Sub-requirement (1) FAILS. App.tsx:29-42 AppShell calls useNamespaceBoot() but renders <Routes> unconditionally, so TimelinePage/TreePage mount on the first render and fire queries with the store's initial currentNamespace ('default', ui-store.ts:74) before GET /api/namespaces resolves. Empirical probe mounting the real AppShell wiring (useNamespaceBoot + ApiAuthBanner + a page calling useVitals(useCurrentNamespace())) recorded: ['/api/memories?namespace=default&limit=1','/api/memories?namespace=default&limit=100','/api/keys?namespace=default','/api/namespaces','/api/memories?namespace=work&limit=1',...] — i.e. 3 queries against hardcoded 'default' are dispatched before the server value arrives. With a persisted stale namespace the same probe fired 3 queries against 'stale-persisted' first. useNamespaceBoot (use-namespaces.ts:50-66) only adopts data.currentNamespace in a useEffect after the fetch resolves; it does not gate the first render. Sub-requirements (2),(3),(4),(5) PASS: (2) api-client.ts getApiToken/setApiToken/clearApiToken persist to localStorage key 'duckbrain-api-token', apiFetch attaches X-API-Key on every request when set, ApiTokenControl is rendered in header.tsx:112 and ApiAuthBanner provides a second visible entry point; api-auth.test.ts passes. (3) probe on a 401 boot recorded exactly 4 requests (one per query, zero retries); shouldRetryQuery returns false for ApiAuthError, useNamespaceBoot sets retry:false, and both QueryClients (App.tsx:17, main.tsx:15) use shouldRetryQuery. (4) `cd packages/ui && pnpm test` -> 'Test Files 9 passed (9) / Tests 54 passed (54)' exit 0; `pnpm build` -> 'tsc && vite build ... built in 1.72s' exit 0. (5) root `npx vitest run` -> 'Test Files 167 passed (167) / Tests 1332 passed (1332)' exit 0; `npx tsc --noEmit` exit 0; AGENTS.md:14 'Vitest (167 suites, 1332 tests)' and AGENTS.md:33 '1332 tests, 167 suites' match live counts.
Criteria 2-5 are green with real command output, but criterion 1 fails: the UI still dispatches queries against the hardcoded 'default' namespace on boot because AppShell renders the routes before the server-reported currentNamespace is adopted.

## Summary

Judge Result: DF-0924-05

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v5.0.1 /home/kara/duckbrain

Stage tier2: FAIL
  INCOMPLETE
  ✗ On an --auth=apikey scratch daemon: (1) UI boots with the server-reported currentNamespace (no queries against hardcoded 'default'); (2) all API calls attach X-API-Key from a user-entered token persisted in localStorage, with a visible token entry point; (3) 401/404 failures do not retry more than once (no 429 storm); (4) packages/ui pnpm build + pnpm test green including new regression tests; (5) root npx vitest run + npx tsc --noEmit remain green and AGENTS.md counts match live if root suite counts change: Sub-requirement (1) FAILS. App.tsx:29-42 AppShell calls useNamespaceBoot() but renders <Routes> unconditionally, so TimelinePage/TreePage mount on the first render and fire queries with the store's initial currentNamespace ('default', ui-store.ts:74) before GET /api/namespaces resolves. Empirical probe mounting the real AppShell wiring (useNamespaceBoot + ApiAuthBanner + a page calling useVitals(useCurrentNamespace())) recorded: ['/api/memories?namespace=default&limit=1','/api/memories?namespace=default&limit=100','/api/keys?namespace=default','/api/namespaces','/api/memories?namespace=work&limit=1',...] — i.e. 3 queries against hardcoded 'default' are dispatched before the server value arrives. With a persisted stale namespace the same probe fired 3 queries against 'stale-persisted' first. useNamespaceBoot (use-namespaces.ts:50-66) only adopts data.currentNamespace in a useEffect after the fetch resolves; it does not gate the first render. Sub-requirements (2),(3),(4),(5) PASS: (2) api-client.ts getApiToken/setApiToken/clearApiToken persist to localStorage key 'duckbrain-api-token', apiFetch attaches X-API-Key on every request when set, ApiTokenControl is rendered in header.tsx:112 and ApiAuthBanner provides a second visible entry point; api-auth.test.ts passes. (3) probe on a 401 boot recorded exactly 4 requests (one per query, zero retries); shouldRetryQuery returns false for ApiAuthError, useNamespaceBoot sets retry:false, and both QueryClients (App.tsx:17, main.tsx:15) use shouldRetryQuery. (4) `cd packages/ui && pnpm test` -> 'Test Files 9 passed (9) / Tests 54 passed (54)' exit 0; `pnpm build` -> 'tsc && vite build ... built in 1.72s' exit 0. (5) root `npx vitest run` -> 'Test Files 167 passed (167) / Tests 1332 passed (1332)' exit 0; `npx tsc --noEmit` exit 0; AGENTS.md:14 'Vitest (167 suites, 1332 tests)' and AGENTS.md:33 '1332 tests, 167 suites' match live counts.
Criteria 2-5 are green with real command output, but criterion 1 fails: the UI still dispatches queries against the hardcoded 'default' namespace on boot because AppShell renders the routes before the server-reported currentNamespace is adopted.

Overall: FAIL ✗
