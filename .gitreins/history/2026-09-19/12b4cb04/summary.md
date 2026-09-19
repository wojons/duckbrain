# Verdict: SEC-001

**Task:** Chat-archive ingest secret scrub + history scrub
**Evaluated:** 2026-09-19T14:25:48.567145
**Result:** ✗ FAIL

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v4.1.10 /home/kara/duckbrain
- ✗ **tier2**
  - INCOMPLETE
  ✗ Shared scrubber wired into all 3 ingester scripts covering the full key-shape class; planted-shape test passes; chat-archive git history free of the two leaked keys; s3daily remote force-pushed and verified: Most components PASS but the 'full key-shape class' requirement is NOT met. (a) Shared scrubber exists: /home/kara/.hermes/scripts/secret_scrub.py exposes scrub()/SCRUB_PATTERNS. (b) Wired into all 3 ingesters: daily_chat_extract.py:28 import + :86 (state.db leg) + :124 (spool leg); state_db_backfill.py:16 import + :109; tg_backfill_duckbrain.py:23 import + :112 (local partial SCRUB list deleted); --help exits 0 on all 3. (c) Planted-shape test: `python3 test_secret_scrub.py` EXIT=0, 'ALL TESTS PASSED (14 positive + 2 PEM + 2 fp-guards + idempotency)'. (d) History scrub: chat-archive HEAD bbfbf417; `git grep sk-xt-4a0014|sk-xt-7585|e76eda5ea9|82963c549c` over $(git rev-list --all) = 0 hits (exit 1); full scan of ALL 852 git objects incl. unreachable = 0 hits; carrier 818339a no longer exists; carriers now hold sk-xt-[REDACTED] markers. (e) Remote: live `git ls-remote s3daily` returns bbfbf417 == local HEAD, rev-list parity 0/0. FAILURE: the task scope explicitly enumerates 'ghp_/ghpou_' in the key-shape class, but secret_scrub.py:56 regex is `\bgh[pousr]_[A-Za-z0-9]{20,}\b`, which matches ghp_/gho_/ghu_/ghs_/ghr_ but NOT ghpou_ (5-char prefix). Verified live: scrub('ghpou_'+'A'*40) returns the value UNCHANGED (leak). test_secret_scrub.py has no ghpou_ case (only ghp_ at :23 and gho_ at :24), so the planted-shape test does not cover the full class either. The scrubber therefore does not cover the full key-shape class named in the task.
Scrubber is wired into all 3 ingesters, the 19-check test passes, both leaked keys are gone from all 852 chat-archive objects, and s3daily HEAD matches local bbfbf417 — but the scrubber misses the explicitly-required ghpou_ shape (regex `gh[pousr]_` does not match it, and no test covers it), so 'full key-shape class' is unmet.

## Summary

Judge Result: SEC-001

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v4.1.10 /home/kara/duckbrain

Stage tier2: FAIL
  INCOMPLETE
  ✗ Shared scrubber wired into all 3 ingester scripts covering the full key-shape class; planted-shape test passes; chat-archive git history free of the two leaked keys; s3daily remote force-pushed and verified: Most components PASS but the 'full key-shape class' requirement is NOT met. (a) Shared scrubber exists: /home/kara/.hermes/scripts/secret_scrub.py exposes scrub()/SCRUB_PATTERNS. (b) Wired into all 3 ingesters: daily_chat_extract.py:28 import + :86 (state.db leg) + :124 (spool leg); state_db_backfill.py:16 import + :109; tg_backfill_duckbrain.py:23 import + :112 (local partial SCRUB list deleted); --help exits 0 on all 3. (c) Planted-shape test: `python3 test_secret_scrub.py` EXIT=0, 'ALL TESTS PASSED (14 positive + 2 PEM + 2 fp-guards + idempotency)'. (d) History scrub: chat-archive HEAD bbfbf417; `git grep sk-xt-4a0014|sk-xt-7585|e76eda5ea9|82963c549c` over $(git rev-list --all) = 0 hits (exit 1); full scan of ALL 852 git objects incl. unreachable = 0 hits; carrier 818339a no longer exists; carriers now hold sk-xt-[REDACTED] markers. (e) Remote: live `git ls-remote s3daily` returns bbfbf417 == local HEAD, rev-list parity 0/0. FAILURE: the task scope explicitly enumerates 'ghp_/ghpou_' in the key-shape class, but secret_scrub.py:56 regex is `\bgh[pousr]_[A-Za-z0-9]{20,}\b`, which matches ghp_/gho_/ghu_/ghs_/ghr_ but NOT ghpou_ (5-char prefix). Verified live: scrub('ghpou_'+'A'*40) returns the value UNCHANGED (leak). test_secret_scrub.py has no ghpou_ case (only ghp_ at :23 and gho_ at :24), so the planted-shape test does not cover the full class either. The scrubber therefore does not cover the full key-shape class named in the task.
Scrubber is wired into all 3 ingesters, the 19-check test passes, both leaked keys are gone from all 852 chat-archive objects, and s3daily HEAD matches local bbfbf417 — but the scrubber misses the explicitly-required ghpou_ shape (regex `gh[pousr]_` does not match it, and no test covers it), so 'full key-shape class' is unmet.

Overall: FAIL ✗
