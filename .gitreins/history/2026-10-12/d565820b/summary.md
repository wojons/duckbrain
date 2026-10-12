# Verdict: DOC-6

**Task:** Remove phantom env vars from configuration.md
**Evaluated:** 2026-10-12T01:33:28.360017
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✓ docs/guide/configuration.md env-var table contains only vars with >=1 non-test process/env read in src or bin; the 4 phantom vars (DUCKBRAIN_HOME, DUCKBRAIN_LOG_LEVEL, DUCKBRAIN_UI_PORT, DUCKBRAIN_NAMESPACE) removed or annotated 'not implemented': All 4 phantom vars handled in docs/guide/configuration.md table (lines 9-35): DUCKBRAIN_HOME (line 9) annotated '**Not implemented.**' — grep for process.env.DUCKBRAIN_HOME in src/bin returns 0 non-test reads; DUCKBRAIN_LOG_LEVEL (line 20) annotated '**Not implemented.**' — 0 non-test reads; DUCKBRAIN_UI_PORT (line 16) annotated '**Not implemented** as a DuckBrain runtime variable' — only read in packages/ui/vite.config.ts:6 (dev tooling), not src/bin; DUCKBRAIN_NAMESPACE (line 10) is NOT a phantom — it has a genuine non-test read at src/config/index.ts:618 (process.env.DUCKBRAIN_NAMESPACE?.trim() in applyEnvOverrides), so it is correctly documented as implemented. Every other table var verified to have >=1 non-test read in src/bin: DUCKBRAIN_HOME_ROOT (src/config/index.ts:531), DUCKBRAIN_DURABILITY_MODE (index.ts:652), DUCKBRAIN_NAMESPACES_PATH (index.ts:600), DUCKBRAIN_DATA_DIR (src/utils/pidfile.ts:59), DUCKBRAIN_API_PORT (src/testing/orphan-daemon-reaper.ts:593), DUCKBRAIN_UI_DIST_DIR (src/cli/http.ts:94), DUCKBRAIN_HTTP_SOCKET/_MODE (src/cli/service.ts:49,51), DUCKBRAIN_SEARCH_MIN_SCORE (src/mcp/tools/recall.ts:252), DUCKBRAIN_SEARCH_AUTOBUILD_MAX_ROWS (src/search/index.ts:413), DUCKBRAIN_ALLOWED_HOSTS (src/cli/http.ts:1439), DUCKBRAIN_REALTIME_POLL_MS/HEARTBEAT_MS (index.ts:666-667), DUCKBRAIN_SKIP_SEARCH_REBUILD (src/search/hooks.ts:47), DUCKBRAIN_KEYS_CACHE (src/keys/keyListCache.ts:79), DUCKBRAIN_AUTH_FILE (src/cli/http.ts:185), DUCKBRAIN_S3_ACCESS_KEY_ID/SECRET (src/s3/query.ts:107,110), DUCKBRAIN_GIT_AUTHOR_NAME/EMAIL (src/git/identity.ts:136-137), NODE_ENV (src/mcp/tools/server.ts:481); AUTH_TYPE/AUTH_TOKEN annotated 'Not implemented' with 0 reads. Change committed as 881ef049. Docs-only change; npx vitest run times out at 30s on this large repo and is not applicable to a documentation-content criterion — verification is via direct grep of actual code reads. [resolution 0.21; docs/guide/configuration.md]
The configuration.md env-var table correctly annotates the 3 truly-unread phantom vars as 'Not implemented' and documents DUCKBRAIN_NAMESPACE as implemented (it has a real non-test read at src/config/index.ts:618), with every remaining row backed by a verified non-test read in src/bin.

## Summary

Judge Result: DOC-6

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✓ docs/guide/configuration.md env-var table contains only vars with >=1 non-test process/env read in src or bin; the 4 phantom vars (DUCKBRAIN_HOME, DUCKBRAIN_LOG_LEVEL, DUCKBRAIN_UI_PORT, DUCKBRAIN_NAMESPACE) removed or annotated 'not implemented': All 4 phantom vars handled in docs/guide/configuration.md table (lines 9-35): DUCKBRAIN_HOME (line 9) annotated '**Not implemented.**' — grep for process.env.DUCKBRAIN_HOME in src/bin returns 0 non-test reads; DUCKBRAIN_LOG_LEVEL (line 20) annotated '**Not implemented.**' — 0 non-test reads; DUCKBRAIN_UI_PORT (line 16) annotated '**Not implemented** as a DuckBrain runtime variable' — only read in packages/ui/vite.config.ts:6 (dev tooling), not src/bin; DUCKBRAIN_NAMESPACE (line 10) is NOT a phantom — it has a genuine non-test read at src/config/index.ts:618 (process.env.DUCKBRAIN_NAMESPACE?.trim() in applyEnvOverrides), so it is correctly documented as implemented. Every other table var verified to have >=1 non-test read in src/bin: DUCKBRAIN_HOME_ROOT (src/config/index.ts:531), DUCKBRAIN_DURABILITY_MODE (index.ts:652), DUCKBRAIN_NAMESPACES_PATH (index.ts:600), DUCKBRAIN_DATA_DIR (src/utils/pidfile.ts:59), DUCKBRAIN_API_PORT (src/testing/orphan-daemon-reaper.ts:593), DUCKBRAIN_UI_DIST_DIR (src/cli/http.ts:94), DUCKBRAIN_HTTP_SOCKET/_MODE (src/cli/service.ts:49,51), DUCKBRAIN_SEARCH_MIN_SCORE (src/mcp/tools/recall.ts:252), DUCKBRAIN_SEARCH_AUTOBUILD_MAX_ROWS (src/search/index.ts:413), DUCKBRAIN_ALLOWED_HOSTS (src/cli/http.ts:1439), DUCKBRAIN_REALTIME_POLL_MS/HEARTBEAT_MS (index.ts:666-667), DUCKBRAIN_SKIP_SEARCH_REBUILD (src/search/hooks.ts:47), DUCKBRAIN_KEYS_CACHE (src/keys/keyListCache.ts:79), DUCKBRAIN_AUTH_FILE (src/cli/http.ts:185), DUCKBRAIN_S3_ACCESS_KEY_ID/SECRET (src/s3/query.ts:107,110), DUCKBRAIN_GIT_AUTHOR_NAME/EMAIL (src/git/identity.ts:136-137), NODE_ENV (src/mcp/tools/server.ts:481); AUTH_TYPE/AUTH_TOKEN annotated 'Not implemented' with 0 reads. Change committed as 881ef049. Docs-only change; npx vitest run times out at 30s on this large repo and is not applicable to a documentation-content criterion — verification is via direct grep of actual code reads. [resolution 0.21; docs/guide/configuration.md]
The configuration.md env-var table correctly annotates the 3 truly-unread phantom vars as 'Not implemented' and documents DUCKBRAIN_NAMESPACE as implemented (it has a real non-test read at src/config/index.ts:618), with every remaining row backed by a verified non-test read in src/bin.

Overall: PASS ✓
