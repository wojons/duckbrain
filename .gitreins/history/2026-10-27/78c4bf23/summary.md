# Verdict: README-9-R4

**Task:** Repair malformed README HTTP API curl examples
**Evaluated:** 2026-10-27T22:45:54.061864
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✗ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✗ **tier2**
  - INCOMPLETE
  ✗ Repair README.md:450,453,456,459,462 so each curl command passes bash parsing and gives curl separate -H and URL arguments; run the isolated auth=apikey five-command probe and record intended endpoint requests.: The repair is NOT present on mainline. HEAD (9a6f6490) README.md blob is 84bfc4d1 — the pre-fix blob, identical to the worktree. The fix commit 05c73402 ('docs: repair README HTTP API curl examples. Addresses README-9-R4.') exists but `git merge-base --is-ancestor 05c73402 HEAD` returns NO; it lives only on the unmerged branch wt/README-9-R4. Current mainline lines are still unquoted: L453 `curl -H "X-API-Key: <key>" http://localhost:3000/api/memories?namespace=default&limit=10`, L456 `...?namespace=default&q=connection+pooling`, L459/L462 likewise unquoted. Stubbed-curl argv probe on mainline: L450 OK (ARGC=3), L453 produced NO curl invocation at all (backgrounded at `&`), L456 argv[3] truncated to `http://localhost:3000/api/memories?namespace=default` (lost `&q=connection+pooling`), L459 double-fired (one truncated + one full), L462 OK. Negative control against the live daemon confirmed the bug: `bash -c 'curl -H "X-API-Key: <key>" http://localhost:3000/api/memories?namespace=default&limit=10'` returned {"error":"Unauthorized: Invalid API key"} for the truncated URL, proving `&limit=10` was backgrounded. The required 'isolated auth=apikey five-command probe' was never run or recorded — the fix commit message itself admits 'Live isolated --auth=apikey daemon probe not feasible in this worktree (no dist/, no node_modules/, installs forbidden)', and no probe artifact exists in the repo for README-9-R4. The only delivered change is .gitreins/tasks.yaml marking status: complete (lines 2875-2883). scripts/docs-check.js passes ('docs-check: OK') but only validates fence balance and links, not curl argv correctness.
Task marked complete but the README curl repair exists only on unmerged branch wt/README-9-R4 — mainline README.md:450-462 is still malformed (L453/L456 truncate the URL at `&`), and the required isolated auth=apikey five-command probe was never run or recorded.

## Summary

Judge Result: README-9-R4

Stage tier1: FAIL
    ✗ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: FAIL
  INCOMPLETE
  ✗ Repair README.md:450,453,456,459,462 so each curl command passes bash parsing and gives curl separate -H and URL arguments; run the isolated auth=apikey five-command probe and record intended endpoint requests.: The repair is NOT present on mainline. HEAD (9a6f6490) README.md blob is 84bfc4d1 — the pre-fix blob, identical to the worktree. The fix commit 05c73402 ('docs: repair README HTTP API curl examples. Addresses README-9-R4.') exists but `git merge-base --is-ancestor 05c73402 HEAD` returns NO; it lives only on the unmerged branch wt/README-9-R4. Current mainline lines are still unquoted: L453 `curl -H "X-API-Key: <key>" http://localhost:3000/api/memories?namespace=default&limit=10`, L456 `...?namespace=default&q=connection+pooling`, L459/L462 likewise unquoted. Stubbed-curl argv probe on mainline: L450 OK (ARGC=3), L453 produced NO curl invocation at all (backgrounded at `&`), L456 argv[3] truncated to `http://localhost:3000/api/memories?namespace=default` (lost `&q=connection+pooling`), L459 double-fired (one truncated + one full), L462 OK. Negative control against the live daemon confirmed the bug: `bash -c 'curl -H "X-API-Key: <key>" http://localhost:3000/api/memories?namespace=default&limit=10'` returned {"error":"Unauthorized: Invalid API key"} for the truncated URL, proving `&limit=10` was backgrounded. The required 'isolated auth=apikey five-command probe' was never run or recorded — the fix commit message itself admits 'Live isolated --auth=apikey daemon probe not feasible in this worktree (no dist/, no node_modules/, installs forbidden)', and no probe artifact exists in the repo for README-9-R4. The only delivered change is .gitreins/tasks.yaml marking status: complete (lines 2875-2883). scripts/docs-check.js passes ('docs-check: OK') but only validates fence balance and links, not curl argv correctness.
Task marked complete but the README curl repair exists only on unmerged branch wt/README-9-R4 — mainline README.md:450-462 is still malformed (L453/L456 truncate the URL at `&`), and the required isolated auth=apikey five-command probe was never run or recorded.

Overall: FAIL ✗
