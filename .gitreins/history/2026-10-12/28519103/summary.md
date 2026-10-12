# Verdict: DOC-15

**Task:** Document shipped config schema sections
**Evaluated:** 2026-10-12T10:44:09.895389
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✓ docs/guide/configuration.md documents namespaces, serialization, realtime, and ddl.inferenceCompat with keys, types, defaults, runtime/persisted behavior, and API links; every key matches src/config/index.ts: All four sections present and accurate. namespaces (docs L128-147): autoCreate boolean default true = schema index.ts:130-134. serialization (docs L149-162): maxPendingRows integer 10000, maxPendingBytes integer 33554432 (32 MiB) = schema index.ts:137-149; docs correctly note no env override. realtime (docs L164-189): enabled bool true, pollIntervalMs int 1000, heartbeatMs int 15000, maxSubscribers int 100, maxQueueEvents int 256, maxQueueBytes int 1048576, maxReplayEvents int 10000, maxReplayCommits int 10000, retentionDays number 7 — all match schema index.ts:159-194; env overrides DUCKBRAIN_REALTIME_POLL_MS/HEARTBEAT_MS confirmed runtime-only at index.ts:666-694. ddl.inferenceCompat (docs L191-217): shippedAt string '2026-09-17T00:00:00.000Z', graceDays number 90, minMinorReleases int 2, minorReleasesShipped int>=0 0 — match schema index.ts:208-231; CONFIG_INVALID on unparseable shippedAt confirmed at inferenceCompat.ts:62-67. Runtime/persisted claims verified: updateConfig merges against readFileConfig not env-overridden (index.ts:746-767). Error codes verified: SERIALIZER_QUEUE_FULL+Retry-After:1 (namespaceWriter.ts:482,555; memories.ts:94), SUBSCRIBER_LIMIT 503 (cursor.ts:35), CHANGE_CURSOR_GONE 410 (cursor.ts:31), duckbrain.overflow.v1 (wire.ts:50), NAMESPACE_NOT_FOUND (remember.ts:295). API links resolve: docs/specs/SUPA-2-serialization.md, SUPA-5-realtime.md, SUPA-6-ddl.md exist; anchors #realtime-change-feed-supa-5 and #declared-tables-supa-3supa-6 match http-api.md L1125/L867; custom-tools.md exists. Tests: `npx vitest run src/config/` exit_code 0 — 'Test Files 6 passed (6), Tests 37 passed (37)'. [resolution 0.28; docs/guide/configuration.md, src/config/index.ts]
docs/guide/configuration.md fully and accurately documents namespaces, serialization, realtime, and ddl.inferenceCompat with keys/types/defaults/runtime-persisted behavior and working API links, all matching src/config/index.ts, with config tests passing.

## Summary

Judge Result: DOC-15

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✓ docs/guide/configuration.md documents namespaces, serialization, realtime, and ddl.inferenceCompat with keys, types, defaults, runtime/persisted behavior, and API links; every key matches src/config/index.ts: All four sections present and accurate. namespaces (docs L128-147): autoCreate boolean default true = schema index.ts:130-134. serialization (docs L149-162): maxPendingRows integer 10000, maxPendingBytes integer 33554432 (32 MiB) = schema index.ts:137-149; docs correctly note no env override. realtime (docs L164-189): enabled bool true, pollIntervalMs int 1000, heartbeatMs int 15000, maxSubscribers int 100, maxQueueEvents int 256, maxQueueBytes int 1048576, maxReplayEvents int 10000, maxReplayCommits int 10000, retentionDays number 7 — all match schema index.ts:159-194; env overrides DUCKBRAIN_REALTIME_POLL_MS/HEARTBEAT_MS confirmed runtime-only at index.ts:666-694. ddl.inferenceCompat (docs L191-217): shippedAt string '2026-09-17T00:00:00.000Z', graceDays number 90, minMinorReleases int 2, minorReleasesShipped int>=0 0 — match schema index.ts:208-231; CONFIG_INVALID on unparseable shippedAt confirmed at inferenceCompat.ts:62-67. Runtime/persisted claims verified: updateConfig merges against readFileConfig not env-overridden (index.ts:746-767). Error codes verified: SERIALIZER_QUEUE_FULL+Retry-After:1 (namespaceWriter.ts:482,555; memories.ts:94), SUBSCRIBER_LIMIT 503 (cursor.ts:35), CHANGE_CURSOR_GONE 410 (cursor.ts:31), duckbrain.overflow.v1 (wire.ts:50), NAMESPACE_NOT_FOUND (remember.ts:295). API links resolve: docs/specs/SUPA-2-serialization.md, SUPA-5-realtime.md, SUPA-6-ddl.md exist; anchors #realtime-change-feed-supa-5 and #declared-tables-supa-3supa-6 match http-api.md L1125/L867; custom-tools.md exists. Tests: `npx vitest run src/config/` exit_code 0 — 'Test Files 6 passed (6), Tests 37 passed (37)'. [resolution 0.28; docs/guide/configuration.md, src/config/index.ts]
docs/guide/configuration.md fully and accurately documents namespaces, serialization, realtime, and ddl.inferenceCompat with keys/types/defaults/runtime-persisted behavior and working API links, all matching src/config/index.ts, with config tests passing.

Overall: PASS ✓
