# Verdict: REALTIME-DOC-001

**Task:** Document the shipped committed SSE change feed
**Evaluated:** 2026-09-17T06:23:43.835468
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: [90m1:19AM[0m [32mINF[0m [1mscanned ~9330804 bytes (9.33 MB) in 1.91s[0m
[90m1:19AM[0m [32m
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  132 passed (132)
      Tests  1122 passed (1122)

- ✓ **tier2**
  - COMPLETE
  ✓ docs/api/http-api.md documents GET /api/ns/:ns/changes with authenticated curl subscription, tables/ops/cursor grammar, ready/change wire schema, opaque dbch1 cursor, committed-only namespace ordering and at-least-once dedupe.: docs/api/http-api.md:768-1000 (commit 6c9c1aa). Route heading 770; authenticated curl with X-API-Key 807-815; grammar table 786-793 (tables/ops/cursor); wire schema 818-850 (duckbrain.ready.v1 no-id + duckbrain.change.v1 required-field table); opaque dbch1 cursor 860-866 matching src/http/realtime/cursor.ts:4-16,69,78; committed-only 772-776; namespace ordering 913-918; at-least-once dedupe 919-924. Route path confirmed src/http/routes/realtime.ts:51.
  ✓ docs/api/http-api.md gives correct Last-Event-ID and cursor resume examples, default 15-second heartbeat, overflow/revocation behavior and 410 CHANGE_CURSOR_GONE recovery that requires a fresh data snapshot, not merely reconnecting without a cursor; explains no-cursor subscription is live-only.: Resume examples 870-882 (?cursor= and Last-Event-ID). Heartbeat 853-856 default 15s matches src/config/index.ts:115,136 (heartbeatMs 15_000). Overflow 925-930 (maxQueueEvents 256/maxQueueBytes 1MiB matches config 119-121); revocation 931-934 (duckbrain.revoked.v1). 410 CHANGE_CURSOR_GONE 886-903 explicitly states '410 recovery is a full resync, not a retry' requiring reconnect WITHOUT cursor + fresh snapshot. Live-only no-cursor 905-908. Error table 941-949.
  ✓ skills/duckbrain-usage/SKILL.md provides a concise working consumer recipe and valid link to the detailed HTTP reference; both distinguish legacy events, SSE-only v1, namespace existence prerequisite and lack of exactly-once guarantees.: skills/duckbrain-usage/SKILL.md:128-165 (commit 6c9c1aa). Consumer recipe 138-158 (subscribe/filter/resume/410 resync); namespace-must-exist prerequisite line 139; SSE-only v1 + legacy /api/events/:namespace distinction 135-136; at-least-once/no exactly-once 160-161; overflow/revoked 161-163. Link line 165 ../../docs/api/http-api.md#realtime-change-feed-supa-5 matches heading '### Realtime Change Feed (SUPA-5)' at http-api.md:768. Both docs cover legacy, SSE-only v1, namespace prerequisite, no exactly-once.
  ✓ Changes are limited to the two documentation files plus GitReins lifecycle metadata; existing realtime tests, TypeScript check and full unit suite pass; examples agree with current implementation. Scratch verification must never modify production namespaces or auth.: Commit 6c9c1aa touches ONLY docs/api/http-api.md (+200) and skills/duckbrain-usage/SKILL.md (+39); working tree adds only .gitreins/tasks.yaml (lifecycle) and .coding-hermes/board/events.jsonl (board audit metadata); no src/ changes. Tests: realtime suites 4 files/10 tests PASS; full suite `npx vitest run` = 132 files / 1122 tests passed; `npx tsc --noEmit` exit 0. Examples agree with impl (realtime.ts:51, wire.ts, cursor.ts, config defaults). Scratch safety documented SKILL.md:268-296 (DUCKBRAIN_NAMESPACES_PATH + --auth-file isolation); git status shows no namespace/auth files modified.
All four criteria pass: the two documentation files fully and accurately document the shipped SUPA-5 SSE change feed, changes are scoped to docs plus GitReins metadata, and realtime tests, tsc, and the full 132-file/1122-test unit suite are green.

## Summary

Judge Result: REALTIME-DOC-001

Stage tier1: PASS
    ✓ secrets: [90m1:19AM[0m [32mINF[0m [1mscanned ~9330804 bytes (9.33 MB) in 1.91s[0m
[90m1:19AM[0m [32m
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  132 passed (132)
      Tests  1122 passed (1122)


Stage tier2: PASS
  COMPLETE
  ✓ docs/api/http-api.md documents GET /api/ns/:ns/changes with authenticated curl subscription, tables/ops/cursor grammar, ready/change wire schema, opaque dbch1 cursor, committed-only namespace ordering and at-least-once dedupe.: docs/api/http-api.md:768-1000 (commit 6c9c1aa). Route heading 770; authenticated curl with X-API-Key 807-815; grammar table 786-793 (tables/ops/cursor); wire schema 818-850 (duckbrain.ready.v1 no-id + duckbrain.change.v1 required-field table); opaque dbch1 cursor 860-866 matching src/http/realtime/cursor.ts:4-16,69,78; committed-only 772-776; namespace ordering 913-918; at-least-once dedupe 919-924. Route path confirmed src/http/routes/realtime.ts:51.
  ✓ docs/api/http-api.md gives correct Last-Event-ID and cursor resume examples, default 15-second heartbeat, overflow/revocation behavior and 410 CHANGE_CURSOR_GONE recovery that requires a fresh data snapshot, not merely reconnecting without a cursor; explains no-cursor subscription is live-only.: Resume examples 870-882 (?cursor= and Last-Event-ID). Heartbeat 853-856 default 15s matches src/config/index.ts:115,136 (heartbeatMs 15_000). Overflow 925-930 (maxQueueEvents 256/maxQueueBytes 1MiB matches config 119-121); revocation 931-934 (duckbrain.revoked.v1). 410 CHANGE_CURSOR_GONE 886-903 explicitly states '410 recovery is a full resync, not a retry' requiring reconnect WITHOUT cursor + fresh snapshot. Live-only no-cursor 905-908. Error table 941-949.
  ✓ skills/duckbrain-usage/SKILL.md provides a concise working consumer recipe and valid link to the detailed HTTP reference; both distinguish legacy events, SSE-only v1, namespace existence prerequisite and lack of exactly-once guarantees.: skills/duckbrain-usage/SKILL.md:128-165 (commit 6c9c1aa). Consumer recipe 138-158 (subscribe/filter/resume/410 resync); namespace-must-exist prerequisite line 139; SSE-only v1 + legacy /api/events/:namespace distinction 135-136; at-least-once/no exactly-once 160-161; overflow/revoked 161-163. Link line 165 ../../docs/api/http-api.md#realtime-change-feed-supa-5 matches heading '### Realtime Change Feed (SUPA-5)' at http-api.md:768. Both docs cover legacy, SSE-only v1, namespace prerequisite, no exactly-once.
  ✓ Changes are limited to the two documentation files plus GitReins lifecycle metadata; existing realtime tests, TypeScript check and full unit suite pass; examples agree with current implementation. Scratch verification must never modify production namespaces or auth.: Commit 6c9c1aa touches ONLY docs/api/http-api.md (+200) and skills/duckbrain-usage/SKILL.md (+39); working tree adds only .gitreins/tasks.yaml (lifecycle) and .coding-hermes/board/events.jsonl (board audit metadata); no src/ changes. Tests: realtime suites 4 files/10 tests PASS; full suite `npx vitest run` = 132 files / 1122 tests passed; `npx tsc --noEmit` exit 0. Examples agree with impl (realtime.ts:51, wire.ts, cursor.ts, config defaults). Scratch safety documented SKILL.md:268-296 (DUCKBRAIN_NAMESPACES_PATH + --auth-file isolation); git status shows no namespace/auth files modified.
All four criteria pass: the two documentation files fully and accurately document the shipped SUPA-5 SSE change feed, changes are scoped to docs plus GitReins metadata, and realtime tests, tsc, and the full 132-file/1122-test unit suite are green.

Overall: PASS ✓
