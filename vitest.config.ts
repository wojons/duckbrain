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
