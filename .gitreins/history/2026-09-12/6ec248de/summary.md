# Verdict: OPS-001

**Task:** Harden DuckBrain daemon lifecycle and scoped shutdown
**Evaluated:** 2026-09-12T12:31:17.469326
**Result:** ✗ FAIL

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: [90m7:27AM[0m [32mINF[0m [1mscanned ~7443639 bytes (7.44 MB) in 1.73s[0m
[90m7:27AM[0m [32m
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  117 passed (117)
      Tests  987 passed (987)
  
- ✗ **tier2**
  - INCOMPLETE
  ✗ Restart policy self-recovers after graceful SIGTERM; repo stop path terminates only the intended HTTP instance; scratch-server isolation and dark-port monitoring are documented and tested; full TypeScript, unit, integration, and live systemd verification pass: Most sub-parts pass, but the required 'live systemd verification' fails. PASSING: (a) repo stop path — package.json scripts.stop='node scripts/scoped-stop.js' (no pkill); src/cli/scoped-stop.ts is pidfile-proven, SIGTERM-only, refuses stale/malformed/identity/wrong-port; 43 targeted tests pass (npx vitest run src/cli/scoped-stop.test.ts src/cli/health-check.test.ts -> 43 passed); node scripts/check-no-pattern-kill.js exit 0. (b) scratch isolation documented — docs/guide/deployment.md §'Scratch / judge servers: isolation and cleanup contract (OPS-001)'. (c) dark-port monitoring documented+tested — src/cli/health-check.ts (200/503 alive, else dark) with src/cli/health-check.test.ts. (d) TypeScript: npx tsc --noEmit exit 0. (e) Unit: npx vitest run -> 'Test Files 117 passed (117), Tests 987 passed (987)'. (f) Integration: npx vitest run --config vitest.integration.config.ts tests/ -> 'Test Files 6 passed (6), Tests 44 passed (44)'. FAILING: live systemd verification. The live installed unit ~/.config/systemd/user/duckbrain-http.service (dated Aug 1, 1028 bytes) still contains 'Restart=on-failure' — the exact defect OPS-001 was filed to fix; `systemctl --user show duckbrain-http.service -p Restart` returns 'Restart=on-failure', RestartUSec=5s, NRestarts=0. The hardened ops/systemd/duckbrain-http.service (Restart=always) was never installed. The dark-port watchdog is not live either: `systemctl --user status duckbrain-http-health.timer` and `.service` both return 'Unit ... could not be found', and `systemctl --user list-timers 'duckbrain*'` lists 0 timers. No live restart-policy self-recovery after graceful SIGTERM was demonstrated. The criterion explicitly requires 'live systemd verification pass', which is not satisfied.
Code, docs, TypeScript, unit (987) and integration (44) tests all pass, but the live systemd state still runs Restart=on-failure with no installed dark-port watchdog, so the required live systemd verification fails.

## Summary

Judge Result: OPS-001

Stage tier1: PASS
    ✓ secrets: [90m7:27AM[0m [32mINF[0m [1mscanned ~7443639 bytes (7.44 MB) in 1.73s[0m
[90m7:27AM[0m [32m
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  117 passed (117)
      Tests  987 passed (987)
  

Stage tier2: FAIL
  INCOMPLETE
  ✗ Restart policy self-recovers after graceful SIGTERM; repo stop path terminates only the intended HTTP instance; scratch-server isolation and dark-port monitoring are documented and tested; full TypeScript, unit, integration, and live systemd verification pass: Most sub-parts pass, but the required 'live systemd verification' fails. PASSING: (a) repo stop path — package.json scripts.stop='node scripts/scoped-stop.js' (no pkill); src/cli/scoped-stop.ts is pidfile-proven, SIGTERM-only, refuses stale/malformed/identity/wrong-port; 43 targeted tests pass (npx vitest run src/cli/scoped-stop.test.ts src/cli/health-check.test.ts -> 43 passed); node scripts/check-no-pattern-kill.js exit 0. (b) scratch isolation documented — docs/guide/deployment.md §'Scratch / judge servers: isolation and cleanup contract (OPS-001)'. (c) dark-port monitoring documented+tested — src/cli/health-check.ts (200/503 alive, else dark) with src/cli/health-check.test.ts. (d) TypeScript: npx tsc --noEmit exit 0. (e) Unit: npx vitest run -> 'Test Files 117 passed (117), Tests 987 passed (987)'. (f) Integration: npx vitest run --config vitest.integration.config.ts tests/ -> 'Test Files 6 passed (6), Tests 44 passed (44)'. FAILING: live systemd verification. The live installed unit ~/.config/systemd/user/duckbrain-http.service (dated Aug 1, 1028 bytes) still contains 'Restart=on-failure' — the exact defect OPS-001 was filed to fix; `systemctl --user show duckbrain-http.service -p Restart` returns 'Restart=on-failure', RestartUSec=5s, NRestarts=0. The hardened ops/systemd/duckbrain-http.service (Restart=always) was never installed. The dark-port watchdog is not live either: `systemctl --user status duckbrain-http-health.timer` and `.service` both return 'Unit ... could not be found', and `systemctl --user list-timers 'duckbrain*'` lists 0 timers. No live restart-policy self-recovery after graceful SIGTERM was demonstrated. The criterion explicitly requires 'live systemd verification pass', which is not satisfied.
Code, docs, TypeScript, unit (987) and integration (44) tests all pass, but the live systemd state still runs Restart=on-failure with no installed dark-port watchdog, so the required live systemd verification fails.

Overall: FAIL ✗
