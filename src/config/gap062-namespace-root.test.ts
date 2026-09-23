/**
 * GAP-062: the namespace storage root is resolved from the duckbrain ROOT —
 * the directory that owns `duckbrain.config.json` — and never from the
 * caller's cwd.
 *
 * Incident: a duckbrain CLI write invoked from an unrelated product checkout
 * (get-h3/sdk-typescript, 2026-09-19/20) created `./namespaces/qa` INSIDE that
 * checkout because `namespacesPath` ("./namespaces") was resolved against
 * `process.cwd()`. These tests pin the resolution rules that replaced it:
 * config-file override > install-root override > module walk > entry walk >
 * cwd walk > install root, and a loud failure when nothing determines a root.
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

/**
 * Build a minimal duckbrain install at `dir`: a `package.json` naming the
 * package, a `src/config/` directory (the module location the resolver is
 * handed) and — unless `withConfig` is false — the instance config file.
 */
function makeDuckbrainRoot(
  dir: string,
  opts: { withConfig?: boolean; namespacesPath?: string } = {},
): string {
  const { withConfig = true, namespacesPath = "./namespaces" } = opts;
  fs.mkdirSync(path.join(dir, "src", "config"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "duckbrain" }, null, 2) + "\n",
  );
  if (withConfig) {
    fs.writeFileSync(
      path.join(dir, CONFIG_FILENAME),
      JSON.stringify({ namespacesPath }, null, 2) + "\n",
    );
  }
  return dir;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gap062-root-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("GAP-062: duckbrain root resolution", () => {
  it("resolves the root from the module's own location, not the caller's cwd", () => {
    const root = makeDuckbrainRoot(path.join(tmpDir, "db-root"));
    const foreignCwd = path.join(tmpDir, "foreign-checkout");
    fs.mkdirSync(foreignCwd, { recursive: true });

    expect(
      resolveDuckbrainRoot({
        env: {},
        moduleDir: path.join(root, "src", "config"),
        entryPath: path.join(foreignCwd, "node_modules", ".bin", "duckbrain"),
        cwd: foreignCwd,
      }),
    ).toBe(root);
  });

  it("prefers the module's own root over a config file sitting in the cwd", () => {
    const root = makeDuckbrainRoot(path.join(tmpDir, "db-root"));
    const foreignCwd = path.join(tmpDir, "foreign-checkout");
    fs.mkdirSync(foreignCwd, { recursive: true });
    // A stray config in the cwd must not hijack an installed duckbrain.
    fs.writeFileSync(
      path.join(foreignCwd, CONFIG_FILENAME),
      JSON.stringify({ namespacesPath: "./namespaces" }, null, 2) + "\n",
    );

    expect(
      resolveDuckbrainRoot({
        env: {},
        moduleDir: path.join(root, "src", "config"),
        entryPath: null,
        cwd: foreignCwd,
      }),
    ).toBe(root);
  });

  it("honors DUCKBRAIN_CONFIG_PATH: the redirected config file owns its directory", () => {
    const root = makeDuckbrainRoot(path.join(tmpDir, "db-root"));
    const otherCfgDir = path.join(tmpDir, "scratch-cfg");
    fs.mkdirSync(otherCfgDir, { recursive: true });

    expect(
      resolveDuckbrainRoot({
        env: {
          DUCKBRAIN_CONFIG_PATH: path.join(otherCfgDir, CONFIG_FILENAME),
        },
        moduleDir: path.join(root, "src", "config"),
        entryPath: null,
        cwd: tmpDir,
      }),
    ).toBe(otherCfgDir);
  });

  it("honors DUCKBRAIN_HOME_ROOT as an explicit install-root override", () => {
    const root = makeDuckbrainRoot(path.join(tmpDir, "db-root"));
    const homeRoot = path.join(tmpDir, "declared-root");

    expect(
      resolveDuckbrainRoot({
        env: { DUCKBRAIN_HOME_ROOT: homeRoot },
        moduleDir: path.join(root, "src", "config"),
        entryPath: null,
        cwd: tmpDir,
      }),
    ).toBe(homeRoot);
  });

  it("uses a cwd-ancestor config only when neither the module nor the entry has one", () => {
    // A globally installed package (no instance config of its own) invoked
    // from a project that carries its own duckbrain.config.json: the project
    // owns its namespaces.
    const install = makeDuckbrainRoot(path.join(tmpDir, "global-install"), {
      withConfig: false,
    });
    const project = makeDuckbrainRoot(path.join(tmpDir, "project"));
    const projectSub = path.join(project, "packages", "app");
    fs.mkdirSync(projectSub, { recursive: true });

    expect(
      resolveDuckbrainRoot({
        env: {},
        moduleDir: path.join(install, "src", "config"),
        entryPath: path.join(install, "bin", "duckbrain.js"),
        cwd: projectSub,
      }),
    ).toBe(project);
  });

  it("falls back to the INSTALL root — never the cwd — when no config file exists anywhere", () => {
    // A fresh clone: the instance config is untracked by design, so a
    // namespacesPath of "./namespaces" must still resolve against the install.
    const install = makeDuckbrainRoot(path.join(tmpDir, "fresh-clone"), {
      withConfig: false,
    });
    const foreignCwd = path.join(tmpDir, "foreign-checkout");
    fs.mkdirSync(foreignCwd, { recursive: true });

    expect(
      resolveDuckbrainRoot({
        env: {},
        moduleDir: path.join(install, "src", "config"),
        entryPath: path.join(install, "bin", "duckbrain.js"),
        cwd: foreignCwd,
      }),
    ).toBe(install);
  });

  it("throws a clear error when no root can be determined at all", () => {
    const nowhere = path.join(tmpDir, "not-a-package", "src", "config");
    fs.mkdirSync(nowhere, { recursive: true });
    const foreignCwd = path.join(tmpDir, "foreign-checkout");
    fs.mkdirSync(foreignCwd, { recursive: true });

    expect(() =>
      resolveDuckbrainRoot({
        env: {},
        moduleDir: nowhere,
        entryPath: null,
        cwd: foreignCwd,
      }),
    ).toThrow(/duckbrain root.*DUCKBRAIN_HOME_ROOT/s);
  });
});

