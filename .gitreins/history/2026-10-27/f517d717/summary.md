# Verdict: README-18

**Task:** Add runnable README docs validation command
**Evaluated:** 2026-10-27T21:44:04.923282
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✗ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10
- ✓ **tier2**
  - COMPLETE
  ✓ Add or document a runnable README/docs validation command covering fenced commands, local links, and key version/prerequisite claims; run it and record its output. Acceptance: package.json has a docs/readme script and README documents it.: All acceptance elements verified with live command output. (1) package.json:30 has `"docs:check": "node scripts/docs-check.js"` (added in commit 05f86e6d 'docs: add `pnpm docs:check` README/docs validator. Addresses README-18.'). (2) README documents it: README.md:516 heading '### Validating the documentation', README.md:518-519 names `pnpm docs:check` and links scripts/docs-check.js, README.md:529 shows the runnable fenced command, README.md:532 documents `--self-test`. (3) Coverage of all three required areas in scripts/docs-check.js: checkFences() validates balanced fenced code blocks across README.md + all docs/**/*.md; checkLinks() resolves local relative links on disk (skipping http:/mailto:/data:/#anchors, supporting extensionless -> .md); checkPrereqs() cross-checks 'Node.js N+' against engines.node and 'pnpm X.Y.Z' against packageManager. (4) RUN + RECORDED OUTPUT, fresh from repo root: `node scripts/docs-check.js` -> exit_code=0, output 'docs-check: OK — README.md + 48 docs/*.md files: fences balanced, local links resolve, Node/pnpm claims match package.json'; `pnpm docs:check` -> '$ node scripts/docs-check.js' then the same OK line, confirming script wiring; `node scripts/docs-check.js --self-test` -> exit_code=0, 'self-test: RED arm flagged 4 defect classes, GREEN arm passed'. (5) Negative control proves it is not a no-op: an injected fixture with a dead link and unclosed fence returned exit_code=1 with 'README.md:5: code fence opened here is never closed' and 'README.md:3: broken local link "docs/nope.md"'. (6) Claims are truthful: README.md:81/498 'Node.js 22+' matches package.json:68 engines.node '>=22'; README.md:89 'pnpm 12.4.2' matches package.json:4 packageManager 'pnpm@12.4.2'. Note: the visible git diff shows only .gitreins/tasks.yaml metadata because the substantive work was committed in 05f86e6d; the files exist on disk and execute correctly. [resolution 0.28; package.json]
package.json:30 defines the docs:check script, README.md:516-532 documents it, and the validator genuinely covers fenced blocks, local links, and Node/pnpm version claims — verified green (exit 0) on the real tree and red (exit 1) on an injected broken fixture.

## Summary

Judge Result: README-18

Stage tier1: FAIL
    ✗ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✓ tests: scanners: nice=nice -n 10

Stage tier2: PASS
  COMPLETE
  ✓ Add or document a runnable README/docs validation command covering fenced commands, local links, and key version/prerequisite claims; run it and record its output. Acceptance: package.json has a docs/readme script and README documents it.: All acceptance elements verified with live command output. (1) package.json:30 has `"docs:check": "node scripts/docs-check.js"` (added in commit 05f86e6d 'docs: add `pnpm docs:check` README/docs validator. Addresses README-18.'). (2) README documents it: README.md:516 heading '### Validating the documentation', README.md:518-519 names `pnpm docs:check` and links scripts/docs-check.js, README.md:529 shows the runnable fenced command, README.md:532 documents `--self-test`. (3) Coverage of all three required areas in scripts/docs-check.js: checkFences() validates balanced fenced code blocks across README.md + all docs/**/*.md; checkLinks() resolves local relative links on disk (skipping http:/mailto:/data:/#anchors, supporting extensionless -> .md); checkPrereqs() cross-checks 'Node.js N+' against engines.node and 'pnpm X.Y.Z' against packageManager. (4) RUN + RECORDED OUTPUT, fresh from repo root: `node scripts/docs-check.js` -> exit_code=0, output 'docs-check: OK — README.md + 48 docs/*.md files: fences balanced, local links resolve, Node/pnpm claims match package.json'; `pnpm docs:check` -> '$ node scripts/docs-check.js' then the same OK line, confirming script wiring; `node scripts/docs-check.js --self-test` -> exit_code=0, 'self-test: RED arm flagged 4 defect classes, GREEN arm passed'. (5) Negative control proves it is not a no-op: an injected fixture with a dead link and unclosed fence returned exit_code=1 with 'README.md:5: code fence opened here is never closed' and 'README.md:3: broken local link "docs/nope.md"'. (6) Claims are truthful: README.md:81/498 'Node.js 22+' matches package.json:68 engines.node '>=22'; README.md:89 'pnpm 12.4.2' matches package.json:4 packageManager 'pnpm@12.4.2'. Note: the visible git diff shows only .gitreins/tasks.yaml metadata because the substantive work was committed in 05f86e6d; the files exist on disk and execute correctly. [resolution 0.28; package.json]
package.json:30 defines the docs:check script, README.md:516-532 documents it, and the validator genuinely covers fenced blocks, local links, and Node/pnpm version claims — verified green (exit 0) on the real tree and red (exit 1) on an injected broken fixture.

Overall: FAIL ✗
