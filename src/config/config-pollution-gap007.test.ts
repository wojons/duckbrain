/**
 * GAP-007 Regression: updateConfig must NOT persist env-overridden fields.
 *
 * Root cause (verified by foreman tick #342): updateConfig() used
 * getConfig() (which applies applyEnvOverrides → DUCKBRAIN_NAMESPACES_PATH)
 * as the merge base, then wrote the env-overridden config verbatim to disk.
 * Any call to updateConfig/setConfig/registerNamespace while the env var was
 * set persisted the test suite's transient /tmp path into the real config.
 *
 * These tests prove the fix: with the env var set, updateConfig leaves the
 * file's namespacesPath unchanged; with it unset, normal updates persist.
 *
 * All tests operate on isolated temp config directories — they never touch the
 * real duckbrain.config.json at the repo root.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { getConfig, updateConfig, registerNamespace } from "./index";

/** Paths and env state we save/restore so the suite never leaks. */
const SAVED_ENV_NS_PATH = process.env.DUCKBRAIN_NAMESPACES_PATH;
const SAVED_ENV_CONFIG_PATH = process.env.DUCKBRAIN_CONFIG_PATH;

let tempConfigDir: string;
let tempNsRoot: string;

/**
 * Write a minimal valid config file with a known namespacesPath, so each test
 * has a deterministic on-disk starting state to assert against.
 */
function writeConfig(
  dir: string,
  overrides: Record<string, unknown> = {},
): void {
  const base = {
    defaultNamespace: "default",
    authorEmail: "test@example.com",
    namespacesPath: "./namespaces",
    namespaceMappings: {},
    ...overrides,
  };
  fs.writeFileSync(
    path.join(dir, "duckbrain.config.json"),
    JSON.stringify(base, null, 2) + "\n",
    "utf-8",
  );
}

/** Read namespacesPath straight from the file (bypasses env overrides). */
function readFileNsPath(dir: string): string {
  return JSON.parse(
    fs.readFileSync(path.join(dir, "duckbrain.config.json"), "utf-8"),
  ).namespacesPath;
}

beforeEach(() => {
  tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "gap007-cfg-"));
  tempNsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gap007-ns-"));
  // These tests exercise explicit configDir dirs — the suite-wide config-file
  // override (GAP-022) must be OFF so getConfigPath() targets the temp dirs.
  delete process.env.DUCKBRAIN_CONFIG_PATH;
});

afterEach(() => {
  fs.rmSync(tempConfigDir, { recursive: true, force: true });
  fs.rmSync(tempNsRoot, { recursive: true, force: true });
  // Restore env exactly as it was before this test file ran.
  if (SAVED_ENV_NS_PATH === undefined) {
    delete process.env.DUCKBRAIN_NAMESPACES_PATH;
  } else {
    process.env.DUCKBRAIN_NAMESPACES_PATH = SAVED_ENV_NS_PATH;
  }
  if (SAVED_ENV_CONFIG_PATH === undefined) {
    delete process.env.DUCKBRAIN_CONFIG_PATH;
  } else {
    process.env.DUCKBRAIN_CONFIG_PATH = SAVED_ENV_CONFIG_PATH;
  }
});

describe("GAP-007: updateConfig with DUCKBRAIN_NAMESPACES_PATH set", () => {
  beforeEach(() => {
    process.env.DUCKBRAIN_NAMESPACES_PATH = tempNsRoot;
    writeConfig(tempConfigDir, { namespacesPath: "./namespaces" });
  });

  it("does NOT persist the env-overridden namespacesPath into the config file", () => {
    updateConfig(tempConfigDir, { defaultNamespace: "warpfs" });

    // The FILE must retain its own "./namespaces" — never the /tmp env value.
    expect(readFileNsPath(tempConfigDir)).toBe("./namespaces");

    // But the runtime config (getConfig) SHOULD reflect the env override.
    expect(getConfig(tempConfigDir).namespacesPath).toBe(tempNsRoot);
  });

  it("still persists the update that was actually requested", () => {
    const result = updateConfig(tempConfigDir, { defaultNamespace: "warpfs" });

    // The returned config carries the update...
    expect(result.defaultNamespace).toBe("warpfs");
    // ...and the file reflects it too.
    const fileConfig = JSON.parse(
      fs.readFileSync(
        path.join(tempConfigDir, "duckbrain.config.json"),
        "utf-8",
      ),
    );
    expect(fileConfig.defaultNamespace).toBe("warpfs");
    expect(fileConfig.namespacesPath).toBe("./namespaces");
  });

  it("registerNamespace does NOT leak the env path either", () => {
    registerNamespace(tempConfigDir, "test-ns", "namespaces/test-ns");

    // The file's namespacesPath must be untouched.
    expect(readFileNsPath(tempConfigDir)).toBe("./namespaces");

    // The mapping must be persisted.
    const fileConfig = JSON.parse(
      fs.readFileSync(
        path.join(tempConfigDir, "duckbrain.config.json"),
        "utf-8",
      ),
    );
    expect(fileConfig.namespaceMappings["test-ns"]).toBe("namespaces/test-ns");
  });

  it("updateConfig is safe when callers pass only the fields they mean to change", () => {
    // This is the contract the production code (switchNamespaceTool,
    // createNamespaceTool, deleteNamespaceTool, setConfig) relies on:
    // pass { field: value } for the field you want changed, and the file's
    // other fields (including namespacesPath) stay at their on-disk values.
    updateConfig(tempConfigDir, { defaultNamespace: "other" });
    expect(readFileNsPath(tempConfigDir)).toBe("./namespaces");

    const fileConfig = JSON.parse(
      fs.readFileSync(
        path.join(tempConfigDir, "duckbrain.config.json"),
        "utf-8",
      ),
    );
    expect(fileConfig.defaultNamespace).toBe("other");
    expect(fileConfig.namespacesPath).toBe("./namespaces");
  });
});

