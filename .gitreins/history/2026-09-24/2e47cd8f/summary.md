# Verdict: DF-0924-05

**Task:** P0 UI dead on hardened auth deployments: hardcoded namespace, zero credentials, 429 storm
**Evaluated:** 2026-09-24T22:04:45.440626
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v5.0.1 /home/kara/duckbrain
- ✓ **tier2**
  - COMPLETE
  ✓ On an --auth=apikey scratch daemon: (1) UI boots with the server-reported currentNamespace (no queries against hardcoded 'default'); (2) all API calls attach X-API-Key from a user-entered token persisted in localStorage, with a visible token entry point; (3) 401/404 failures do not retry more than once (no 429 storm); (4) packages/ui pnpm build + pnpm test green including new regression tests; (5) root npx vitest run + npx tsc --noEmit remain green and AGENTS.md counts match live if root suite counts change: (1) packages/ui/src/hooks/use-namespaces.ts:66-113 useNamespaceBootStatus fetches GET /api/namespaces and adopts data.currentNamespace into the store in the same effect that flips status to 'ready'; App.tsx:38-54 gates <Routes> on bootStatus so pages never mount pre-adoption. Only remaining "default" is the documented fallback at stores/ui-store.ts:74. Regression tests use-namespaces.test.tsx:130-169 assert every /api/memories and /api/keys request carries namespace=work (not 'default'/'stale-persisted'). (2) api-client.ts:32-52 getApiToken/setApiToken/clearApiToken persist under localStorage key 'duckbrain-api-token'; apiFetch (api-client.ts:110-121) attaches X-API-Key on every request when a token is set; visible entry point ApiTokenControl rendered at components/layout/header.tsx:113 plus ApiAuthBanner. (3) api-client.ts:87-93 shouldRetryQuery returns false for ApiAuthError and failureCount<1 otherwise (max 1 retry); wired as QueryClient retry in App.tsx:17 and main.tsx:15; api-token-banner.test.tsx:117 asserts calls===2 (one boot + one refetch, no storm). (4) `pnpm test` in packages/ui: 'Test Files 9 passed (9) / Tests 57 passed (57)'; `pnpm build` (tsc && vite build): 'built in 2.92s' EXIT=0; the 3 new regression files run green (19 tests). (5) root `npx vitest run`: 'Test Files 169 passed (169) / Tests 1359 passed (1359)'; `npx tsc --noEmit` TSC_EXIT=0; `scripts/sync-agents-md-counts.sh --check` prints 'AGENTS.md test counts match live suite (169 suites, 1359 tests)' EXIT=0, matching AGENTS.md:14 and :33. [resolution 0.16; AGENTS.md]
All five sub-criteria verified: boot namespace adoption with route gating, X-API-Key token entry persisted in localStorage, single-retry/no-auth-retry predicate, and green UI build/test plus green root vitest/tsc with AGENTS.md counts matching live.

## Summary

Judge Result: DF-0924-05

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v5.0.1 /home/kara/duckbrain

Stage tier2: PASS
  COMPLETE
  ✓ On an --auth=apikey scratch daemon: (1) UI boots with the server-reported currentNamespace (no queries against hardcoded 'default'); (2) all API calls attach X-API-Key from a user-entered token persisted in localStorage, with a visible token entry point; (3) 401/404 failures do not retry more than once (no 429 storm); (4) packages/ui pnpm build + pnpm test green including new regression tests; (5) root npx vitest run + npx tsc --noEmit remain green and AGENTS.md counts match live if root suite counts change: (1) packages/ui/src/hooks/use-namespaces.ts:66-113 useNamespaceBootStatus fetches GET /api/namespaces and adopts data.currentNamespace into the store in the same effect that flips status to 'ready'; App.tsx:38-54 gates <Routes> on bootStatus so pages never mount pre-adoption. Only remaining "default" is the documented fallback at stores/ui-store.ts:74. Regression tests use-namespaces.test.tsx:130-169 assert every /api/memories and /api/keys request carries namespace=work (not 'default'/'stale-persisted'). (2) api-client.ts:32-52 getApiToken/setApiToken/clearApiToken persist under localStorage key 'duckbrain-api-token'; apiFetch (api-client.ts:110-121) attaches X-API-Key on every request when a token is set; visible entry point ApiTokenControl rendered at components/layout/header.tsx:113 plus ApiAuthBanner. (3) api-client.ts:87-93 shouldRetryQuery returns false for ApiAuthError and failureCount<1 otherwise (max 1 retry); wired as QueryClient retry in App.tsx:17 and main.tsx:15; api-token-banner.test.tsx:117 asserts calls===2 (one boot + one refetch, no storm). (4) `pnpm test` in packages/ui: 'Test Files 9 passed (9) / Tests 57 passed (57)'; `pnpm build` (tsc && vite build): 'built in 2.92s' EXIT=0; the 3 new regression files run green (19 tests). (5) root `npx vitest run`: 'Test Files 169 passed (169) / Tests 1359 passed (1359)'; `npx tsc --noEmit` TSC_EXIT=0; `scripts/sync-agents-md-counts.sh --check` prints 'AGENTS.md test counts match live suite (169 suites, 1359 tests)' EXIT=0, matching AGENTS.md:14 and :33. [resolution 0.16; AGENTS.md]
All five sub-criteria verified: boot namespace adoption with route gating, X-API-Key token entry persisted in localStorage, single-retry/no-auth-retry predicate, and green UI build/test plus green root vitest/tsc with AGENTS.md counts matching live.

Overall: PASS ✓
