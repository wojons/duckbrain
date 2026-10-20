# Verdict: MCP-CUSTOM-RUNTIME-002

**Task:** Define and enforce trust boundary for custom MCP code
**Evaluated:** 2026-10-20T01:33:24.836512
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✗ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✓ src/mcp/custom-runtime.ts: constructor-escape probe in custom-runtime.test.ts must assert (not just compute); add a test that demonstrates the escape is blocked OR document the boundary explicitly; node:vm is not a security mechanism per Node docs — either add OS-level isolation (worker+seccomp) or document the trust model. PASS: test asserts the probe outcome; boundary is explicit in code or docs.: Test asserts the probe outcome: src/mcp/custom-runtime.test.ts:603-706 ('sandbox escape attempts cannot reach host state') asserts the escape surface is reachable (thisCtorType/argsCtorType === 'function', so the probe cannot pass vacuously), asserts argsIsRealmObject === 'true', and asserts 10 escape arms (thisCtorEscape, globalCtorEscape, argsCtorEscape, objectCtorEscape, arrayCtorEscape, stringCtorEscape, consoleCtorEscape, functionCtorEscape, evalEscape, requireViaCtorEscape) each toMatch(/^blocked:/), toContain('Code generation from strings disallowed'), and not.toContain('NOT-BLOCKED'); headline arms pinned with exact toBe at lines 695-703. Boundary documented explicitly in code: src/mcp/custom-runtime.ts:34-99 'TRUST BOUNDARY' block lists WHAT IS PROTECTED and WHAT IS NOT PROTECTED, stating 'THERE IS NO OS-LEVEL ISOLATION ... Node documents node:vm as NOT a security mechanism (https://nodejs.org/api/vm.html) ... no seccomp filter, no container, no chroot and no separate uid', that the threat model is operator-authored config code, and that real isolation must run out of process. Enforcement matches the doc: custom-runtime.ts:513-514 uses Object.create(null) sandbox with codeGeneration {strings:false, wasm:true} and the prelude parses args inside the realm (line 522). Test run: `npx vitest run src/mcp/custom-runtime.test.ts` → exit_code 0, 'Test Files 1 passed (1) / Tests 26 passed (26)'. Landed in commit a12164fd (/home/kara/duckbrain). [resolution 0.64; src/mcp/custom-runtime.ts, custom-runtime.test.ts]
The constructor-escape probe is now asserted (10 arms must return 'blocked: Code generation from strings disallowed'), the trust boundary including the absence of OS-level isolation is documented explicitly in custom-runtime.ts, and the 26-test file passes.

## Summary

Judge Result: MCP-CUSTOM-RUNTIME-002

Stage tier1: FAIL
    ✗ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✓ src/mcp/custom-runtime.ts: constructor-escape probe in custom-runtime.test.ts must assert (not just compute); add a test that demonstrates the escape is blocked OR document the boundary explicitly; node:vm is not a security mechanism per Node docs — either add OS-level isolation (worker+seccomp) or document the trust model. PASS: test asserts the probe outcome; boundary is explicit in code or docs.: Test asserts the probe outcome: src/mcp/custom-runtime.test.ts:603-706 ('sandbox escape attempts cannot reach host state') asserts the escape surface is reachable (thisCtorType/argsCtorType === 'function', so the probe cannot pass vacuously), asserts argsIsRealmObject === 'true', and asserts 10 escape arms (thisCtorEscape, globalCtorEscape, argsCtorEscape, objectCtorEscape, arrayCtorEscape, stringCtorEscape, consoleCtorEscape, functionCtorEscape, evalEscape, requireViaCtorEscape) each toMatch(/^blocked:/), toContain('Code generation from strings disallowed'), and not.toContain('NOT-BLOCKED'); headline arms pinned with exact toBe at lines 695-703. Boundary documented explicitly in code: src/mcp/custom-runtime.ts:34-99 'TRUST BOUNDARY' block lists WHAT IS PROTECTED and WHAT IS NOT PROTECTED, stating 'THERE IS NO OS-LEVEL ISOLATION ... Node documents node:vm as NOT a security mechanism (https://nodejs.org/api/vm.html) ... no seccomp filter, no container, no chroot and no separate uid', that the threat model is operator-authored config code, and that real isolation must run out of process. Enforcement matches the doc: custom-runtime.ts:513-514 uses Object.create(null) sandbox with codeGeneration {strings:false, wasm:true} and the prelude parses args inside the realm (line 522). Test run: `npx vitest run src/mcp/custom-runtime.test.ts` → exit_code 0, 'Test Files 1 passed (1) / Tests 26 passed (26)'. Landed in commit a12164fd (/home/kara/duckbrain). [resolution 0.64; src/mcp/custom-runtime.ts, custom-runtime.test.ts]
The constructor-escape probe is now asserted (10 arms must return 'blocked: Code generation from strings disallowed'), the trust boundary including the absence of OS-level isolation is documented explicitly in custom-runtime.ts, and the 26-test file passes.

Overall: FAIL ✗
