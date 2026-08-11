/**
 * DOGFOOD-004 Regression Tests: delete_namespace actually deletes.
 *
 * Regressions guarded:
 *  - delete_namespace removes the namespace DIRECTORY recursively from disk
 *    (current.jsonl, .git, .embeddings — everything), not just the config
 *    mapping. Previously it returned { success: true } while leaving all data
 *    on disk (DOGFOOD-004, verified live 2026-08-07).
 *  - a path-safety guard refuses to delete any path outside the namespaces
 *    root — blocks `../` traversal and malicious mapping values.
 *  - idempotent: deleting a namespace whose dir is already gone still succeeds
 *    and cleans up the stale mapping.
 *  - fs failure does not half-remove: if rmSync throws, the mapping is left
 *    intact and success:false is returned.
 *  - existing guards unchanged: confirm required, "default" blocked, active
 *    namespace blocked, missing namespace → "not found".
 *
 * The namespace storage runs under the test-suite temp root
 * (DUCKBRAIN_NAMESPACES_PATH, set by src/test-setup.ts). The config FILE is
 * likewise redirected to a temp file via DUCKBRAIN_CONFIG_PATH (GAP-022, also
 * set by src/test-setup.ts) — the tools hardcode configDir ".", so without
 * the redirect every updateConfig() write here would race on the TRACKED
 * duckbrain.config.json at the repo root (parallel-write flake observed tick
 * #370). The snapshot/restore below now guards the temp config, never the
 * repo config.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { createNamespaceTool, deleteNamespaceTool } from "./namespace";
import { getConfig, updateConfig } from "../../config/index";

// The config file the tools actually use: the GAP-022 env override when the
// suite set it (src/test-setup.ts), else the repo-root file as fallback.
const CONFIG_PATH =
  process.env.DUCKBRAIN_CONFIG_PATH ||
  path.join(process.cwd(), "duckbrain.config.json");
const NS_ROOT = process.env.DUCKBRAIN_NAMESPACES_PATH!;

let configSnapshot: string;

beforeEach(() => {
  configSnapshot = fs.existsSync(CONFIG_PATH)
    ? fs.readFileSync(CONFIG_PATH, "utf-8")
    : "";
});

afterEach(() => {
  // Restore the (temp) config file so the test never leaks mappings.
  if (configSnapshot) {
    fs.writeFileSync(CONFIG_PATH, configSnapshot, "utf-8");
  } else if (fs.existsSync(CONFIG_PATH)) {
    fs.unlinkSync(CONFIG_PATH);
  }
});

/** Read the live namespaceMappings straight from disk (bypassing caches). */
function liveMappings(): Record<string, string> {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")).namespaceMappings;
}

describe("DOGFOOD-004: delete_namespace removes the directory recursively", () => {
  it("removes the namespace dir + its contents + unregisters the mapping", async () => {
    const name = "dogfood004-recdel";
    const created = await createNamespaceTool({ name, setDefault: false });
    expect(created.success).toBe(true);

    const dirPath = created.path!;
    // Seed files that mimic real namespace contents.
    fs.writeFileSync(path.join(dirPath, "current.jsonl"), '{"k":"v"}\n');
    fs.writeFileSync(path.join(dirPath, "manifest.json"), "{}\n");
    fs.mkdirSync(path.join(dirPath, ".git", "refs"), { recursive: true });
    fs.writeFileSync(
      path.join(dirPath, ".git", "HEAD"),
      "ref: refs/heads/main\n",
    );
    fs.mkdirSync(path.join(dirPath, ".embeddings"), { recursive: true });
    fs.writeFileSync(path.join(dirPath, ".embeddings", "vec.bin"), "x");

    expect(liveMappings()[name]).toBeDefined();

    const result = await deleteNamespaceTool({ name, confirm: true });

    expect(result.success).toBe(true);
    expect(result.path).toBe(path.resolve(dirPath));
    expect(fs.existsSync(dirPath)).toBe(false);
    expect(liveMappings()[name]).toBeUndefined();
  });

  it("removes nested partition files (.embeddings, concept subdirs)", async () => {
    const name = "dogfood004-nested";
    const created = await createNamespaceTool({ name, setDefault: false });
    const dirPath = created.path!;
    fs.mkdirSync(path.join(dirPath, "concept", "2026-08"), { recursive: true });
    fs.writeFileSync(
      path.join(dirPath, "concept", "2026-08", "current.jsonl"),
      '{"k":"v"}\n',
    );
    fs.mkdirSync(path.join(dirPath, ".embeddings"), { recursive: true });

    const result = await deleteNamespaceTool({ name, confirm: true });
    expect(result.success).toBe(true);
    expect(fs.existsSync(dirPath)).toBe(false);
    expect(fs.existsSync(path.join(dirPath, "concept"))).toBe(false);
  });
});

