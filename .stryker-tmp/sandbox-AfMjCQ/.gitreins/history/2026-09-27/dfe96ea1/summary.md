# Verdict: AUTH-DEFAULT-001

**Task:** Make the HTTP front door authenticated by default
**Evaluated:** 2026-09-27T20:16:00.635054
**Result:** ✗ FAIL

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v5.0.1 /home/kara/duckbrain
- ✗ **tier2**
  - INCOMPLETE
  ✗ Fresh CLI/package startup rejects unauthenticated API writes while explicit test seams and auth opt-out behavior remain covered; regression tests and docs pass: No implementation exists. `git diff HEAD --name-only` shows ONLY .gitreins/tasks.yaml and .coding-hermes/board/tasks.jsonl changed — zero source/test/doc files. The buggy default is untouched: src/cli/http.ts:403 still reads `...(options.authConfig ?? { type: options.authType ?? "none" })` (the exact line the task's own board entry names as the defect), and package.json:16 `"start:http": "node bin/duckbrain.js http --port 3000"` still passes no --auth flag, so a fresh startup serves unauthenticated writes. Docs were not updated either: README.md:132 still states 'A fresh daemon has no auth (auth is opt-in via `--auth=apikey`), so these commands need no key' — directly contradicting the criterion. No regression test asserting default-rejects-unauthenticated was added; existing src/cli/http-auth.test.ts only exercises explicit authType:"apikey". Ran `npx vitest run src/cli/http-auth.test.ts src/cli/auth-file-enforcement-df092407.test.ts` -> exit_code 0, 'Test Files 2 passed (2), Tests 14 passed (14)', but these validate the OLD opt-in behavior, not the required new default. The task was marked complete in .gitreins/tasks.yaml without any code change.
The task is marked complete but no source, test, or doc changes were made — the open-write default (src/cli/http.ts:403 `authType ?? "none"`, package.json start:http, README.md:132) remains, so fresh startup still accepts unauthenticated writes.

## Summary

Judge Result: AUTH-DEFAULT-001

Stage tier1: PASS
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: RUN  v5.0.1 /home/kara/duckbrain

Stage tier2: FAIL
  INCOMPLETE
  ✗ Fresh CLI/package startup rejects unauthenticated API writes while explicit test seams and auth opt-out behavior remain covered; regression tests and docs pass: No implementation exists. `git diff HEAD --name-only` shows ONLY .gitreins/tasks.yaml and .coding-hermes/board/tasks.jsonl changed — zero source/test/doc files. The buggy default is untouched: src/cli/http.ts:403 still reads `...(options.authConfig ?? { type: options.authType ?? "none" })` (the exact line the task's own board entry names as the defect), and package.json:16 `"start:http": "node bin/duckbrain.js http --port 3000"` still passes no --auth flag, so a fresh startup serves unauthenticated writes. Docs were not updated either: README.md:132 still states 'A fresh daemon has no auth (auth is opt-in via `--auth=apikey`), so these commands need no key' — directly contradicting the criterion. No regression test asserting default-rejects-unauthenticated was added; existing src/cli/http-auth.test.ts only exercises explicit authType:"apikey". Ran `npx vitest run src/cli/http-auth.test.ts src/cli/auth-file-enforcement-df092407.test.ts` -> exit_code 0, 'Test Files 2 passed (2), Tests 14 passed (14)', but these validate the OLD opt-in behavior, not the required new default. The task was marked complete in .gitreins/tasks.yaml without any code change.
The task is marked complete but no source, test, or doc changes were made — the open-write default (src/cli/http.ts:403 `authType ?? "none"`, package.json start:http, README.md:132) remains, so fresh startup still accepts unauthenticated writes.

Overall: FAIL ✗
