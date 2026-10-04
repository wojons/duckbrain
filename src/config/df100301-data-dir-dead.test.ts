/**
 * DF-1003-01: DUCKBRAIN_DATA_DIR is DEAD for namespace storage — the config
 * resolver never reads it. Live-verified 2026-10-03 at HEAD f463832: a daemon
 * started with DUCKBRAIN_DATA_DIR=<scratch> still created namespaces under
 * <repo>/namespaces, while the docs taught the variable as the isolation knob.
 *
 * The supported isolation knobs are:
 *   - DUCKBRAIN_NAMESPACES_PATH (BUG-037): runtime-only namespaces-dir override.
 *   - DUCKBRAIN_HOME_ROOT (GAP-062): explicit install-root override.
 *
 * These tests pin the DEAD variable's status so it can never silently come
 * back to life (and so the docs that now teach the supported knobs stay
 * honest): with DUCKBRAIN_DATA_DIR set to an unrelated scratch directory,
 * root resolution and namespaces-path resolution must ignore it entirely, and
 * DUCKBRAIN_NAMESPACES_PATH must win when set.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  CONFIG_FILENAME,
  resolveDuckbrainRoot,
  resolveNamespacesPath,
} from "./index";

let tmpDir: string;
let scratchDataDir: string;

/**
 * Build a minimal duckbrain install at `dir` (same shape as the GAP-062
 * fixture): package.json, src/config/ and the instance config file.
 */
function makeDuckbrainRoot(dir: string): string {
  fs.mkdirSync(path.join(dir, "src", "config"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "duckbrain" }, null, 2) + "\n",
  );
  fs.writeFileSync(
    path.join(dir, CONFIG_FILENAME),
    JSON.stringify({ namespacesPath: "./namespaces" }, null, 2) + "\n",
  );
  return dir;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "df100301-data-dir-"));
  // The trap: DUCKBRAIN_DATA_DIR points somewhere unrelated to the install.
  scratchDataDir = path.join(tmpDir, "scratch-data");
  fs.mkdirSync(scratchDataDir, { recursive: true });
  process.env.DUCKBRAIN_DATA_DIR = scratchDataDir;
});

afterEach(() => {
  delete process.env.DUCKBRAIN_DATA_DIR;
  delete process.env.DUCKBRAIN_NAMESPACES_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("DF-1003-01: DUCKBRAIN_DATA_DIR is dead for namespace storage", () => {
  it("resolveDuckbrainRoot ignores DUCKBRAIN_DATA_DIR entirely", () => {
    const root = makeDuckbrainRoot(path.join(tmpDir, "db-root"));

    expect(
      resolveDuckbrainRoot({
        // Deliberately do NOT set DUCKBRAIN_CONFIG_PATH / DUCKBRAIN_HOME_ROOT:
        // resolution must fall through to the module walk, not to the data dir.
        env: { DUCKBRAIN_DATA_DIR: scratchDataDir },
        moduleDir: path.join(root, "src", "config"),
        entryPath: null,
        cwd: tmpDir,
      }),
    ).toBe(root);
    expect(
      resolveDuckbrainRoot({
        env: { DUCKBRAIN_DATA_DIR: scratchDataDir },
        moduleDir: path.join(root, "src", "config"),
        entryPath: null,
        cwd: tmpDir,
      }),
    ).not.toBe(scratchDataDir);
  });

  it("resolveNamespacesPath ignores DUCKBRAIN_DATA_DIR and resolves against the root", () => {
    const root = makeDuckbrainRoot(path.join(tmpDir, "db-root"));

    expect(resolveNamespacesPath(root)).toBe(path.join(root, "namespaces"));
    expect(resolveNamespacesPath(root)).not.toBe(
      path.join(scratchDataDir, "namespaces"),
    );
  });

  it("DUCKBRAIN_NAMESPACES_PATH wins over everything, including a set DUCKBRAIN_DATA_DIR", () => {
    const nsOverride = path.join(tmpDir, "declared-namespaces");

    process.env.DUCKBRAIN_NAMESPACES_PATH = nsOverride;
    expect(resolveNamespacesPath()).toBe(nsOverride);
  });

  it("a DUCKBRAIN_DATA_DIR value can never become the namespaces root via the resolver", () => {
    // Root resolution with only the data dir present (no config, no package
    // root reachable from the given inputs) must fail LOUDLY, not fall back
    // to DUCKBRAIN_DATA_DIR.
    const emptyModuleDir = path.join(tmpDir, "no-config", "src", "config");
    fs.mkdirSync(emptyModuleDir, { recursive: true });

    expect(() =>
      resolveDuckbrainRoot({
        env: { DUCKBRAIN_DATA_DIR: scratchDataDir },
        moduleDir: emptyModuleDir,
        entryPath: null,
        cwd: path.join(tmpDir, "elsewhere"),
      }),
    ).toThrow(/duckbrain root/);
  });
});
