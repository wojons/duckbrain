import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/cli-bin-e2e-df012.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
