#!/usr/bin/env node
/**
 * Embedding provider preflight wrapper — OPS-004.
 *
 * Loads tsx (same pattern as bin/duckbrain.js and scripts/health-check.js) and
 * runs the typed implementation in src/cli/embedding-preflight.ts.
 *
 * Exit 0 = a real embed succeeded through the configured provider. Exit 1 =
 * FAIL CLOSED: the provider could not be proven usable (auth, timeout, empty
 * vector, wrong dimensions, unreachable, upstream error) — including the
 * OPS-004 asymmetric condition where the reachability route answers HTTP but
 * the embed does not. Exit 2 = usage error.
 *
 * Safe to run anywhere: the API key is read from the environment / config file
 * only (never from argv), never printed, and every provider string in the
 * report is credential-redacted.
 */

require("tsx/cjs");

const { runEmbeddingPreflightCli } = require("../src/cli/embedding-preflight.ts");

runEmbeddingPreflightCli(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(
      `embedding-preflight: unexpected failure: ${error && error.stack ? error.stack : error}`,
    );
    process.exit(1);
  });
