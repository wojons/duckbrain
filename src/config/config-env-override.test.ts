/**
 * BUG-037 regression test: DUCKBRAIN_NAMESPACES_PATH env override.
 * GAP-022 regression test: DUCKBRAIN_CONFIG_PATH env override.
 *
 * The test suite runs with DUCKBRAIN_NAMESPACES_PATH pointing at an isolated
 * temp dir and DUCKBRAIN_CONFIG_PATH pointing at a temp config file (see
 * src/test-setup.ts). These tests verify getConfig() honors both overrides —
 * and that with the overrides unset, the on-disk config is used instead
 * (production behavior unchanged).
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { getConfig, updateConfig } from "./index";

const ORIGINAL_NS_PATH = process.env.DUCKBRAIN_NAMESPACES_PATH;
const ORIGINAL_CONFIG_PATH = process.env.DUCKBRAIN_CONFIG_PATH;

afterEach(() => {
  if (ORIGINAL_NS_PATH === undefined) {
    delete process.env.DUCKBRAIN_NAMESPACES_PATH;
  } else {
    process.env.DUCKBRAIN_NAMESPACES_PATH = ORIGINAL_NS_PATH;
  }
  if (ORIGINAL_CONFIG_PATH === undefined) {
    delete process.env.DUCKBRAIN_CONFIG_PATH;
  } else {
    process.env.DUCKBRAIN_CONFIG_PATH = ORIGINAL_CONFIG_PATH;
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
    // The on-disk config (suite temp config or repo root) has
    // namespacesPath "./namespaces".
    expect(config.namespacesPath).toBe("./namespaces");
  });
});

describe("GAP-022: DUCKBRAIN_CONFIG_PATH env override", () => {
  it("redirects reads AND writes to the override file", () => {
    const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "gap022-cfg-"));
    const cfgFile = path.join(cfgDir, "custom.json");
    try {
      fs.writeFileSync(
        cfgFile,
        JSON.stringify(
          {
            defaultNamespace: "seed-ns",
            authorEmail: "seed@example.com",
          },
          null,
          2,
        ) + "\n",
        "utf-8",
      );
      process.env.DUCKBRAIN_CONFIG_PATH = cfgFile;

      // Reads land on the override file, regardless of configDir.
      expect(getConfig(".").defaultNamespace).toBe("seed-ns");

      // Writes land on the override file too.
      updateConfig(".", { defaultNamespace: "updated-ns" });
      const raw = JSON.parse(fs.readFileSync(cfgFile, "utf-8"));
      expect(raw.defaultNamespace).toBe("updated-ns");
      // The seed's own namespacesPath survived the merge.
      expect(raw.namespacesPath).toBe("./namespaces");
    } finally {
      fs.rmSync(cfgDir, { recursive: true, force: true });
    }
  });

  it("falls back to configDir/duckbrain.config.json when the override is unset", () => {
    delete process.env.DUCKBRAIN_CONFIG_PATH;
    // Also unset the namespace override so the read is purely file-driven.
    delete process.env.DUCKBRAIN_NAMESPACES_PATH;
    const config = getConfig(".");
    // The tracked repo config has namespacesPath "./namespaces" and a
    // defaultNamespace that is not the schema default.
    expect(config.namespacesPath).toBe("./namespaces");
    expect(config.defaultNamespace).not.toBe("default");
  });
});
