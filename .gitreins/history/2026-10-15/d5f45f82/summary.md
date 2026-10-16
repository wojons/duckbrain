# Verdict: DF-1013-04

**Task:** Cross-process single-flight sidecar rebuild + corrupt-sidecar-safe allNamespaces union
**Evaluated:** 2026-10-15T13:27:54.757088
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✓ concurrent rebuilds cannot produce empty sidecars; one corrupt sidecar does not kill the union; tests green: Cross-process single-flight: src/search/index.ts:68 defines REBUILD_LOCK_NAME='.search.rebuild.lock' in the NAMESPACE ROOT (outside the wiped .search/ dir); tryAcquireRebuildLock (index.ts:104-141) uses fs.openSync(lockPath,'wx') (O_CREAT|O_EXCL) and reaps only stale locks whose recorded pid is dead (10-min age); rebuildNamespaceIndex (index.ts:376-416) polls REBUILD_LOCK_POLL_MS and REUSES readIndexMeta() of the winner's result instead of rebuilding, so a loser cannot rm -rf a finished sidecar. Corrupt-sidecar-safe union: src/search/query.ts:518-580 keywordSearchAllNamespaces catches every non-SearchIndexMissingError per namespace, pushes {namespace,error} into namespaceErrors and continues the union (SearchIndexMissingError still routes to namespacesSkipped); facets surface via src/cli/human.ts:638, src/mcp/tools/recall.ts:811, src/mcp/tools/search.ts:136. Tests green (actual output): `npx vitest run src/search/concurrent-rebuild-df101304.test.ts` => 'Test Files 1 passed (1) / Tests 6 passed (6)', exit 0; `npx vitest run src/search/` => 'Test Files 9 passed (9) / Tests 93 passed (93)', exit 0; `npx tsc --noEmit` exit 0. RED-proof reproduced: replacing the lock wrapper with a direct call to rebuildNamespaceIndexLocked yields 'Tests 3 failed | 3 passed (6)' (AC1 fails with ENOENT rename of fts.duckdb.tmp / missing rows.tmp.jsonl), and restoring returns 6/6 pass — the lock is load-bearing. AC2 tests assert the healthy namespace's hits are returned while the corrupt namespace (0-byte DB and valid-but-tableless DB) is reported as a namespaceErrors facet, never a throw.
Cross-process single-flight lock plus corrupt-sidecar union facets are implemented and covered by 6 new tests that pass (93/93 in src/search, tsc clean), with a reproduced RED-proof showing the lock is required.

## Summary

Judge Result: DF-1013-04

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✓ concurrent rebuilds cannot produce empty sidecars; one corrupt sidecar does not kill the union; tests green: Cross-process single-flight: src/search/index.ts:68 defines REBUILD_LOCK_NAME='.search.rebuild.lock' in the NAMESPACE ROOT (outside the wiped .search/ dir); tryAcquireRebuildLock (index.ts:104-141) uses fs.openSync(lockPath,'wx') (O_CREAT|O_EXCL) and reaps only stale locks whose recorded pid is dead (10-min age); rebuildNamespaceIndex (index.ts:376-416) polls REBUILD_LOCK_POLL_MS and REUSES readIndexMeta() of the winner's result instead of rebuilding, so a loser cannot rm -rf a finished sidecar. Corrupt-sidecar-safe union: src/search/query.ts:518-580 keywordSearchAllNamespaces catches every non-SearchIndexMissingError per namespace, pushes {namespace,error} into namespaceErrors and continues the union (SearchIndexMissingError still routes to namespacesSkipped); facets surface via src/cli/human.ts:638, src/mcp/tools/recall.ts:811, src/mcp/tools/search.ts:136. Tests green (actual output): `npx vitest run src/search/concurrent-rebuild-df101304.test.ts` => 'Test Files 1 passed (1) / Tests 6 passed (6)', exit 0; `npx vitest run src/search/` => 'Test Files 9 passed (9) / Tests 93 passed (93)', exit 0; `npx tsc --noEmit` exit 0. RED-proof reproduced: replacing the lock wrapper with a direct call to rebuildNamespaceIndexLocked yields 'Tests 3 failed | 3 passed (6)' (AC1 fails with ENOENT rename of fts.duckdb.tmp / missing rows.tmp.jsonl), and restoring returns 6/6 pass — the lock is load-bearing. AC2 tests assert the healthy namespace's hits are returned while the corrupt namespace (0-byte DB and valid-but-tableless DB) is reported as a namespaceErrors facet, never a throw.
Cross-process single-flight lock plus corrupt-sidecar union facets are implemented and covered by 6 new tests that pass (93/93 in src/search, tsc clean), with a reproduced RED-proof showing the lock is required.

Overall: PASS ✓
