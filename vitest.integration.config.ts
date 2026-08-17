import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 60000,
    hookTimeout: 120000,
    include: ["tests/**/*.int.test.ts"],
    pool: "forks",
    fileParallelism: false,
    // INT-CI-003: one throwaway daemon spawn before any file runs, so the
    // per-file cold spawns (tsx transpile + node-duckdb native load) start
    // from a warm page/transform cache instead of racing the 60s cap on a
    // loaded CI runner. See tests/global-setup.integration.ts.
    globalSetup: ["tests/global-setup.integration.ts"],
  },
});
