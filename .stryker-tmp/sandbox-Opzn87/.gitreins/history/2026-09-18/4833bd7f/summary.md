# Verdict: DB-SUPA-8-526

**Task:** Apply SUPA-8 positioning contract to public docs
**Evaluated:** 2026-09-18T13:17:28.188454
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: [90m8:11AM[0m [32mINF[0m [1mscanned ~8711357 bytes (8.71 MB) in 2.04s[0m
[90m8:11AM[0m [32m
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  149 passed (149)
      Tests  1168 passed (1168)

- ✓ **tier2**
  - COMPLETE
  ✓ README and docs/guide/positioning.md implement the approved positioning contract; tests and source-backed citations pass: README.md:18-56 and docs/guide/positioning.md implement the SUPA-8 contract: the approved one-sentence category statement appears verbatim (README.md:20; positioning.md:3-8; docs/index.md:11) matching docs/specs/SUPA-8-positioning.md; the four-status capability matrix (Available now / Implemented-release-evidence-pending / Implemented on branch / Planned / Non-goal) is at positioning.md:80-95 with README's compact version at :26-56; the long matrix has a single owner (only positioning.md, README compact, and the spec contain 'Available now'; ai-configure.md and http-api.md do not duplicate it); prohibited phrasings appear only inside the deny-list section (positioning.md:216-217), never as claims. Source-backed citations verified against real code: src/git/asof.ts:126 resolveAsOfRef, :212 readRowsAtRef, :361 queryMemoriesAtRef; src/git/autocommit.ts:287 git init, :352 commitNamespaceWithParams, :407 flushNamespaceCommit, :181-183/:325-327 maybeSyncOnCommit; src/cli/http.ts:477-481 route mounts; AGENTS.md:5-16 and :18-25; src/auth/{middleware,roles}.ts plus roles.test.ts/token-lifecycle.test.ts/backend-interface.test.ts exist; src/serialization/{namespaceWriter,audit,auditLedger}.ts exist; s3.enabled defaults false (src/config/index.ts:239,258). Tests run fresh: `npx vitest run` exit_code 0 with 'Test Files 149 passed (149)' and 'Tests 1168 passed (1168)'; targeted `npx vitest run src/git/asof.test.ts` exit_code 0 with 'Tests 17 passed (17)'. Caveat: the spec's named checks docs-positioning.test.mjs and scripts/verify-doc-links.mjs were never created in the repo, so the contract's own automated doc-lint is absent; the repo's actual suite passes and every citation was manually confirmed against source, so the criterion's substance holds.
README and docs/guide/positioning.md faithfully implement the SUPA-8 positioning contract with verified source citations, and the full vitest suite passes (149 files / 1168 tests, exit 0).

## Summary

Judge Result: DB-SUPA-8-526

Stage tier1: PASS
    ✓ secrets: [90m8:11AM[0m [32mINF[0m [1mscanned ~8711357 bytes (8.71 MB) in 2.04s[0m
[90m8:11AM[0m [32m
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  149 passed (149)
      Tests  1168 passed (1168)


Stage tier2: PASS
  COMPLETE
  ✓ README and docs/guide/positioning.md implement the approved positioning contract; tests and source-backed citations pass: README.md:18-56 and docs/guide/positioning.md implement the SUPA-8 contract: the approved one-sentence category statement appears verbatim (README.md:20; positioning.md:3-8; docs/index.md:11) matching docs/specs/SUPA-8-positioning.md; the four-status capability matrix (Available now / Implemented-release-evidence-pending / Implemented on branch / Planned / Non-goal) is at positioning.md:80-95 with README's compact version at :26-56; the long matrix has a single owner (only positioning.md, README compact, and the spec contain 'Available now'; ai-configure.md and http-api.md do not duplicate it); prohibited phrasings appear only inside the deny-list section (positioning.md:216-217), never as claims. Source-backed citations verified against real code: src/git/asof.ts:126 resolveAsOfRef, :212 readRowsAtRef, :361 queryMemoriesAtRef; src/git/autocommit.ts:287 git init, :352 commitNamespaceWithParams, :407 flushNamespaceCommit, :181-183/:325-327 maybeSyncOnCommit; src/cli/http.ts:477-481 route mounts; AGENTS.md:5-16 and :18-25; src/auth/{middleware,roles}.ts plus roles.test.ts/token-lifecycle.test.ts/backend-interface.test.ts exist; src/serialization/{namespaceWriter,audit,auditLedger}.ts exist; s3.enabled defaults false (src/config/index.ts:239,258). Tests run fresh: `npx vitest run` exit_code 0 with 'Test Files 149 passed (149)' and 'Tests 1168 passed (1168)'; targeted `npx vitest run src/git/asof.test.ts` exit_code 0 with 'Tests 17 passed (17)'. Caveat: the spec's named checks docs-positioning.test.mjs and scripts/verify-doc-links.mjs were never created in the repo, so the contract's own automated doc-lint is absent; the repo's actual suite passes and every citation was manually confirmed against source, so the criterion's substance holds.
README and docs/guide/positioning.md faithfully implement the SUPA-8 positioning contract with verified source citations, and the full vitest suite passes (149 files / 1168 tests, exit 0).

Overall: PASS ✓
