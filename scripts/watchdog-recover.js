#!/usr/bin/env node
/**
 * Dark-port watchdog recovery wrapper — GAP-059.
 *
 * Loads tsx (same pattern as scripts/health-check.js) and runs the typed
 * implementation in src/cli/watchdog-recover.ts. Probes /health once; on DARK
 * it counts consecutive dark probes and, once the count reaches
 * --confirm-probes, runs `systemctl --user start <unit>` (anti-storm cooldown
 * via --cooldown-s, attempt timestamped in the state file).
 *
 * Exit 0 = healthy, recovered, or deliberately no-op (ALIVE cleared the
 * counter; HUNG is not a dead daemon — OPS-002). Exit 1 = dark and still not
 * alive after the restart attempt (or systemctl failed) so `systemctl status`
 * shows the failure. Exit 2 = usage error. No API keys needed or accepted —
 * /health is auth-exempt.
 */

require("tsx/cjs");

const { runWatchdogRecoverCli } = require("../src/cli/watchdog-recover.ts");

runWatchdogRecoverCli(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(
      `watchdog-recover: unexpected failure: ${error && error.stack ? error.stack : error}`,
    );
    process.exit(1);
  });