describe("DOGFOOD-004: delete_namespace guard branches (unchanged)", () => {
  it("refuses without confirm", async () => {
    const result = await deleteNamespaceTool({
      name: "whatever",
      confirm: false,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Confirmation required");
  });

  it("blocks deleting the 'default' namespace", async () => {
    // Register 'default' so the guard-after-exists isn't what blocks it.
    // (The temp config — DUCKBRAIN_CONFIG_PATH — starts empty, unlike the
    // old repo-root config which already mapped "default".)
    const name = "default";
    updateConfig(".", {
      namespaceMappings: {
        ...getConfig(".").namespaceMappings,
        [name]: path.join(NS_ROOT, name),
      },
    });
    const result = await deleteNamespaceTool({ name, confirm: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Cannot delete default namespace");
  });

  it("blocks deleting the currently active namespace", async () => {
    const name = "dogfood004-active";
    await createNamespaceTool({ name, setDefault: true });
    const cfg = getConfig(".");
    expect(cfg.defaultNamespace).toBe(name);

    const result = await deleteNamespaceTool({ name, confirm: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Cannot delete currently active namespace");

    // restore default namespace so the snapshot restore isn't fighting it
    updateConfig(".", { defaultNamespace: "default" });
  });

  it("returns 'not found' for a namespace that has no mapping", async () => {
    const result = await deleteNamespaceTool({
      name: "dogfood004-nonexistent",
      confirm: true,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });
});

describe("DOGFOOD-004: path-safety guard", () => {
  it("refuses a mapping whose path resolves OUTSIDE the namespaces root", async () => {
    // Create a target directory OUTSIDE the ns root (but still in a temp area).
    const outsideDir = fs.mkdtempSync(
      path.join(require("os").tmpdir(), "duckbrain-trav-target-"),
    );
    const name = "dogfood004-trav";
    // Register a malicious mapping pointing outside the root.
    updateConfig(".", {
      namespaceMappings: {
        ...getConfig(".").namespaceMappings,
        [name]: outsideDir,
      },
    });

    const result = await deleteNamespaceTool({ name, confirm: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain(
      "Refusing to delete path outside namespaces root",
    );
    // The outside dir must be untouched.
    expect(fs.existsSync(outsideDir)).toBe(true);
    // The mapping must remain (no half-remove).
    expect(liveMappings()[name]).toBeDefined();

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("refuses a mapping with a `../` traversal value", async () => {
    const name = "dogfood004-dotdot";
    const traversing = path.join(NS_ROOT, "..", "should-not-delete");
    updateConfig(".", {
      namespaceMappings: {
        ...getConfig(".").namespaceMappings,
        [name]: traversing,
      },
    });

    const result = await deleteNamespaceTool({ name, confirm: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain(
      "Refusing to delete path outside namespaces root",
    );
  });
});

describe("DOGFOOD-004: idempotency", () => {
  it("deleting twice: second call reports 'not found' (mapping already gone)", async () => {
    const name = "dogfood004-idemp";
    await createNamespaceTool({ name, setDefault: false });

    const first = await deleteNamespaceTool({ name, confirm: true });
    expect(first.success).toBe(true);

    const second = await deleteNamespaceTool({ name, confirm: true });
    expect(second.success).toBe(false);
    expect(second.error).toContain("not found");
  });

  it("succeeds when the mapping exists but the dir is already gone (stale)", async () => {
    const name = "dogfood004-stale";
    // Register a mapping whose dir is inside the root but never created.
    const staleDir = path.join(NS_ROOT, name);
    expect(fs.existsSync(staleDir)).toBe(false);
    updateConfig(".", {
      namespaceMappings: {
        ...getConfig(".").namespaceMappings,
        [name]: staleDir,
      },
    });

    const result = await deleteNamespaceTool({ name, confirm: true });
    expect(result.success).toBe(true);
    expect(liveMappings()[name]).toBeUndefined();
  });
});
