# Verdict: README-9-R4

**Task:** Repair malformed README HTTP API curl examples
**Evaluated:** 2026-10-27T22:50:31.566565
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✗ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✓ Repair README.md:450,453,456,459,462 so each curl command passes bash parsing and gives curl separate -H and URL arguments; run the isolated auth=apikey five-command probe and record intended endpoint requests.: All three parts verified. (1) REPAIR IS LIVE ON MAINLINE: HEAD=10b709ab, `git rev-parse HEAD:README.md`=7262ffd5 == `git hash-object README.md`=7262ffd5, and `git merge-base --is-ancestor 05c73402 HEAD` returns YES. Commit 05c73402 added double quotes around each URL (5 insertions/5 deletions). The earlier FAIL verdict 78c4bf23 was correct at the time (fix was then only on unmerged branch wt/README-9-R4) but is now stale — merge commit 10b709ab landed the fix. (2) BASH PARSING + SEPARATE ARGS: `awk 'NR>=445&&NR<=465'` confirms the criterion's exact line numbers 450/453/456/459/462. Stubbed-curl probe: each line gives `bash -n` rc=0 and ARGC=3 with argv[0]=<-H>, argv[1]=<X-API-Key: <key>>, argv[2]=<full URL incl. query string>. Negative control proves the fix is meaningful: pre-fix unquoted L453 yields ARGC=3 but argv[2] truncated to `...?namespace=default` (loses `&limit=10`); post-fix quoted yields the full URL. (3) ISOLATED auth=apikey FIVE-COMMAND PROBE RUN: I started `node bin/duckbrain.js http --port=3199 --auth=apikey --auth-file=<scratch> --rate-limit=600` (health=200), seeded /probe/seed, and ran all five README commands verbatim (<key>->real key, port 3000->3199). All RC=0, no 'Unauthorized', endpoints resolved: L450 /api/keys?namespace=default -> {"tree":[...],"total":1}; L453 /api/memories?namespace=default&limit=10 -> {"items":[...],"total":1} (proves &limit=10 reached the server, not backgrounded); L456 /api/memories?namespace=default&q=connection+pooling -> {"items":[...],"score":1} (proves &q=... reached the server); L459 /api/memories/key/benchmarks/models/deepseek-v4-pro?namespace=default -> 404 NOT_FOUND (route resolved, memory absent); L462 /api/memories/fda1ce7a-...?namespace=default -> 404 NOT_FOUND (route resolved). Supporting validation: `node scripts/docs-check.js` -> 'docs-check: OK — README.md + 48 docs/*.md files: fences balanced, local links resolve' rc=0; `--self-test` -> 'RED arm flagged 4 defect classes, GREEN arm passed'. Note: the full `npx vitest run` suite exceeded the 30s tool cap and could not complete; docs-check is the relevant validator for this README-only change and passes. [resolution 0.02; README.md:450]
The README curl repair is committed on mainline (HEAD 10b709ab), all five lines pass bash parsing and pass curl a separate -H and full URL, and an isolated --auth=apikey five-command probe I ran myself confirms every documented endpoint resolves with query strings intact.

## Summary

Judge Result: README-9-R4

Stage tier1: FAIL
    ✗ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✓ Repair README.md:450,453,456,459,462 so each curl command passes bash parsing and gives curl separate -H and URL arguments; run the isolated auth=apikey five-command probe and record intended endpoint requests.: All three parts verified. (1) REPAIR IS LIVE ON MAINLINE: HEAD=10b709ab, `git rev-parse HEAD:README.md`=7262ffd5 == `git hash-object README.md`=7262ffd5, and `git merge-base --is-ancestor 05c73402 HEAD` returns YES. Commit 05c73402 added double quotes around each URL (5 insertions/5 deletions). The earlier FAIL verdict 78c4bf23 was correct at the time (fix was then only on unmerged branch wt/README-9-R4) but is now stale — merge commit 10b709ab landed the fix. (2) BASH PARSING + SEPARATE ARGS: `awk 'NR>=445&&NR<=465'` confirms the criterion's exact line numbers 450/453/456/459/462. Stubbed-curl probe: each line gives `bash -n` rc=0 and ARGC=3 with argv[0]=<-H>, argv[1]=<X-API-Key: <key>>, argv[2]=<full URL incl. query string>. Negative control proves the fix is meaningful: pre-fix unquoted L453 yields ARGC=3 but argv[2] truncated to `...?namespace=default` (loses `&limit=10`); post-fix quoted yields the full URL. (3) ISOLATED auth=apikey FIVE-COMMAND PROBE RUN: I started `node bin/duckbrain.js http --port=3199 --auth=apikey --auth-file=<scratch> --rate-limit=600` (health=200), seeded /probe/seed, and ran all five README commands verbatim (<key>->real key, port 3000->3199). All RC=0, no 'Unauthorized', endpoints resolved: L450 /api/keys?namespace=default -> {"tree":[...],"total":1}; L453 /api/memories?namespace=default&limit=10 -> {"items":[...],"total":1} (proves &limit=10 reached the server, not backgrounded); L456 /api/memories?namespace=default&q=connection+pooling -> {"items":[...],"score":1} (proves &q=... reached the server); L459 /api/memories/key/benchmarks/models/deepseek-v4-pro?namespace=default -> 404 NOT_FOUND (route resolved, memory absent); L462 /api/memories/fda1ce7a-...?namespace=default -> 404 NOT_FOUND (route resolved). Supporting validation: `node scripts/docs-check.js` -> 'docs-check: OK — README.md + 48 docs/*.md files: fences balanced, local links resolve' rc=0; `--self-test` -> 'RED arm flagged 4 defect classes, GREEN arm passed'. Note: the full `npx vitest run` suite exceeded the 30s tool cap and could not complete; docs-check is the relevant validator for this README-only change and passes. [resolution 0.02; README.md:450]
The README curl repair is committed on mainline (HEAD 10b709ab), all five lines pass bash parsing and pass curl a separate -H and full URL, and an isolated --auth=apikey five-command probe I ran myself confirms every documented endpoint resolves with query strings intact.

Overall: FAIL ✗
