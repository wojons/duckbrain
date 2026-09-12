# Verdict: OPS-001

**Task:** Harden DuckBrain daemon lifecycle and scoped shutdown
**Evaluated:** 2026-09-12T12:37:01.552624
**Result:** ✓ PASS

## Pipeline Stages

- ✓ **tier1**
  -   ✓ secrets: [90m7:32AM[0m [32mINF[0m [1mscanned ~7453756 bytes (7.45 MB) in 1.38s[0m
[90m7:32AM[0m [32m
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  117 passed (117)
      Tests  987 passed (987)
  
- ✓ **tier2**
  - COMPLETE
  ✓ Restart policy self-recovers after graceful SIGTERM; repo stop path terminates only the intended HTTP instance; scratch-server isolation and dark-port monitoring are documented and tested; full TypeScript, unit, integration, and live systemd verification pass: All sub-parts verified with live evidence. (1) Restart self-recovery: sent SIGTERM to live MainPID 3894280 -> NRestarts 1->2, new MainPID 3953919, ActiveState=active, curl /health HTTP 200; drop-in ~/.config/systemd/user/duckbrain-http.service.d/10-restart-always.conf sets Restart=always (overrides base on-failure), and ops/systemd/duckbrain-http.service ships Restart=always + RestartSec=3 + StartLimitBurst=10 + TimeoutStopSec=30. (2) Scoped stop: package.json scripts.stop='node scripts/scoped-stop.js' (no pkill); LIVE started scratch :4777 (pidfile /tmp/ops001test/duckbrain-http-4777.pid), `node scripts/scoped-stop.js --port=4777 --json` -> {"status":"stopped","pid":3979200} exit 0, pidfile removed, while prod :3000 MainPID stayed alive and /health 200; src/cli/scoped-stop.ts is pidfile-proven, SIGTERM-only, refuses stale/malformed/identity/wrong-port; `node scripts/check-no-pattern-kill.js` exit 0. (3) Docs: docs/guide/deployment.md sections 'Hardened Lifecycle Assets (OPS-001)' and 'Scratch / judge servers: isolation and cleanup contract (OPS-001)'; docs/dogfood/diagnostics.md §7 per-instance pidfile + scratch cleanup. (4) Dark-port monitoring tested: src/cli/health-check.ts (200/503 alive, else dark) + src/cli/health-check.test.ts; LIVE health-check.js :3000 -> alive exit 0, dead port -> dark exit 1; systemd duckbrain-http-health.timer active (waiting) and .service ran status=0/SUCCESS. (5) TypeScript: `npx tsc --noEmit` exit 0. (6) Unit: `npx vitest run` -> 'Test Files 117 passed (117), Tests 987 passed (987)'. (7) Integration: `npx vitest run --config vitest.integration.config.ts tests/` -> 'Test Files 6 passed (6), Tests 44 passed (44)'. (8) Targeted new tests: `npx vitest run src/cli/scoped-stop.test.ts src/cli/health-check.test.ts` -> 43 passed. (9) Live systemd: unit installed with Restart=always, health timer/service installed and active, graceful-SIGTERM self-recovery demonstrated.
All OPS-001 sub-parts pass: live systemd restart self-recovery after graceful SIGTERM, pidfile-scoped stop that leaves prod untouched, documented+tested scratch isolation and dark-port monitoring, and green TypeScript (exit 0), unit (987), and integration (44) suites.

## Summary

Judge Result: OPS-001

Stage tier1: PASS
    ✓ secrets: [90m7:32AM[0m [32mINF[0m [1mscanned ~7453756 bytes (7.45 MB) in 1.38s[0m
[90m7:32AM[0m [32m
  ✓ tests: 
 RUN  v4.1.10 /home/kara/duckbrain


 Test Files  117 passed (117)
      Tests  987 passed (987)
  

Stage tier2: PASS
  COMPLETE
  ✓ Restart policy self-recovers after graceful SIGTERM; repo stop path terminates only the intended HTTP instance; scratch-server isolation and dark-port monitoring are documented and tested; full TypeScript, unit, integration, and live systemd verification pass: All sub-parts verified with live evidence. (1) Restart self-recovery: sent SIGTERM to live MainPID 3894280 -> NRestarts 1->2, new MainPID 3953919, ActiveState=active, curl /health HTTP 200; drop-in ~/.config/systemd/user/duckbrain-http.service.d/10-restart-always.conf sets Restart=always (overrides base on-failure), and ops/systemd/duckbrain-http.service ships Restart=always + RestartSec=3 + StartLimitBurst=10 + TimeoutStopSec=30. (2) Scoped stop: package.json scripts.stop='node scripts/scoped-stop.js' (no pkill); LIVE started scratch :4777 (pidfile /tmp/ops001test/duckbrain-http-4777.pid), `node scripts/scoped-stop.js --port=4777 --json` -> {"status":"stopped","pid":3979200} exit 0, pidfile removed, while prod :3000 MainPID stayed alive and /health 200; src/cli/scoped-stop.ts is pidfile-proven, SIGTERM-only, refuses stale/malformed/identity/wrong-port; `node scripts/check-no-pattern-kill.js` exit 0. (3) Docs: docs/guide/deployment.md sections 'Hardened Lifecycle Assets (OPS-001)' and 'Scratch / judge servers: isolation and cleanup contract (OPS-001)'; docs/dogfood/diagnostics.md §7 per-instance pidfile + scratch cleanup. (4) Dark-port monitoring tested: src/cli/health-check.ts (200/503 alive, else dark) + src/cli/health-check.test.ts; LIVE health-check.js :3000 -> alive exit 0, dead port -> dark exit 1; systemd duckbrain-http-health.timer active (waiting) and .service ran status=0/SUCCESS. (5) TypeScript: `npx tsc --noEmit` exit 0. (6) Unit: `npx vitest run` -> 'Test Files 117 passed (117), Tests 987 passed (987)'. (7) Integration: `npx vitest run --config vitest.integration.config.ts tests/` -> 'Test Files 6 passed (6), Tests 44 passed (44)'. (8) Targeted new tests: `npx vitest run src/cli/scoped-stop.test.ts src/cli/health-check.test.ts` -> 43 passed. (9) Live systemd: unit installed with Restart=always, health timer/service installed and active, graceful-SIGTERM self-recovery demonstrated.
All OPS-001 sub-parts pass: live systemd restart self-recovery after graceful SIGTERM, pidfile-scoped stop that leaves prod untouched, documented+tested scratch isolation and dark-port monitoring, and green TypeScript (exit 0), unit (987), and integration (44) suites.

Overall: PASS ✓
