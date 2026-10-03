# Verdict: DF-0926-05

**Task:** Rewrite examples/custom-storage to the real config schema and flags
**Evaluated:** 2026-10-03T03:01:14.923882
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: RUN  v5.0.2 /home/kara/duckbrain
- ✓ **tier2**
  - COMPLETE
  ✓ example README + duckbrain.config.json contain only keys that exist in the src/config/index.ts zod schema; zero --verify-config or --config= occurrences; the documented invocation was executed live and a scratch daemon answered /health 200 (worker evidence b156d6f): All three sub-requirements verified. (1) Schema keys: every key in examples/custom-storage/duckbrain.config.json and README exists in src/config/index.ts zod schema — defaultNamespace(L49), authorEmail(L52), namespacesPath(L55), gitBatching{maxLines L61,maxSeconds L63,enabled L65}, storage{maxLinesPerChunk L73,maxBytesPerChunk L75}, durability{defaultMode L37,overrides L39}, namespaces{autoCreate L96}, serialization{maxPendingRows L103,maxPendingBytes L104}, realtime{enabled L126,pollIntervalMs L128,heartbeatMs L130}, squash{maxAgeDays L203,thresholdRecords L205,autoCompact L207,squashGitHistory L209,compressionLevel L211}, embedding.cacheDir(L238). (2) Forbidden flags: `grep -rn -- "--verify-config\|--config=" examples/custom-storage/` => exit=1, zero occurrences. (3) Live invocation: ran `DUCKBRAIN_CONFIG_PATH=./examples/custom-storage/duckbrain.config.json node bin/duckbrain.js http --port=39472`; `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:39472/health` => 200; daemon log shows 'HTTP server started at http://127.0.0.1:39472' and 'HTTP server ready'. `config show` with the custom path resolved all keys correctly. Tests: `npx vitest run src/config` => 'Test Files 5 passed (5), Tests 33 passed (33)' across 3 consecutive runs (one transient failure in config-pollution-gap007.test.ts was a race with the concurrently-running daemon snapshotting repo duckbrain.config.json; passes cleanly in isolation). [resolution 0.35; duckbrain.config.json, src/config/index.ts]


## Summary

Judge Result: DF-0926-05

Stage tier1: FAIL
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: RUN  v5.0.2 /home/kara/duckbrain

Stage tier2: PASS
  COMPLETE
  ✓ example README + duckbrain.config.json contain only keys that exist in the src/config/index.ts zod schema; zero --verify-config or --config= occurrences; the documented invocation was executed live and a scratch daemon answered /health 200 (worker evidence b156d6f): All three sub-requirements verified. (1) Schema keys: every key in examples/custom-storage/duckbrain.config.json and README exists in src/config/index.ts zod schema — defaultNamespace(L49), authorEmail(L52), namespacesPath(L55), gitBatching{maxLines L61,maxSeconds L63,enabled L65}, storage{maxLinesPerChunk L73,maxBytesPerChunk L75}, durability{defaultMode L37,overrides L39}, namespaces{autoCreate L96}, serialization{maxPendingRows L103,maxPendingBytes L104}, realtime{enabled L126,pollIntervalMs L128,heartbeatMs L130}, squash{maxAgeDays L203,thresholdRecords L205,autoCompact L207,squashGitHistory L209,compressionLevel L211}, embedding.cacheDir(L238). (2) Forbidden flags: `grep -rn -- "--verify-config\|--config=" examples/custom-storage/` => exit=1, zero occurrences. (3) Live invocation: ran `DUCKBRAIN_CONFIG_PATH=./examples/custom-storage/duckbrain.config.json node bin/duckbrain.js http --port=39472`; `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:39472/health` => 200; daemon log shows 'HTTP server started at http://127.0.0.1:39472' and 'HTTP server ready'. `config show` with the custom path resolved all keys correctly. Tests: `npx vitest run src/config` => 'Test Files 5 passed (5), Tests 33 passed (33)' across 3 consecutive runs (one transient failure in config-pollution-gap007.test.ts was a race with the concurrently-running daemon snapshotting repo duckbrain.config.json; passes cleanly in isolation). [resolution 0.35; duckbrain.config.json, src/config/index.ts]


Overall: FAIL ✗
