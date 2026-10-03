# Verdict: HTTP-HELP-001

**Task:** duckbrain http --help prints options, exits 0
**Evaluated:** 2026-09-29T15:17:06.046257
**Result:** ✗ FAIL

## Pipeline Stages

- ✗ **tier1**
  -   ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: RUN  v5.0.1 /home/kara/duckbrain
- ✓ **tier2**
  - COMPLETE
  ✓ http --help prints the HTTP option list and exits 0 without binding a port: Live CLI run: `node bin/duckbrain.js http --help` printed the full options block (Usage: duckbrain http [options]; --port, --bind-all, --auth, --auth-file, --rate-limit, --unix-socket, --unix-socket-mode, --unix-socket-group, --help/-h) and returned EXIT_CODE=0; `-h` also exits 0. No-bind proof: port 3000 was already LISTENing (pid 294709) before and after the run, yet no EADDRINUSE occurred and stderr carried no 'HTTP server started'/'PID written' banner (startHttpMode prints those only after a successful bind). Implementation: src/cli/http.ts handleHttpCommand() short-circuits on args.includes('--help')||args.includes('-h') -> printHttpHelp() -> return {helped:true} before any flag parsing/start(); bin/duckbrain.ts case 'http' delegates to handleHttpCommand and process.exit(0) when helped. Tests: `npx vitest run src/cli/http-help-httphelp001.test.ts src/cli/http-help-e2e-httphelp001.test.ts` => 2 files passed, 9 tests passed; regression suites http.test.ts/http-auth.test.ts/cli-executable.test.ts => 3 files, 21 tests passed.
`duckbrain http --help` prints the HTTP option list and exits 0 without binding a port, confirmed by live CLI run (exit 0, no bind banner, port 3000 already occupied) and 9/9 dedicated tests passing.

## Summary

Judge Result: HTTP-HELP-001

Stage tier1: FAIL
    ✓ secrets: secrets: harness state excluded from gitleaks scope (.gitreins/**)
  ✗ tests: RUN  v5.0.1 /home/kara/duckbrain

Stage tier2: PASS
  COMPLETE
  ✓ http --help prints the HTTP option list and exits 0 without binding a port: Live CLI run: `node bin/duckbrain.js http --help` printed the full options block (Usage: duckbrain http [options]; --port, --bind-all, --auth, --auth-file, --rate-limit, --unix-socket, --unix-socket-mode, --unix-socket-group, --help/-h) and returned EXIT_CODE=0; `-h` also exits 0. No-bind proof: port 3000 was already LISTENing (pid 294709) before and after the run, yet no EADDRINUSE occurred and stderr carried no 'HTTP server started'/'PID written' banner (startHttpMode prints those only after a successful bind). Implementation: src/cli/http.ts handleHttpCommand() short-circuits on args.includes('--help')||args.includes('-h') -> printHttpHelp() -> return {helped:true} before any flag parsing/start(); bin/duckbrain.ts case 'http' delegates to handleHttpCommand and process.exit(0) when helped. Tests: `npx vitest run src/cli/http-help-httphelp001.test.ts src/cli/http-help-e2e-httphelp001.test.ts` => 2 files passed, 9 tests passed; regression suites http.test.ts/http-auth.test.ts/cli-executable.test.ts => 3 files, 21 tests passed.
`duckbrain http --help` prints the HTTP option list and exits 0 without binding a port, confirmed by live CLI run (exit 0, no bind banner, port 3000 already occupied) and 9/9 dedicated tests passing.

Overall: FAIL ✗
