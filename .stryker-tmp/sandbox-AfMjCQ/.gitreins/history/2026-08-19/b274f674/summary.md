# Verdict: DB-GAP-031-ROLLOUT

**Task:** Stage DB-GAP-031 live auth rollout (tokens + consumers)
**Evaluated:** 2026-08-19T19:57:30.544821
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: [90m2:54PM[0m [32mINF[0m [1mscanned ~10603504 bytes (10.60 MB) in 2.17s[0m
[90m2:54PM[0m [3
  ✓ tests: 
[1m[30m[46m RUN [49m[39m[22m [36mv4.1.10 [39m[90m/home/kara/duckbrain[39m

 [32m✓[39m s
- ✓ **tier2**
  - COMPLETE
  ✓ auth.json holds scoped tokens for standin-pick/tg-backfill/state-db-backfill/schedulerd-sync/foreman-status; the 3 ~/.hermes/scripts consumers send X-API-Key when DUCKBRAIN_API_KEY set; live :3000 daemon NOT yet flipped (tokenless GET still 200, unit has no --auth): (1) ~/.duckbrain/auth.json (mtime 14:47) holds scoped tokens for all 5: standin-pick(ns coding-hermes), tg-backfill(ns chat-archive), state-db-backfill(ns chat-archive), schedulerd-sync(ns coding-hermes), foreman-status(ns duckbrain). (2) The 3 ~/.hermes/scripts consumers send X-API-Key when DUCKBRAIN_API_KEY set: standin-pick.py:26,125; state_db_backfill.py:17,56; tg_backfill_duckbrain.py:23,77 (all use DB_KEY=os.environ.get('DUCKBRAIN_API_KEY','') and conditionally add X-API-Key header). (3) Live :3000 daemon NOT flipped: tokenless GET /users,/namespaces,/health all return 200 (not 401); running process cmd 'node bin/duckbrain.js http --port 3000 --rate-limit 600 --unix-socket=...' has no --auth; systemd unit ~/.config/systemd/user/duckbrain-http.service ExecStart has no --auth. Auth tests pass: middleware.test.ts 24/24, http-auth.int.test.ts 6/6.
All three parts of the DB-GAP-031 live auth rollout criterion verified: scoped tokens in auth.json for all 5 consumers, the 3 ~/.hermes/scripts consumers send X-API-Key when DUCKBRAIN_API_KEY set, and the live :3000 daemon is not yet flipped (tokenless GET 200, unit has no --auth).

## Summary

Judge Result: DB-GAP-031-ROLLOUT

Stage tier1: PASS
    ✓ secrets: [90m2:54PM[0m [32mINF[0m [1mscanned ~10603504 bytes (10.60 MB) in 2.17s[0m
[90m2:54PM[0m [3
  ✓ tests: 
[1m[30m[46m RUN [49m[39m[22m [36mv4.1.10 [39m[90m/home/kara/duckbrain[39m

 [32m✓[39m s

Stage tier2: PASS
  COMPLETE
  ✓ auth.json holds scoped tokens for standin-pick/tg-backfill/state-db-backfill/schedulerd-sync/foreman-status; the 3 ~/.hermes/scripts consumers send X-API-Key when DUCKBRAIN_API_KEY set; live :3000 daemon NOT yet flipped (tokenless GET still 200, unit has no --auth): (1) ~/.duckbrain/auth.json (mtime 14:47) holds scoped tokens for all 5: standin-pick(ns coding-hermes), tg-backfill(ns chat-archive), state-db-backfill(ns chat-archive), schedulerd-sync(ns coding-hermes), foreman-status(ns duckbrain). (2) The 3 ~/.hermes/scripts consumers send X-API-Key when DUCKBRAIN_API_KEY set: standin-pick.py:26,125; state_db_backfill.py:17,56; tg_backfill_duckbrain.py:23,77 (all use DB_KEY=os.environ.get('DUCKBRAIN_API_KEY','') and conditionally add X-API-Key header). (3) Live :3000 daemon NOT flipped: tokenless GET /users,/namespaces,/health all return 200 (not 401); running process cmd 'node bin/duckbrain.js http --port 3000 --rate-limit 600 --unix-socket=...' has no --auth; systemd unit ~/.config/systemd/user/duckbrain-http.service ExecStart has no --auth. Auth tests pass: middleware.test.ts 24/24, http-auth.int.test.ts 6/6.
All three parts of the DB-GAP-031 live auth rollout criterion verified: scoped tokens in auth.json for all 5 consumers, the 3 ~/.hermes/scripts consumers send X-API-Key when DUCKBRAIN_API_KEY set, and the live :3000 daemon is not yet flipped (tokenless GET 200, unit has no --auth).

Overall: PASS ✓
