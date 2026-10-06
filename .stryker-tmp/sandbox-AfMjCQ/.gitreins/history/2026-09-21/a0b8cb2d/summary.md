# Verdict: REG-GONE-001

**Task:** DELETE /api/namespaces leaves no record of a namespace whose directory is gone (registry delete and directory removal are independent)
**Evaluated:** 2026-09-21T08:36:18.119290
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v5.0.1 /home/kara/duckbrain
- ✓ **tier2**
  - COMPLETE
  ✓ GET /api/namespaces flags rows whose namespace directory is missing on disk, distinguished from healthy rows; DELETE of a namespace whose directory is already gone removes the registry row or refuses with a clear error (never silent); a regression test creates a namespace, removes its directory out-of-band, and proves both contract points: GET: src/http/routes/namespaces.ts:29-40 namesWithMissingDirectories() uses fs.existsSync(path.resolve(ns.path)); transformNamespace (lines 47-60) spreads {directoryMissing:true} only for missing rows, healthy rows omit the field. DELETE: route (namespaces.ts:174-230) delegates to real deleteNamespace (src/namespaces/delete.ts:50), which is idempotent — mapping present + dir already gone still succeeds and removes the mapping (delete.ts:120-127); failures surface clear ApiErrors (404 NOT_FOUND / 400 VALIDATION_ERROR / 500), never silent. Regression test src/http/routes/namespaces-reggone-001.test.ts creates a real namespace via registerNamespace, rmSync's the directory out-of-band, and asserts AC-1a (healthy row has no directoryMissing), AC-1b (gone row flagged, healthy unflagged in same response), AC-2 (DELETE confirm:true -> 200, mapping removed, follow-up list drops row), AC-2 guard (DELETE without confirm -> 400, row survives). Ran `npx vitest run src/http/routes/namespaces-reggone-001.test.ts`: 'Test Files 1 passed (1), Tests 4 passed (4)'. LSP diagnostics: 0.
GET flags gone-directory rows with directoryMissing while healthy rows omit it, DELETE idempotently removes the stale registry row with clear errors, and the 4-test regression suite passes.

## Summary

Judge Result: REG-GONE-001

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v5.0.1 /home/kara/duckbrain

Stage tier2: PASS
  COMPLETE
  ✓ GET /api/namespaces flags rows whose namespace directory is missing on disk, distinguished from healthy rows; DELETE of a namespace whose directory is already gone removes the registry row or refuses with a clear error (never silent); a regression test creates a namespace, removes its directory out-of-band, and proves both contract points: GET: src/http/routes/namespaces.ts:29-40 namesWithMissingDirectories() uses fs.existsSync(path.resolve(ns.path)); transformNamespace (lines 47-60) spreads {directoryMissing:true} only for missing rows, healthy rows omit the field. DELETE: route (namespaces.ts:174-230) delegates to real deleteNamespace (src/namespaces/delete.ts:50), which is idempotent — mapping present + dir already gone still succeeds and removes the mapping (delete.ts:120-127); failures surface clear ApiErrors (404 NOT_FOUND / 400 VALIDATION_ERROR / 500), never silent. Regression test src/http/routes/namespaces-reggone-001.test.ts creates a real namespace via registerNamespace, rmSync's the directory out-of-band, and asserts AC-1a (healthy row has no directoryMissing), AC-1b (gone row flagged, healthy unflagged in same response), AC-2 (DELETE confirm:true -> 200, mapping removed, follow-up list drops row), AC-2 guard (DELETE without confirm -> 400, row survives). Ran `npx vitest run src/http/routes/namespaces-reggone-001.test.ts`: 'Test Files 1 passed (1), Tests 4 passed (4)'. LSP diagnostics: 0.
GET flags gone-directory rows with directoryMissing while healthy rows omit it, DELETE idempotently removes the stale registry row with clear errors, and the 4-test regression suite passes.

Overall: PASS ✓
