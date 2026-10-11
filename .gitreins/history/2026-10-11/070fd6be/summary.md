# Verdict: MCP-CONNECTION-PROFILES-001

**Task:** Multi-profile MCP connection state (visibility, not authorization)
**Evaluated:** 2026-10-11T09:23:19.124346
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✓ A connection can select multiple profiles composing tool visibility deterministically; profiles never change authorization; tests cover multi-profile, concurrent selections, and denied hidden-tool calls: Code: src/mcp/profiles.ts composeVisibility() (~L322-370) folds a multi-profile selection into an order-independent SET UNION of directives (Set-based; hidden beats exclusive); filterToolsList() (~L378) filters tools/list only. src/mcp/server.ts:357-381 installProfilesListInterception() wraps ONLY the 'tools/list' handler (comment L353 'HARD BOUNDARY: this touches tools/list ONLY'); grep for profiles/Profile in src/auth/ and the tools/call path returns nothing, so profiles never affect authorization. src/mcp/tools/profiles.ts exposes list/create/update/select_profiles; src/cli/http.ts:832-857 binds the request-scoped X-DuckBrain-Profiles header and clears it in finally. Tests (fresh runs): `npx vitest run src/mcp/profiles.test.ts src/mcp/tools/profiles.test.ts` -> 'Test Files 2 passed (2) / Tests 28 passed (28)' exit 0, incl. 'multi-profile overlap: union of directives; order-independent' (profiles.test.ts:186), 'multi-profile exclusive: any exclusive directive narrows, hidden still wins' (:217), 'composition output has NO authorization representation' (:311). `npx vitest run --config vitest.integration.config.ts tests/mcp-connection-profiles.int.test.ts` -> 'Test Files 1 passed (1) / Tests 6 passed (6)' exit 0, incl. 'two concurrent connections carry DIFFERENT selections without cross-talk' (Promise.all of 3 header-scoped tools/list, :222) and 'denied call DESPITE the profile advertising the tool: profiles cannot broaden authority' (:250, unauth 401 despite profile; hidden-but-authorized call still executes :236). `npx vitest run src/mcp/` -> 'Test Files 21 passed (21) / Tests 197 passed (197)' exit 0. All three required dimensions (multi-profile, concurrent selections, denied hidden-tool calls) are covered and green.
Multi-profile visibility composition is deterministic and order-independent, tools/call never consults profiles, and unit + live-HTTP integration tests covering multi-profile, concurrent selections, and denied hidden-tool calls all pass.

## Summary

Judge Result: MCP-CONNECTION-PROFILES-001

Stage tier1: FAIL
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✓ A connection can select multiple profiles composing tool visibility deterministically; profiles never change authorization; tests cover multi-profile, concurrent selections, and denied hidden-tool calls: Code: src/mcp/profiles.ts composeVisibility() (~L322-370) folds a multi-profile selection into an order-independent SET UNION of directives (Set-based; hidden beats exclusive); filterToolsList() (~L378) filters tools/list only. src/mcp/server.ts:357-381 installProfilesListInterception() wraps ONLY the 'tools/list' handler (comment L353 'HARD BOUNDARY: this touches tools/list ONLY'); grep for profiles/Profile in src/auth/ and the tools/call path returns nothing, so profiles never affect authorization. src/mcp/tools/profiles.ts exposes list/create/update/select_profiles; src/cli/http.ts:832-857 binds the request-scoped X-DuckBrain-Profiles header and clears it in finally. Tests (fresh runs): `npx vitest run src/mcp/profiles.test.ts src/mcp/tools/profiles.test.ts` -> 'Test Files 2 passed (2) / Tests 28 passed (28)' exit 0, incl. 'multi-profile overlap: union of directives; order-independent' (profiles.test.ts:186), 'multi-profile exclusive: any exclusive directive narrows, hidden still wins' (:217), 'composition output has NO authorization representation' (:311). `npx vitest run --config vitest.integration.config.ts tests/mcp-connection-profiles.int.test.ts` -> 'Test Files 1 passed (1) / Tests 6 passed (6)' exit 0, incl. 'two concurrent connections carry DIFFERENT selections without cross-talk' (Promise.all of 3 header-scoped tools/list, :222) and 'denied call DESPITE the profile advertising the tool: profiles cannot broaden authority' (:250, unauth 401 despite profile; hidden-but-authorized call still executes :236). `npx vitest run src/mcp/` -> 'Test Files 21 passed (21) / Tests 197 passed (197)' exit 0. All three required dimensions (multi-profile, concurrent selections, denied hidden-tool calls) are covered and green.
Multi-profile visibility composition is deterministic and order-independent, tools/call never consults profiles, and unit + live-HTTP integration tests covering multi-profile, concurrent selections, and denied hidden-tool calls all pass.

Overall: FAIL ✗
