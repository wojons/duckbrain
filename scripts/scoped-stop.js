#!/usr/bin/env node
/**
 * Scoped stop wrapper (`pnpm stop`) — OPS-001.
 *
 * Loads tsx (same pattern as bin/duckbrain.js) and runs the typed
 * implementation in src/cli/scoped-stop.ts, which signals ONLY the pid
 * proven by the selected port's pidfile to be a live DuckBrain HTTP daemon
 * for that port. It never uses pkill/killall or pattern matching, and never
 * touches Vite/UI processes.
 */

require("tsx/cjs");

const { runScopedStopCli } = require("../src/cli/scoped-stop.ts");

runScopedStopCli(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(
      `scoped-stop: unexpected failure: ${error && error.stack ? error.stack : error}`,
    );
    process.exit(1);
  });
