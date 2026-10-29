import { defineConfig } from "vitest/config";

/**
 * TESTQ-2026-10-29-1: the bin CLI E2E gets its OWN config, and this file is
 * the only config the ci.yml "Run bin CLI E2E" step may name.
 *
 * History: the step originally pointed at vitest.integration.config.ts (whose
 * include list holds only the .int.test.ts pattern) and then at
 * vitest.config.ts (whose include covers src only). Neither can discover
 * tests/cli-bin-e2e-df012.test.ts, so Vitest answered "No test files found,
 * exiting with code 1" after setup, lint, tsc and the CLI build had passed
 * (GitHub runs 40857806554 / 40856208413).
 *
 * Isolation is deliberate rather than an include entry: this suite spawns the
 * published bin/duckbrain.js as a subprocess, so folding it into the
 * integration suite would couple a shipped-entry-point check to that suite's
 * daemon globalSetup, its serialized 60s file budget and its -t filtering.
 * `scripts/ci/check-cli-e2e-config.js` proves this config still collects the
 * file, and `pnpm test:cli-e2e` is the local entry point.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/cli-bin-e2e-df012.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
