# Verdict: DB-GAP-057

**Task:** Namespace registry split-brain: HTTP/MCP creates write mappings to a stray config, GET list is stale
**Evaluated:** 2026-09-25T12:34:46.356345
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v5.0.1 /home/kara/duckbrain
- ✓ **tier2**
  - COMPLETE
  ✓ POST /api/namespaces 201 is listed by the immediately following GET; mappings land in the root config and no stray namespaces/duckbrain.config.json is created; GET flags onDiskOnly and directoryMissing drift with counts; full vitest suite green: Fix commit e921c97. (1) POST→GET: src/http/routes/namespaces-dbgap057.test.ts AC-1 spawns a real scratch daemon, POSTs /api/namespaces (expects 201) then immediately GETs and finds 'dbgap057-live' with path join(nsPath,'dbgap057-live') — passed. (2) Root config + no stray: src/mcp/tools/namespace.ts:createNamespaceTool now calls registerNamespace(cfgRoot, ...) and updateConfig(cfgRoot, ...) where cfgRoot=resolveDuckbrainRoot() (was nsRoot); AC-2 test asserts rootConfig.namespaceMappings['dbgap057-live'] is set, defaultNamespace='dbgap057-default', and fs.existsSync(path.join(nsPath, CONFIG_FILENAME))===false — passed. (3) Drift: src/http/routes/namespaces.ts GET unions censusOnDiskNamespaces(resolveNamespacesPath()) (src/http/routes/namespace-census.ts, dirs-only, skips hidden + CONFIG_FILENAME), pushes onDiskOnly rows, keeps directoryMissing rows, and emits drift {onDiskOnly,directoryMissing} only when non-zero; test asserts body.drift toEqual({onDiskOnly:1,directoryMissing:1}) and undefined when clean — passed. (4) Full suite: `npx vitest run` → 'Test Files 171 passed (171) / Tests 1372 passed (1372)', EXIT=0 (log /tmp/vitest-full2.log); DB-GAP-057 file alone: 6 passed. The pre-existing untracked namespaces/duckbrain.config.json is legacy prod damage (git ls-files empty), not produced by the fixed path. [resolution 0.08; namespaces/duckbrain.config.json]
DB-GAP-057 is fully resolved: the create path registers against resolveDuckbrainRoot(), GET unions an on-disk census with drift flags/counts, the regression test pins all three ACs, and the full vitest suite is green (171 files / 1372 tests, exit 0).

## Summary

Judge Result: DB-GAP-057

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v5.0.1 /home/kara/duckbrain

Stage tier2: PASS
  COMPLETE
  ✓ POST /api/namespaces 201 is listed by the immediately following GET; mappings land in the root config and no stray namespaces/duckbrain.config.json is created; GET flags onDiskOnly and directoryMissing drift with counts; full vitest suite green: Fix commit e921c97. (1) POST→GET: src/http/routes/namespaces-dbgap057.test.ts AC-1 spawns a real scratch daemon, POSTs /api/namespaces (expects 201) then immediately GETs and finds 'dbgap057-live' with path join(nsPath,'dbgap057-live') — passed. (2) Root config + no stray: src/mcp/tools/namespace.ts:createNamespaceTool now calls registerNamespace(cfgRoot, ...) and updateConfig(cfgRoot, ...) where cfgRoot=resolveDuckbrainRoot() (was nsRoot); AC-2 test asserts rootConfig.namespaceMappings['dbgap057-live'] is set, defaultNamespace='dbgap057-default', and fs.existsSync(path.join(nsPath, CONFIG_FILENAME))===false — passed. (3) Drift: src/http/routes/namespaces.ts GET unions censusOnDiskNamespaces(resolveNamespacesPath()) (src/http/routes/namespace-census.ts, dirs-only, skips hidden + CONFIG_FILENAME), pushes onDiskOnly rows, keeps directoryMissing rows, and emits drift {onDiskOnly,directoryMissing} only when non-zero; test asserts body.drift toEqual({onDiskOnly:1,directoryMissing:1}) and undefined when clean — passed. (4) Full suite: `npx vitest run` → 'Test Files 171 passed (171) / Tests 1372 passed (1372)', EXIT=0 (log /tmp/vitest-full2.log); DB-GAP-057 file alone: 6 passed. The pre-existing untracked namespaces/duckbrain.config.json is legacy prod damage (git ls-files empty), not produced by the fixed path. [resolution 0.08; namespaces/duckbrain.config.json]
DB-GAP-057 is fully resolved: the create path registers against resolveDuckbrainRoot(), GET unions an on-disk census with drift flags/counts, the regression test pins all three ACs, and the full vitest suite is green (171 files / 1372 tests, exit 0).

Overall: PASS ✓
