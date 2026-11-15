#!/usr/bin/env node
/** Capture crash evidence for the systemd HTTP unit. */

require("tsx/cjs");

const { runCrashAttributionCli } = require("../src/ops/crash-attribution.ts");

runCrashAttributionCli(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(
      `crash-attribution: unexpected failure: ${error && error.stack ? error.stack : error}`,
    );
    // ExecStopPost is prefixed with '-' in the unit, but keep the wrapper
    // conventional when invoked directly.
    process.exit(1);
  });
