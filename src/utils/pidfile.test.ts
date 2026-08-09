/**
 * Tests for the per-instance pidfile path helper.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import os from "os";
import { httpPidFilePath } from "./pidfile";

describe("httpPidFilePath", () => {
  let originalDataDir: string | undefined;

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
    expect(result).toBe(path.join(os.tmpdir(), "duckbrain-http-3000.pid"));
  });

  it("uses the explicit TCP port", () => {
    expect(httpPidFilePath(8080)).toBe(
      path.join(os.tmpdir(), "duckbrain-http-8080.pid"),
    );
  });

  it("uses the socket basename when a socket path is provided", () => {
    expect(httpPidFilePath(3000, "/tmp/duckbrain.sock")).toBe(
      path.join(os.tmpdir(), "duckbrain-http-duckbrain.sock.pid"),
    );
  });

  it("prefers DUCKBRAIN_DATA_DIR over os.tmpdir()", () => {
    process.env.DUCKBRAIN_DATA_DIR = "/var/lib/duckbrain";
    expect(httpPidFilePath(3000)).toBe(
      "/var/lib/duckbrain/duckbrain-http-3000.pid",
    );
  });
});
