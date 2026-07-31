/**
 * BUG-037 regression test: DUCKBRAIN_NAMESPACES_PATH env override.
 *
 * The test suite runs with DUCKBRAIN_NAMESPACES_PATH pointing at an isolated
 * temp dir (see src/test-setup.ts). This test verifies getConfig() honors the
 * override — and that with the override unset, the file config's
 * namespacesPath is used instead (production behavior unchanged).
 */
import { describe, it, expect, afterEach } from "vitest";
import { getConfig } from "./index";

const ORIGINAL = process.env.DUCKBRAIN_NAMESPACES_PATH;

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env.DUCKBRAIN_NAMESPACES_PATH;
  } else {
    process.env.DUCKBRAIN_NAMESPACES_PATH = ORIGINAL;
  }
});

describe("BUG-037: DUCKBRAIN_NAMESPACES_PATH env override", () => {
  it("uses the env override when set", () => {
    process.env.DUCKBRAIN_NAMESPACES_PATH = "/tmp/duckbrain-isolated-ns";
    const config = getConfig(".");
    expect(config.namespacesPath).toBe("/tmp/duckbrain-isolated-ns");
  });

  it("falls back to file config when env override is unset", () => {
    delete process.env.DUCKBRAIN_NAMESPACES_PATH;
    const config = getConfig(".");
    // duckbrain.config.json in the repo root has namespacesPath "./namespaces"
    expect(config.namespacesPath).toBe("./namespaces");
  });
});
