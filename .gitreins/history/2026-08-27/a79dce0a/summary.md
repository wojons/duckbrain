# Verdict: DOGFOOD-029

**Task:** search --all-namespaces: warn+skip unindexed namespaces
**Evaluated:** 2026-08-27T06:06:18.174719
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: [90m1:04AM[0m [32mINF[0m [1mscanned ~12516303 bytes (12.52 MB) in 6.02s[0m
[90m1:04AM[0m [3
  ✓ tests: 
[1m[30m[46m RUN [49m[39m[22m [36mv4.1.10 [39m[90m/home/kara/duckbrain[39m

 [32m✓[39m s
- ✓ **tier2**
  - COMPLETE
  ✓ In the --all-namespaces loop of the search CLI, a namespace without a keyword search index must emit a stderr warning and be skipped (continue with indexed namespaces); single-namespace mode may keep the hard error. PASS: --all-namespaces returns results from indexed namespaces and warns (stderr) about unindexed ones; suite green.: src/search/query.ts keywordSearchAllNamespaces loop catches SearchIndexMissingError -> skipped.push(ns); continue (line ~390), so indexed namespaces still contribute; when searched.length===0 it returns an empty union with every namespace in namespacesSkipped instead of throwing (lines ~399-406). src/cli/human.ts lines 563-567 emit the stderr warning via console.error('Note: skipped N namespace(s) with no search index: ...'). Single-namespace keywordSearch (query.ts line 289) calls collectKeywordCandidates directly (line 300) which throws SearchIndexMissingError (line 200) uncaught, preserving the hard error. Tests: npx vitest run -> 98 files / 837 tests passed (exit 0); new tests in search-all-namespaces-retr007.test.ts (all-unindexed exits 0 + stderr skip note) and search-retr007.test.ts (empty union all skipped) both pass.
The --all-namespaces search loop now skips unindexed namespaces with a stderr warning and returns results from indexed namespaces, single-namespace mode keeps its hard error, and the full suite is green (837 tests).

## Summary

Judge Result: DOGFOOD-029

Stage tier1: PASS
    ✓ secrets: [90m1:04AM[0m [32mINF[0m [1mscanned ~12516303 bytes (12.52 MB) in 6.02s[0m
[90m1:04AM[0m [3
  ✓ tests: 
[1m[30m[46m RUN [49m[39m[22m [36mv4.1.10 [39m[90m/home/kara/duckbrain[39m

 [32m✓[39m s

Stage tier2: PASS
  COMPLETE
  ✓ In the --all-namespaces loop of the search CLI, a namespace without a keyword search index must emit a stderr warning and be skipped (continue with indexed namespaces); single-namespace mode may keep the hard error. PASS: --all-namespaces returns results from indexed namespaces and warns (stderr) about unindexed ones; suite green.: src/search/query.ts keywordSearchAllNamespaces loop catches SearchIndexMissingError -> skipped.push(ns); continue (line ~390), so indexed namespaces still contribute; when searched.length===0 it returns an empty union with every namespace in namespacesSkipped instead of throwing (lines ~399-406). src/cli/human.ts lines 563-567 emit the stderr warning via console.error('Note: skipped N namespace(s) with no search index: ...'). Single-namespace keywordSearch (query.ts line 289) calls collectKeywordCandidates directly (line 300) which throws SearchIndexMissingError (line 200) uncaught, preserving the hard error. Tests: npx vitest run -> 98 files / 837 tests passed (exit 0); new tests in search-all-namespaces-retr007.test.ts (all-unindexed exits 0 + stderr skip note) and search-retr007.test.ts (empty union all skipped) both pass.
The --all-namespaces search loop now skips unindexed namespaces with a stderr warning and returns results from indexed namespaces, single-namespace mode keeps its hard error, and the full suite is green (837 tests).

Overall: PASS ✓
