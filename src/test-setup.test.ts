/**
 * DF-2026-15 test-isolation guard.
 *
 * The global setup pins every Vitest worker to its own temp namespace root.
 * This guard is intentionally a CI assertion: a test may create and delete
 * namespaces, but it must never leave an auger-* namespace in the isolated
 * root (or accidentally write one into the repository's production root).
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

function namespaceDirectories(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("auger-"))
    .map((entry) => entry.name)
    .sort();
}

describe("DF-2026-15 test namespace isolation", () => {
  it("pins DUCKBRAIN_NAMESPACES_PATH to a temp root", () => {
    const configured = process.env.DUCKBRAIN_NAMESPACES_PATH;
    expect(configured).toBeTruthy();
    expect(path.resolve(configured!)).toContain(path.resolve(os.tmpdir()));
  });

  it("leaves no auger-* namespace directories after the test run", () => {
    const root = process.env.DUCKBRAIN_NAMESPACES_PATH;
    expect(root).toBeTruthy();
    expect(namespaceDirectories(root!)).toEqual([]);

    const productionRoot = path.resolve(process.cwd(), "namespaces");
    expect(namespaceDirectories(productionRoot)).toEqual([]);
  });
});
