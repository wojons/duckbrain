/**
 * DOGFOOD-008 regression tests for DuckDB scratch-file cleanup.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { cleanupProcessScratchFiles } from "./connection";

describe("DOGFOOD-008 scratch file cleanup", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-cleanup-test-"));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes only this process's scratch db files", () => {
    const own = path.join(
      tmpDir,
      `duckbrain-${process.pid}-abc123-0.db`,
    );
    const otherPid = path.join(
      tmpDir,
      `duckbrain-${process.pid + 1}-abc123-0.db`,
    );
    const otherExtension = path.join(
      tmpDir,
      `duckbrain-${process.pid}-abc123-0.txt`,
    );
    const otherPrefix = path.join(tmpDir, `duckbrain-${process.pid}-leftover`);

    fs.writeFileSync(own, "x");
    fs.writeFileSync(otherPid, "x");
    fs.writeFileSync(otherExtension, "x");
    fs.writeFileSync(otherPrefix, "x");

    cleanupProcessScratchFiles(tmpDir);

    expect(fs.existsSync(own)).toBe(false);
    expect(fs.existsSync(otherPid)).toBe(true);
    expect(fs.existsSync(otherExtension)).toBe(true);
    expect(fs.existsSync(otherPrefix)).toBe(true);
  });

  it("is tolerant of a missing temp directory", () => {
    expect(() =>
      cleanupProcessScratchFiles(path.join(tmpDir, "does-not-exist")),
    ).not.toThrow();
  });
});
