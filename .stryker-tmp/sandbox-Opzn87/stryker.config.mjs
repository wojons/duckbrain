// @ts-nocheck
// 
/**
 * Stryker mutation testing configuration for DuckBrain.
 *
 * NOTE: Stryker 10.x is currently incompatible with TypeScript 7.x
 * (ts.parseConfigFileTextToJson is not a function). This config is
 * a working template — re-enable once TS 7 compatibility lands
 * in stryker-mutator/core, or downgrade TS.
 *
 * While disabled, the "Red-proof gate" test suite (src/test/red-proof-gate.test.ts)
 * serves as the mutation-catch verification: it proves our tests would
 * FAIL against broken code by monkey-patching production functions and
 * asserting the test logic produces the wrong result under mutation.
 */
export default {
  packageManager: "pnpm",
  reporters: ["clear-text", "html"],
  testRunner: "vitest",
  coverageAnalysis: "perTest",
  mutate: [
    "src/**/*.ts",
    "!src/**/*.test.ts",
    "!src/test-setup.ts",
    "!src/**/*.d.ts",
  ],
  thresholds: { high: 80, low: 60, break: 60 },
  concurrency: 2,
  ignoreStatic: true,
};
