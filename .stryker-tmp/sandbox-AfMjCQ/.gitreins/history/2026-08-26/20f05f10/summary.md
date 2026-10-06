# Verdict: DOGFOOD-025

**Task:** MCP remember must stamp authenticated token author
**Evaluated:** 2026-08-26T22:29:53.328414
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: [90m5:28PM[0m [32mINF[0m [1mscanned ~11870530 bytes (11.87 MB) in 6.82s[0m
[90m5:28PM[0m [3
  ✓ tests: 
[1m[30m[46m RUN [49m[39m[22m [36mv4.1.10 [39m[90m/home/kara/duckbrain[39m

 [32m✓[39m s
- ✓ **tier2**
  - COMPLETE
  ✓ Authenticated MCP-over-HTTP remember (POST /mcp with X-API-Key on --auth=apikey daemon) writes author=<token-name>@duckbrain.local, ignoring client-supplied author; stdio remember still stamps git config; suite green: src/mcp/tools/remember.ts:145-148 — `const mcpPrincipal = getMcpRequestPrincipal(); const authorIdentity = mcpPrincipal ? principalAuthorEmail(mcpPrincipal) : (author ?? getAuthorEmail());` stamps principal author when authenticated and ignores client author. src/auth/middleware.ts:79-90 principalAuthorEmail maps token name to <name>@duckbrain.local. src/cli/http.ts:549 sets mcpRequestPrincipal=getPrincipal(req) inside /mcp mutex (cleared in finally at 561); getMcpRequestPrincipal exported at 622. src/cli/stdio.ts uses StdioServerTransport and never calls createHttpServer, so the slot stays undefined and the git-config fallback (author ?? getAuthorEmail()) is preserved. Tests: `npx vitest run src/cli/http-mcp-auth-dogfood025.test.ts` → 4 passed (AC1 stamps <token>@duckbrain.local on JSONL row, AC2 ignores spoofed author, AC3 stdio honors client author, unauth /mcp returns 401). Full suite: `npx vitest run` → 94 files / 809 tests passed, exit code 0. LSP diagnostics: none.
DOGFOOD-025 is complete: authenticated MCP-over-HTTP remember stamps author=<token-name>@duckbrain.local and ignores client-supplied author, stdio preserves git-config fallback, and the full 809-test suite is green.

## Summary

Judge Result: DOGFOOD-025

Stage tier1: PASS
    ✓ secrets: [90m5:28PM[0m [32mINF[0m [1mscanned ~11870530 bytes (11.87 MB) in 6.82s[0m
[90m5:28PM[0m [3
  ✓ tests: 
[1m[30m[46m RUN [49m[39m[22m [36mv4.1.10 [39m[90m/home/kara/duckbrain[39m

 [32m✓[39m s

Stage tier2: PASS
  COMPLETE
  ✓ Authenticated MCP-over-HTTP remember (POST /mcp with X-API-Key on --auth=apikey daemon) writes author=<token-name>@duckbrain.local, ignoring client-supplied author; stdio remember still stamps git config; suite green: src/mcp/tools/remember.ts:145-148 — `const mcpPrincipal = getMcpRequestPrincipal(); const authorIdentity = mcpPrincipal ? principalAuthorEmail(mcpPrincipal) : (author ?? getAuthorEmail());` stamps principal author when authenticated and ignores client author. src/auth/middleware.ts:79-90 principalAuthorEmail maps token name to <name>@duckbrain.local. src/cli/http.ts:549 sets mcpRequestPrincipal=getPrincipal(req) inside /mcp mutex (cleared in finally at 561); getMcpRequestPrincipal exported at 622. src/cli/stdio.ts uses StdioServerTransport and never calls createHttpServer, so the slot stays undefined and the git-config fallback (author ?? getAuthorEmail()) is preserved. Tests: `npx vitest run src/cli/http-mcp-auth-dogfood025.test.ts` → 4 passed (AC1 stamps <token>@duckbrain.local on JSONL row, AC2 ignores spoofed author, AC3 stdio honors client author, unauth /mcp returns 401). Full suite: `npx vitest run` → 94 files / 809 tests passed, exit code 0. LSP diagnostics: none.
DOGFOOD-025 is complete: authenticated MCP-over-HTTP remember stamps author=<token-name>@duckbrain.local and ignores client-supplied author, stdio preserves git-config fallback, and the full 809-test suite is green.

Overall: PASS ✓
