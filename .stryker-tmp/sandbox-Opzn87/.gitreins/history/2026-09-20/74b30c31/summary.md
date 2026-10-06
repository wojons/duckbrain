# Verdict: OPS-012

**Task:** In-daemon duplicate-bundle self-heal for s3 autopush (S3-GIT-004 repair moved into the layer that races)
**Evaluated:** 2026-09-20T05:55:17.549143
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v4.1.10 /home/kara/duckbrain
- ✓ **tier2**
  - COMPLETE
  ✓ src/git/s3-repair.ts faithfully ports repair_duplicate_bundles from scripts/s3/duckbrain-s3-push.sh (parse s3:// remote URL to bucket+prefix, list <prefix>/refs/heads/<branch>/ *.bundle objects excluding LOCK#/PROTECTED#/.zip//LOCKS//.lock, keeper=local-tip-sha else newest LastModified, skip stale sha absent from local repo via git cat-file -e, quarantine server-side copy to quarantine/git/<ns>/<branch>/<sha>.bundle with HeadObject size verify BEFORE delete, re-list assert, never throws) AND pushNamespaceAsync in src/git/autocommit.ts runs that repair + retries the push exactly once when the push fails with the duplicate-ref signature (matches more than one) on an s3:// remote, happy path unchanged AND hermetic tests (stubbed S3 client + scratch git repos, no network/daemon) cover keeper selection, stale-skip, size-mismatch no-delete, non-s3 no-op, and signature mismatch no-repair AND npx tsc --noEmit clean AND npx prettier --check src/ clean: Port faithful: parseS3RemoteUrl (s3-repair.ts:55-61) parses s3://bucket/prefix; isRepairableBundleKey (s3-repair.ts:110-119) exactly matches bash awk filter (duckbrain-s3-push.sh:200-211: endsWith .bundle, excludes PROTECTED#/LOCK#/.zip//LOCKS//.lock); keeper=localTip match else newest LastModified (s3-repair.ts:207-236); stale-skip via defaultHasCommit `git cat-file -e <sha>^{commit}` (s3-repair.ts:131-146,244-256); quarantine key `quarantine/git/<ns>/<branch>/<sha>.bundle` (s3-repair.ts:259) matches bash line 279; HeadObject size verify BEFORE delete (s3-repair.ts:275-289); re-list assert (s3-repair.ts:311-325); every step try/catch so never throws. Wiring: autocommit.ts:629 `if (s3 && remote && branch && isDuplicateRefPushError(message))` then parseS3RemoteUrl + repairAndRetryPushOnDuplicate (autocommit.ts:636-660) which retries push exactly once (s3-repair.ts:337-356); happy path sets lastPushedHead at autocommit.ts:617 with zero added S3 calls. Tests: `npx vitest run src/git/s3-repair-ops012.test.ts` → 17 passed (keeper selection lines 193/236/275, stale-skip 297, size-mismatch no-delete 324, non-s3 no-op via parseS3RemoteUrl null 125-130, signature mismatch no-repair via isDuplicateRefPushError negative 155-163, scratch-repo defaultHasCommit 419-441). `npx tsc --noEmit` exit 0 (no output). `npx prettier --check src/` exit 0 ('All matched files use Prettier code style!'). LSP diagnostics: 0. Related autocommit suites: 42 passed across 4 files.
The OPS-012 self-heal is faithfully ported into src/git/s3-repair.ts, wired into pushNamespaceAsync with a single retry on the duplicate-ref signature over s3:// remotes, covered by 17 hermetic passing tests, with tsc and prettier both clean.

## Summary

Judge Result: OPS-012

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v4.1.10 /home/kara/duckbrain

Stage tier2: PASS
  COMPLETE
  ✓ src/git/s3-repair.ts faithfully ports repair_duplicate_bundles from scripts/s3/duckbrain-s3-push.sh (parse s3:// remote URL to bucket+prefix, list <prefix>/refs/heads/<branch>/ *.bundle objects excluding LOCK#/PROTECTED#/.zip//LOCKS//.lock, keeper=local-tip-sha else newest LastModified, skip stale sha absent from local repo via git cat-file -e, quarantine server-side copy to quarantine/git/<ns>/<branch>/<sha>.bundle with HeadObject size verify BEFORE delete, re-list assert, never throws) AND pushNamespaceAsync in src/git/autocommit.ts runs that repair + retries the push exactly once when the push fails with the duplicate-ref signature (matches more than one) on an s3:// remote, happy path unchanged AND hermetic tests (stubbed S3 client + scratch git repos, no network/daemon) cover keeper selection, stale-skip, size-mismatch no-delete, non-s3 no-op, and signature mismatch no-repair AND npx tsc --noEmit clean AND npx prettier --check src/ clean: Port faithful: parseS3RemoteUrl (s3-repair.ts:55-61) parses s3://bucket/prefix; isRepairableBundleKey (s3-repair.ts:110-119) exactly matches bash awk filter (duckbrain-s3-push.sh:200-211: endsWith .bundle, excludes PROTECTED#/LOCK#/.zip//LOCKS//.lock); keeper=localTip match else newest LastModified (s3-repair.ts:207-236); stale-skip via defaultHasCommit `git cat-file -e <sha>^{commit}` (s3-repair.ts:131-146,244-256); quarantine key `quarantine/git/<ns>/<branch>/<sha>.bundle` (s3-repair.ts:259) matches bash line 279; HeadObject size verify BEFORE delete (s3-repair.ts:275-289); re-list assert (s3-repair.ts:311-325); every step try/catch so never throws. Wiring: autocommit.ts:629 `if (s3 && remote && branch && isDuplicateRefPushError(message))` then parseS3RemoteUrl + repairAndRetryPushOnDuplicate (autocommit.ts:636-660) which retries push exactly once (s3-repair.ts:337-356); happy path sets lastPushedHead at autocommit.ts:617 with zero added S3 calls. Tests: `npx vitest run src/git/s3-repair-ops012.test.ts` → 17 passed (keeper selection lines 193/236/275, stale-skip 297, size-mismatch no-delete 324, non-s3 no-op via parseS3RemoteUrl null 125-130, signature mismatch no-repair via isDuplicateRefPushError negative 155-163, scratch-repo defaultHasCommit 419-441). `npx tsc --noEmit` exit 0 (no output). `npx prettier --check src/` exit 0 ('All matched files use Prettier code style!'). LSP diagnostics: 0. Related autocommit suites: 42 passed across 4 files.
The OPS-012 self-heal is faithfully ported into src/git/s3-repair.ts, wired into pushNamespaceAsync with a single retry on the duplicate-ref signature over s3:// remotes, covered by 17 hermetic passing tests, with tsc and prettier both clean.

Overall: PASS ✓