describe("GAP-062: namespace path resolution", () => {
  it("resolves namespacesPath against the config file's own directory, not the caller's cwd", () => {
    const root = makeDuckbrainRoot(path.join(tmpDir, "db-root"));
    const foreignCwd = path.join(tmpDir, "foreign-checkout");
    fs.mkdirSync(foreignCwd, { recursive: true });

    const prevConfigPath = process.env.DUCKBRAIN_CONFIG_PATH;
    const prevNsPath = process.env.DUCKBRAIN_NAMESPACES_PATH;
    const prevCwd = process.cwd();
    try {
      process.env.DUCKBRAIN_CONFIG_PATH = path.join(root, CONFIG_FILENAME);
      delete process.env.DUCKBRAIN_NAMESPACES_PATH;
      process.chdir(foreignCwd);

      expect(resolveNamespacesPath()).toBe(path.join(root, "namespaces"));
      // The regression: nothing may appear next to the caller.
      expect(fs.existsSync(path.join(foreignCwd, "namespaces"))).toBe(false);
    } finally {
      process.chdir(prevCwd);
      if (prevConfigPath === undefined) {
        delete process.env.DUCKBRAIN_CONFIG_PATH;
      } else {
        process.env.DUCKBRAIN_CONFIG_PATH = prevConfigPath;
      }
      if (prevNsPath === undefined) {
        delete process.env.DUCKBRAIN_NAMESPACES_PATH;
      } else {
        process.env.DUCKBRAIN_NAMESPACES_PATH = prevNsPath;
      }
    }
  });

  it('treats an explicit "." as the duckbrain root rather than the process cwd', () => {
    const root = makeDuckbrainRoot(path.join(tmpDir, "db-root"));
    const prevConfigPath = process.env.DUCKBRAIN_CONFIG_PATH;
    const prevNsPath = process.env.DUCKBRAIN_NAMESPACES_PATH;
    try {
      process.env.DUCKBRAIN_CONFIG_PATH = path.join(root, CONFIG_FILENAME);
      delete process.env.DUCKBRAIN_NAMESPACES_PATH;

      expect(resolveNamespacesPath(".")).toBe(path.join(root, "namespaces"));
    } finally {
      if (prevConfigPath === undefined) {
        delete process.env.DUCKBRAIN_CONFIG_PATH;
      } else {
        process.env.DUCKBRAIN_CONFIG_PATH = prevConfigPath;
      }
      if (prevNsPath === undefined) {
        delete process.env.DUCKBRAIN_NAMESPACES_PATH;
      } else {
        process.env.DUCKBRAIN_NAMESPACES_PATH = prevNsPath;
      }
    }
  });
});
