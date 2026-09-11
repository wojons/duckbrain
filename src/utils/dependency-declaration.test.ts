/**
 * DOGFOOD-0904-02 Regression Tests: express must be a DECLARED dependency.
 *
 * Regression guarded:
 *  - `src/cli/http.ts` (and every `src/http/routes/*.ts`) imports `express`
 *    directly, but the root `package.json` never declared it — it only rode
 *    along as a transitive dependency of `express-rate-limit`. pnpm's
 *    isolated `node_modules` therefore hid it from every fresh install, and
 *    a clean `pnpm install --frozen-lockfile && node bin/duckbrain.js http`
 *    died with `Error: Cannot find module 'express'`. A stale root-level
 *    `node_modules/express` on a long-lived dev box masked the bug locally.
 *
 * The guard is deliberately hermetic: it reads the manifest and asks the
 * repo-root package context to resolve the module. No server spawn, no
 * network, no ports — so CI goes red the next time the declaration is
 * dropped, without adding a second (flaky) server-spawn class to the suite.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { createRequire } from "module";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, "package.json");

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const manifest: PackageManifest = JSON.parse(
  fs.readFileSync(PACKAGE_JSON_PATH, "utf8"),
) as PackageManifest;

/** Resolve as the root package does — from <repo>/package.json. */
const requireFromRepoRoot = createRequire(PACKAGE_JSON_PATH);

describe("DOGFOOD-0904-02: express is declared as a direct dependency", () => {
  it("declares express in package.json dependencies", () => {
    expect(manifest.dependencies).toBeDefined();
    expect(Object.keys(manifest.dependencies ?? {})).toContain("express");
    expect(manifest.dependencies?.express).toMatch(/^\^?5\./);
  });

  it("does not hide express in devDependencies", () => {
    // @types/express is a legitimate devDependency; the runtime package
    // itself must never live there.
    expect(manifest.devDependencies?.express).toBeUndefined();
  });

  it("resolves express from the repo-root package context", () => {
    const resolved = requireFromRepoRoot.resolve("express");
    expect(resolved.split(path.sep).join("/")).toContain(
      "node_modules/express/",
    );
  });

  it("resolves an express major version matching the declared range", () => {
    const resolved = requireFromRepoRoot.resolve("express");
    const pkgDir = path.dirname(resolved);
    const pkgManifest = JSON.parse(
      fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"),
    ) as { version: string };
    expect(pkgManifest.version.startsWith("5.")).toBe(true);
  });
});
