#!/usr/bin/env node
/**
 * Dark-port health check wrapper — OPS-001.
 *
 * Loads tsx (same pattern as bin/duckbrain.js) and runs the typed
 * implementation in src/cli/health-check.ts. Exit 0 = alive (HTTP 200 or
 * 503 — degraded is intentional), exit 1 = dark (connection failure or any
 * other status), exit 2 = usage error. No API keys needed or accepted —
 * /health is auth-exempt.
 */

require("tsx/cjs");

const { runHealthCheckCli } = require("../src/cli/health-check.ts");

runHealthCheckCli(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(
      `health-check: unexpected failure: ${error && error.stack ? error.stack : error}`,
    );
    process.exit(1);
  });
