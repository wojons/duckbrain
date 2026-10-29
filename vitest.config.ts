import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test-setup.ts"],
    // Process-spawning and native-DuckDB tests contend heavily when Vitest
    // fans out across every host core. Bound concurrency and allow the slow
    // integration-style unit tests enough wall time under the full suite.
    maxWorkers: 4,
    testTimeout: 15_000,
    // The same native-DuckDB reality applies to the hooks, which do the same
    // init/close work the tests do. The FIRST connection in a worker process
    // installs/loads the vss extension (a ~48 MB download on a cold
    // ~/.duckdb cache) and `db.close()` does not return until that in-flight
    // extension work drains — measured 1.25 s here with a cold extension
    // cache (45 ms warm), and >10 s on the loaded clean-machine QA battery,
    // where the 10 s vitest default reds the first afterEach of
    // src/duckdb/queries.test.ts. Give hooks the same headroom as tests.
    hookTimeout: 30_000,
    root: ".",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/test-setup.ts"],
      reporter: ["text", "html"],
      reportsDirectory: "coverage",
    },
  },
});
