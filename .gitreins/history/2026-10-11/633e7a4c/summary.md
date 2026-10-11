# Verdict: DOC-11

**Task:** Repair three broken relative documentation links
**Evaluated:** 2026-10-11T07:21:40.940457
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✓ Fix or remove the three broken links identified by python3 /home/kara/.hermes/stand-in/docs/duckbrain/resolve-links.py: docs/guide/getting-started.md:410 (docker), docs/guide/getting-started.md:439 (troubleshooting), docs/guide/license.md:88 (../LICENSE). Rerun the audit command and obtain BROKEN_LINKS 0.: Commit a126b3ee in /home/kara/duckbrain fixes all three links: getting-started.md:410 `[Deployment Guide](docker)` -> `(deployment)` (docs/guide/deployment.md exists); getting-started.md:439 `[Troubleshooting](troubleshooting)` -> `[Deployment Guide](deployment)` (no troubleshooting.md exists); license.md:88 `../LICENSE` -> `../../LICENSE` (LICENSE is at repo root, not docs/). Pre-state confirmed via `git show a126b3ee^` showing the exact three broken targets. Audit command `python3 /home/kara/.hermes/stand-in/docs/duckbrain/resolve-links.py` (exit_code 0) outputs `LINK_FILES 39` / `BROKEN_LINKS 0`. [resolution 0.05; /home/kara/.hermes/stand-in/docs/duckbrain/resolve-links.py, docs/guide/getting-started.md:410, docs/guide/license.md:88]
All three broken relative links were repaired in commit a126b3ee and the audit command now reports BROKEN_LINKS 0.

## Summary

Judge Result: DOC-11

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✓ Fix or remove the three broken links identified by python3 /home/kara/.hermes/stand-in/docs/duckbrain/resolve-links.py: docs/guide/getting-started.md:410 (docker), docs/guide/getting-started.md:439 (troubleshooting), docs/guide/license.md:88 (../LICENSE). Rerun the audit command and obtain BROKEN_LINKS 0.: Commit a126b3ee in /home/kara/duckbrain fixes all three links: getting-started.md:410 `[Deployment Guide](docker)` -> `(deployment)` (docs/guide/deployment.md exists); getting-started.md:439 `[Troubleshooting](troubleshooting)` -> `[Deployment Guide](deployment)` (no troubleshooting.md exists); license.md:88 `../LICENSE` -> `../../LICENSE` (LICENSE is at repo root, not docs/). Pre-state confirmed via `git show a126b3ee^` showing the exact three broken targets. Audit command `python3 /home/kara/.hermes/stand-in/docs/duckbrain/resolve-links.py` (exit_code 0) outputs `LINK_FILES 39` / `BROKEN_LINKS 0`. [resolution 0.05; /home/kara/.hermes/stand-in/docs/duckbrain/resolve-links.py, docs/guide/getting-started.md:410, docs/guide/license.md:88]
All three broken relative links were repaired in commit a126b3ee and the audit command now reports BROKEN_LINKS 0.

Overall: PASS ✓
