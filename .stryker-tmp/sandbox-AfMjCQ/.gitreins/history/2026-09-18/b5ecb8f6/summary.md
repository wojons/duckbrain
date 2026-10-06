# Verdict: S3-GIT-005

**Task:** S3-GIT-005: duplicate-bundle harness must print a per-case ledger and refuse a clean green when its case set is incomplete
**Evaluated:** 2026-09-18T18:10:19.195065
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: [90m1:08PM[0m [32mINF[0m [1mscanned ~9940912 bytes (9.94 MB) in 1.87s[0m
[90m1:08PM[0m [32m
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  149 passed (149)
      Tests  1168 passed (1168)

- ✓ **tier2**
  - COMPLETE
  ✓ scripts/s3/test-duplicate-bundle-repair.sh prints a per-case ledger (case id, assertions run, PASS/FAIL/SKIP) and a total; any run where a case does not execute its full assertion set is reported explicitly (SKIP/PARTIAL) and exits non-zero; a normal run reports the full roster (cases A-G, 51 assertions) and exits 0; no vitest files added; AGENTS.md counts unchanged; scripts/s3/README.md documents the ledger: Ledger: test-duplicate-bundle-repair.sh:571-577 prints 'case ledger:' with per-case 'case X: N assertions PASS/FAIL/SKIP' lines; total at :623 'roster: 7/7 cases, 51/51 assertions'. Normal run: EXIT=0, ledger A:17 B:6 C:4 D:6 E:5 F:5 G:8 (=51), 'harness: 51 passed, 0 failed'. SKIP path: DUCKBRAIN_S3_HARNESS_SKIP_CASE=C -> 'SKIP: case C ... (0/4 assertions)' + 'harness: INCOMPLETE ... exit 3', EXIT=3. PARTIAL path: ROSTER_COUNTS A=18 -> 'PARTIAL: case A ran 17/18 assertions', EXIT=3. No vitest files added: commit ca257e5 touched only .gitreins/tasks.yaml, scripts/s3/README.md, scripts/s3/test-duplicate-bundle-repair.sh (git show --stat). AGENTS.md unchanged: git diff HEAD -- AGENTS.md = 0 lines. README documents ledger: scripts/s3/README.md:84-135 section 'Harness output: per-case ledger + roster contract (exit 3)' with sample output, roster counts, PARTIAL/SKIP examples, and exit-code table. LSP diagnostics: 0 findings.
The duplicate-bundle harness prints a per-case ledger with a 51-assertion roster total, exits 0 on a full run and 3 on SKIP/PARTIAL, adds no vitest files, leaves AGENTS.md unchanged, and is documented in scripts/s3/README.md.

## Summary

Judge Result: S3-GIT-005

Stage tier1: PASS
    ✓ secrets: [90m1:08PM[0m [32mINF[0m [1mscanned ~9940912 bytes (9.94 MB) in 1.87s[0m
[90m1:08PM[0m [32m
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  149 passed (149)
      Tests  1168 passed (1168)


Stage tier2: PASS
  COMPLETE
  ✓ scripts/s3/test-duplicate-bundle-repair.sh prints a per-case ledger (case id, assertions run, PASS/FAIL/SKIP) and a total; any run where a case does not execute its full assertion set is reported explicitly (SKIP/PARTIAL) and exits non-zero; a normal run reports the full roster (cases A-G, 51 assertions) and exits 0; no vitest files added; AGENTS.md counts unchanged; scripts/s3/README.md documents the ledger: Ledger: test-duplicate-bundle-repair.sh:571-577 prints 'case ledger:' with per-case 'case X: N assertions PASS/FAIL/SKIP' lines; total at :623 'roster: 7/7 cases, 51/51 assertions'. Normal run: EXIT=0, ledger A:17 B:6 C:4 D:6 E:5 F:5 G:8 (=51), 'harness: 51 passed, 0 failed'. SKIP path: DUCKBRAIN_S3_HARNESS_SKIP_CASE=C -> 'SKIP: case C ... (0/4 assertions)' + 'harness: INCOMPLETE ... exit 3', EXIT=3. PARTIAL path: ROSTER_COUNTS A=18 -> 'PARTIAL: case A ran 17/18 assertions', EXIT=3. No vitest files added: commit ca257e5 touched only .gitreins/tasks.yaml, scripts/s3/README.md, scripts/s3/test-duplicate-bundle-repair.sh (git show --stat). AGENTS.md unchanged: git diff HEAD -- AGENTS.md = 0 lines. README documents ledger: scripts/s3/README.md:84-135 section 'Harness output: per-case ledger + roster contract (exit 3)' with sample output, roster counts, PARTIAL/SKIP examples, and exit-code table. LSP diagnostics: 0 findings.
The duplicate-bundle harness prints a per-case ledger with a 51-assertion roster total, exits 0 on a full run and 3 on SKIP/PARTIAL, adds no vitest files, leaves AGENTS.md unchanged, and is documented in scripts/s3/README.md.

Overall: PASS ✓
