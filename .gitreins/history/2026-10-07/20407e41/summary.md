# Verdict: README-8

**Task:** README duckbrain CLI commands not runnable from fresh clone (no bin on PATH)
**Evaluated:** 2026-10-07T08:30:14.650361
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✓ README documents a working way to obtain/run the duckbrain CLI after a repo clone; verified by actually running the documented command: README.md lines 161-170 document two approaches: (1) `npm install -g .` to globally link duckbrain on PATH, (2) `node bin/duckbrain.js <command>` without install. Verified by running: `node bin/duckbrain.js status` (exit 0, prints status), `npm install -g .` (exit 0, added 1 package), `which duckbrain` → `/home/kara/.hermes/node/bin/duckbrain`, `duckbrain --version` (exit 0, prints v1.0.0).
README documents two working ways to run duckbrain CLI after clone, both verified by actual execution.

## Summary

Judge Result: README-8

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✓ README documents a working way to obtain/run the duckbrain CLI after a repo clone; verified by actually running the documented command: README.md lines 161-170 document two approaches: (1) `npm install -g .` to globally link duckbrain on PATH, (2) `node bin/duckbrain.js <command>` without install. Verified by running: `node bin/duckbrain.js status` (exit 0, prints status), `npm install -g .` (exit 0, added 1 package), `which duckbrain` → `/home/kara/.hermes/node/bin/duckbrain`, `duckbrain --version` (exit 0, prints v1.0.0).
README documents two working ways to run duckbrain CLI after clone, both verified by actual execution.

Overall: PASS ✓
