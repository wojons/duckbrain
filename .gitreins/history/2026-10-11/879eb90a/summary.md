# Verdict: MCP-CUSTOM-RUNTIME-001

**Task:** Sandboxed custom JS/WASM functions as first-class MCP tools
**Evaluated:** 2026-10-11T09:19:07.760899
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✓ Custom JS and WASM functions appear as individual tools in tools/list and run sandboxed via tools/call with structured errors, capability refusals, timeout/heap bounds, and tests through the real MCP path: Implementation: src/mcp/custom-runtime.ts (845 lines) defines CustomRuntimeManager + executeInSandbox (fresh Worker per call with resourceLimits.maxOldGenerationSizeMb heap ceiling, vm.createContext with capability-free globals at line 432, WASM instantiated with empty import namespace `new WebAssembly.Instance(mod, {})`, worker.terminate() hard timeout at line ~625); src/mcp/tools/custom-tool.ts registerCustomTools() registers ONE registerTool per declaration (no wrapper) and customToolCallResult() sets isError:true on failure; src/mcp/server.ts:230-232 wires getCustomRuntimeManager()->registerCustomToolsOnServer() into the real server, and server.ts:311 shapes the outcome at the tools/call boundary. Config schema at src/config/index.ts:55-67 (CustomToolsBlockSchema, disabled by default). Tests: `npx vitest run src/mcp/custom-runtime.test.ts` exit_code=0, output 'Test Files 1 passed (1) / Tests 24 passed (24)'. The suite drives a real McpServer+Client over InMemoryTransport (custom-runtime.test.ts:110-160) and asserts: individual tools/list entries with declared description/schema and no custom_*_call wrapper (line 279-315); tools/call JS execution (line 316) and WASM add returning 5 (line 376); structured error codes TOOL_UNKNOWN (402), SCHEMA_INVALID with -32602 wire rejection (412), RUNTIME_TRAP (442), wasm host-import trap (460), TIMEOUT for `while(true)` terminated in <5s with server still responsive (488), RESOURCE_EXHAUSTED heap OOM (508), CAPABILITY_DECLARED fail-closed before execution (528), sandbox escape probes for require/process/fetch/module/globalThis all 'undefined' (545), path traversal refusal (578), RESULT_UNSERIALIZABLE (590), reserved-name/collision refusal (615/639), disabled block (668). Broader regression check: `npx vitest run src/mcp/` exit_code=0, 'Test Files 21 passed (21) / Tests 197 passed (197)'; `npx vitest run src/config` exit_code=0, 'Tests 37 passed (37)'. Docs at docs/api/custom-tools.md document the contract and trust boundary.
Sandboxed custom JS/WASM tools are implemented as first-class MCP tools with structured errors, capability refusals, timeout/heap bounds, and 24 passing tests exercising the real tools/list + tools/call path.

## Summary

Judge Result: MCP-CUSTOM-RUNTIME-001

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✓ Custom JS and WASM functions appear as individual tools in tools/list and run sandboxed via tools/call with structured errors, capability refusals, timeout/heap bounds, and tests through the real MCP path: Implementation: src/mcp/custom-runtime.ts (845 lines) defines CustomRuntimeManager + executeInSandbox (fresh Worker per call with resourceLimits.maxOldGenerationSizeMb heap ceiling, vm.createContext with capability-free globals at line 432, WASM instantiated with empty import namespace `new WebAssembly.Instance(mod, {})`, worker.terminate() hard timeout at line ~625); src/mcp/tools/custom-tool.ts registerCustomTools() registers ONE registerTool per declaration (no wrapper) and customToolCallResult() sets isError:true on failure; src/mcp/server.ts:230-232 wires getCustomRuntimeManager()->registerCustomToolsOnServer() into the real server, and server.ts:311 shapes the outcome at the tools/call boundary. Config schema at src/config/index.ts:55-67 (CustomToolsBlockSchema, disabled by default). Tests: `npx vitest run src/mcp/custom-runtime.test.ts` exit_code=0, output 'Test Files 1 passed (1) / Tests 24 passed (24)'. The suite drives a real McpServer+Client over InMemoryTransport (custom-runtime.test.ts:110-160) and asserts: individual tools/list entries with declared description/schema and no custom_*_call wrapper (line 279-315); tools/call JS execution (line 316) and WASM add returning 5 (line 376); structured error codes TOOL_UNKNOWN (402), SCHEMA_INVALID with -32602 wire rejection (412), RUNTIME_TRAP (442), wasm host-import trap (460), TIMEOUT for `while(true)` terminated in <5s with server still responsive (488), RESOURCE_EXHAUSTED heap OOM (508), CAPABILITY_DECLARED fail-closed before execution (528), sandbox escape probes for require/process/fetch/module/globalThis all 'undefined' (545), path traversal refusal (578), RESULT_UNSERIALIZABLE (590), reserved-name/collision refusal (615/639), disabled block (668). Broader regression check: `npx vitest run src/mcp/` exit_code=0, 'Test Files 21 passed (21) / Tests 197 passed (197)'; `npx vitest run src/config` exit_code=0, 'Tests 37 passed (37)'. Docs at docs/api/custom-tools.md document the contract and trust boundary.
Sandboxed custom JS/WASM tools are implemented as first-class MCP tools with structured errors, capability refusals, timeout/heap bounds, and 24 passing tests exercising the real tools/list + tools/call path.

Overall: PASS ✓
