import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 60000,
    hookTimeout: 120000,
    include: ["tests/**/*.int.test.ts"],
    // TESTQ-2026-10-29-1: the bin CLI E2E (tests/cli-bin-e2e-df012.test.ts) is
    // intentionally NOT in this include — it spawns bin/duckbrain.js as a
    // subprocess and owns vitest.cli-e2e.config.ts plus its own ci.yml step.
    // This config is therefore not a valid target for that step: its include
    // cannot match a plain .test.ts path (GitHub run 40857806554). Do not add
    // the file here to "reuse" the integration suite — see the config's header.
    pool: "forks",
    fileParallelism: false,
    // CI-GITID-028: CI runners carry no global git identity, so any
    // integration test that writes a memory (autocommit path) hits the
    // GIT-IDENTITY-001 loud error. Seed the documented env override knobs —
    // the same mechanism production documents for headless hosts.
    env: {
      DUCKBRAIN_GIT_AUTHOR_NAME: "DuckBrain Test",
      DUCKBRAIN_GIT_AUTHOR_EMAIL: "duckbrain-test@example.com",
    },
    // INT-CI-003: one throwaway daemon spawn before any file runs, so the
    // per-file cold spawns (tsx transpile + node-duckdb native load) start
    // from a warm page/transform cache instead of racing the 60s cap on a
    // loaded CI runner. See tests/global-setup.integration.ts.
    globalSetup: ["tests/global-setup.integration.ts"],
  },
});
