import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

/**
 * Vitest config for the DuckBrain web UI.
 *
 * Deliberately self-contained: the UI package is tested as a browser-ish app
 * in jsdom with mocked fetch, so it never touches DuckDB, git or the HTTP
 * server (the root config / integration config cover those).
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    // `tsc` (the `build` script) emits compiled .js twins next to the .tsx
    // sources in src/ (they are gitignored). Vite's default extension order
    // prefers .js, which would make tests exercise stale build output instead
    // of the TypeScript source — put .tsx/.ts first.
    extensions: [".tsx", ".ts", ".jsx", ".js", ".mjs", ".json"],
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
    testTimeout: 15000,
  },
});