describe("GAP-007: updateConfig with DUCKBRAIN_NAMESPACES_PATH UNSET", () => {
  beforeEach(() => {
    delete process.env.DUCKBRAIN_NAMESPACES_PATH;
    writeConfig(tempConfigDir, { namespacesPath: "./namespaces" });
  });

  it("persists updates normally when no env override is active", () => {
    updateConfig(tempConfigDir, { defaultNamespace: "production-ns" });

    const fileConfig = JSON.parse(
      fs.readFileSync(
        path.join(tempConfigDir, "duckbrain.config.json"),
        "utf-8",
      ),
    );
    expect(fileConfig.defaultNamespace).toBe("production-ns");
    expect(fileConfig.namespacesPath).toBe("./namespaces");
  });

  it("switch_namespace flow persists defaultNamespace (production path)", () => {
    // Simulates switchNamespaceTool: updateConfig(".", { defaultNamespace }).
    writeConfig(tempConfigDir, {
      namespacesPath: "./namespaces",
      namespaceMappings: {
        "new-ns": "namespaces/new-ns",
        default: "namespaces/default",
      },
    });

    const result = updateConfig(tempConfigDir, { defaultNamespace: "new-ns" });

    expect(result.defaultNamespace).toBe("new-ns");

    const fileConfig = JSON.parse(
      fs.readFileSync(
        path.join(tempConfigDir, "duckbrain.config.json"),
        "utf-8",
      ),
    );
    expect(fileConfig.defaultNamespace).toBe("new-ns");
    expect(fileConfig.namespacesPath).toBe("./namespaces");
    // Mappings preserved.
    expect(fileConfig.namespaceMappings["new-ns"]).toBe("namespaces/new-ns");
  });

  it("registerNamespace persists the mapping and leaves namespacesPath unchanged", () => {
    registerNamespace(tempConfigDir, "deployed-ns", "namespaces/deployed-ns");

    const fileConfig = JSON.parse(
      fs.readFileSync(
        path.join(tempConfigDir, "duckbrain.config.json"),
        "utf-8",
      ),
    );
    expect(fileConfig.namespaceMappings["deployed-ns"]).toBe(
      "namespaces/deployed-ns",
    );
    expect(fileConfig.namespacesPath).toBe("./namespaces");
  });
});

describe("GAP-022: updateConfig with DUCKBRAIN_CONFIG_PATH set", () => {
  beforeEach(() => {
    // Seed the override file with a known starting state (the file the
    // suite-wide override points at; a sibling of the explicit temp dir).
    const overridePath = path.join(tempConfigDir, "override.json");
    process.env.DUCKBRAIN_CONFIG_PATH = overridePath;
    fs.writeFileSync(
      overridePath,
      JSON.stringify(
        {
          defaultNamespace: "seed-ns",
          authorEmail: "test@example.com",
          namespacesPath: "./namespaces",
          namespaceMappings: {},
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );
  });

  it("writes ONLY to the override file — the repo config is untouched", () => {
    const repoConfigPath = path.join(process.cwd(), "duckbrain.config.json");
    const repoConfigBefore = fs.readFileSync(repoConfigPath, "utf-8");

    updateConfig(".", { defaultNamespace: "warpfs" });

    // The override file received the write (merged onto its own seed state).
    const overrideFile = JSON.parse(
      fs.readFileSync(path.join(tempConfigDir, "override.json"), "utf-8"),
    );
    expect(overrideFile.defaultNamespace).toBe("warpfs");
    expect(overrideFile.namespacesPath).toBe("./namespaces");

    // The tracked repo config is byte-identical — never read, never written.
    expect(fs.readFileSync(repoConfigPath, "utf-8")).toBe(repoConfigBefore);
  });

  it("never persists the override path value into the config file", () => {
    updateConfig(".", { defaultNamespace: "warpfs" });

    const overridePath = process.env.DUCKBRAIN_CONFIG_PATH!;
    const raw = fs.readFileSync(
      path.join(tempConfigDir, "override.json"),
      "utf-8",
    );

    // The override path is env-only — it must not appear anywhere in the
    // file, and no field may carry it (GAP-007 guard applied to GAP-022).
    expect(raw).not.toContain(overridePath);
    const parsed = JSON.parse(raw);
    expect(Object.values(parsed)).not.toContain(overridePath);
  });
});
