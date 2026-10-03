/**
 * Tests for the per-instance pidfile path helper.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";
import { spawn } from "child_process";
import { httpPidFilePath, cleanupStalePidFile } from "./pidfile";

describe("httpPidFilePath", () => {
  let originalDataDir: string | undefined;

  // QA-DUCKBRAIN-002: the no-override fallback is the per-uid dir
  // `os.tmpdir()/duckbrain-<uid>`, not the bare shared os.tmpdir().
  const uid =
    typeof process.getuid === "function" ? process.getuid() : os.userInfo().uid;
  const perUidDir = path.join(os.tmpdir(), `duckbrain-${uid}`);

  beforeEach(() => {
    originalDataDir = process.env.DUCKBRAIN_DATA_DIR;
    delete process.env.DUCKBRAIN_DATA_DIR;
  });

  afterEach(() => {
    if (originalDataDir === undefined) {
      delete process.env.DUCKBRAIN_DATA_DIR;
    } else {
      process.env.DUCKBRAIN_DATA_DIR = originalDataDir;
    }
  });

  it("uses port 3000 by default", () => {
    const result = httpPidFilePath(3000);
    expect(result).toBe(path.join(perUidDir, "duckbrain-http-3000.pid"));
  });

  it("uses the explicit TCP port", () => {
    expect(httpPidFilePath(8080)).toBe(
      path.join(perUidDir, "duckbrain-http-8080.pid"),
    );
  });

  it("uses the socket basename when a socket path is provided", () => {
    expect(httpPidFilePath(3000, "/tmp/duckbrain.sock")).toBe(
      path.join(perUidDir, "duckbrain-http-duckbrain.sock.pid"),
    );
  });

  it("prefers DUCKBRAIN_DATA_DIR over the per-uid temp dir fallback", () => {
    process.env.DUCKBRAIN_DATA_DIR = "/var/lib/duckbrain";
    expect(httpPidFilePath(3000)).toBe(
      "/var/lib/duckbrain/duckbrain-http-3000.pid",
    );
  });
});

/**
 * Obtain a pid that is guaranteed dead: spawn a node child that exits
 * immediately and use its pid once the 'exit' event fired.
 */
function deadPid(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    child.once("exit", () => resolve(child.pid ?? 2147483647));
  });
}

describe("cleanupStalePidFile (DOGFOOD-016)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-pidfile-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes a pidfile whose pid is dead", async () => {
    const pidFile = path.join(tmpDir, "duckbrain-http-3999.pid");
    fs.writeFileSync(pidFile, String(await deadPid()));

    cleanupStalePidFile(pidFile);

    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("keeps a pidfile whose pid is alive", () => {
    const pidFile = path.join(tmpDir, "duckbrain-http-3998.pid");
    fs.writeFileSync(pidFile, String(process.pid));

    cleanupStalePidFile(pidFile);

    expect(fs.existsSync(pidFile)).toBe(true);
  });

  it("removes a pidfile with unparseable content", () => {
    const pidFile = path.join(tmpDir, "duckbrain-http-3997.pid");
    fs.writeFileSync(pidFile, "not-a-pid\n");

    cleanupStalePidFile(pidFile);

    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("is a no-op when the pidfile is missing", () => {
    const pidFile = path.join(tmpDir, "duckbrain-http-3996.pid");
    expect(() => cleanupStalePidFile(pidFile)).not.toThrow();
  });
});
