/**
 * Tests for server control MCP tools (server_status, server_http_start)
 *
 * Only safe paths are exercised: status checks against a port that is NOT
 * listening (no side effects), http_start with alreadyRunning=true (no
 * spawn), project-root resolution, and the spawn path via the exported
 * helper with a guaranteed-failing command — never the real duckbrain
 * entry, so no real server spawns and no stray processes in tests.
 */

import { describe, it, expect } from "vitest";
import {
  serverStatusTool,
  ServerStatusInputSchema,
  serverHttpStartTool,
  ServerHttpStartInputSchema,
  resolveProjectRoot,
  spawnHttpServerAndWaitForPort,
} from "./server";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";

describe("server_status tool", () => {
  it("reports not listening on a closed port", async () => {
    // Port 1 is reserved — nothing can be listening there
    const result = await serverStatusTool({ port: 1 });

    expect(result.success).toBe(false);
    expect(result.port).toBe(1);
    expect(result.portListening).toBe(false);
    expect(Array.isArray(result.endpoints)).toBe(true);
  });

  it("reports a missing socket as not listening", async () => {
    const result = await serverStatusTool({
      port: 1,
      socket: "/nonexistent/duckbrain.sock",
    });

    expect(result.success).toBe(false);
    expect(result.socketListening).toBe(false);
  });

  it("validates schema: port must be a number", () => {
    expect(() => ServerStatusInputSchema.parse({ port: "abc" })).toThrow();
    expect(ServerStatusInputSchema.parse({ port: 3000 }).port).toBe(3000);
  });

  it("reads the per-instance pidfile for the queried port", async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-server-status-"),
    );
    const previous = process.env.DUCKBRAIN_DATA_DIR;
    process.env.DUCKBRAIN_DATA_DIR = tmpDir;
    try {
      const pidFile = path.join(tmpDir, "duckbrain-http-3555.pid");
      fs.writeFileSync(pidFile, "4242");

      const result = await serverStatusTool({ port: 3555 });

      expect(result.pid).toBe(4242);
      expect(result.pidFile).toBe(pidFile);
      expect(result.port).toBe(3555);
    } finally {
      if (previous === undefined) {
        delete process.env.DUCKBRAIN_DATA_DIR;
      } else {
        process.env.DUCKBRAIN_DATA_DIR = previous;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reads the per-instance pidfile for the queried socket", async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-server-status-socket-"),
    );
    const previous = process.env.DUCKBRAIN_DATA_DIR;
    process.env.DUCKBRAIN_DATA_DIR = tmpDir;
    try {
      const pidFile = path.join(tmpDir, "duckbrain-http-test.sock.pid");
      fs.writeFileSync(pidFile, "4343");

      const result = await serverStatusTool({
        port: 3000,
        socket: "/tmp/test.sock",
      });

      expect(result.pid).toBe(4343);
      expect(result.pidFile).toBe(pidFile);
    } finally {
      if (previous === undefined) {
        delete process.env.DUCKBRAIN_DATA_DIR;
      } else {
        process.env.DUCKBRAIN_DATA_DIR = previous;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null pid when the per-instance pidfile is missing", async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-server-status-missing-"),
    );
    const previous = process.env.DUCKBRAIN_DATA_DIR;
    process.env.DUCKBRAIN_DATA_DIR = tmpDir;
    try {
      const result = await serverStatusTool({ port: 3556 });

      expect(result.pid).toBeNull();
      expect(result.pidFile).toBe(path.join(tmpDir, "duckbrain-http-3556.pid"));
    } finally {
      if (previous === undefined) {
        delete process.env.DUCKBRAIN_DATA_DIR;
      } else {
        process.env.DUCKBRAIN_DATA_DIR = previous;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("resolveProjectRoot", () => {
  it("resolves to a directory containing bin/duckbrain.ts from the repo root without DUCKBRAIN_HOME_ROOT", () => {
    const previous = process.env.DUCKBRAIN_HOME_ROOT;
    delete process.env.DUCKBRAIN_HOME_ROOT;
    try {
      const root = resolveProjectRoot();
      expect(fs.existsSync(path.join(root, "bin", "duckbrain.ts"))).toBe(true);
      expect(fs.existsSync(path.join(root, "bin", "duckbrain.js"))).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.DUCKBRAIN_HOME_ROOT;
      } else {
        process.env.DUCKBRAIN_HOME_ROOT = previous;
      }
    }
  });

  it("derives the root from the module location, not from cwd", () => {
    // The DOGFOOD-013 bug: with cwd == repo root, the old
    // `path.resolve(cwd, "..", "..")` yielded "/". The resolver must ignore
    // cwd entirely when the module walk finds the root.
    const previous = process.env.DUCKBRAIN_HOME_ROOT;
    delete process.env.DUCKBRAIN_HOME_ROOT;
    try {
      const root = resolveProjectRoot(process.env, "/totally/unrelated/cwd");
      expect(fs.existsSync(path.join(root, "bin", "duckbrain.ts"))).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.DUCKBRAIN_HOME_ROOT;
      } else {
        process.env.DUCKBRAIN_HOME_ROOT = previous;
      }
    }
  });

  it("prefers the DUCKBRAIN_HOME_ROOT override", () => {
    const root = resolveProjectRoot(
      { DUCKBRAIN_HOME_ROOT: "/tmp/override-root" },
      "/some/cwd",
      "/some/module/dir",
    );
    expect(root).toBe("/tmp/override-root");
  });

  it("falls back to cwd when no ancestor contains bin/duckbrain", () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-root-resolve-"),
    );
    try {
      const root = resolveProjectRoot({}, "/fallback/cwd", tmpDir);
      expect(root).toBe("/fallback/cwd");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("server_http_start tool", () => {
  it("returns alreadyRunning when the port is listening", async () => {
    // Real TCP listener on an ephemeral port — exercises the
    // alreadyRunning branch hermetically (no spawn at all).
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as { port: number };
    try {
      const result = await serverHttpStartTool({
        port: address.port,
        force: false,
      });

      expect(result.success).toBe(true);
      expect(result.alreadyRunning).toBe(true);
      expect(result.spawned).toBeUndefined();
      expect(result.message).toContain("already listening");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10000);

  it("surfaces captured child stderr when the spawned process fails", async () => {
    const result = await spawnHttpServerAndWaitForPort(
      process.execPath,
      ["-e", 'process.stderr.write("boom"); process.exit(1)'],
      1,
      { env: process.env, detached: false, waitMs: 3000 },
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain("boom");
    expect(result.message).toContain("stderr:");
  }, 10000);

  it("surfaces a spawn error (ENOENT) instead of throwing", async () => {
    const result = await spawnHttpServerAndWaitForPort(
      "/nonexistent/duckbrain-binary-xyz",
      ["http"],
      1,
      { env: process.env, detached: false, waitMs: 3000 },
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain("spawn error");
  }, 10000);

  it("validates schema: socketMode accepts octal string", () => {
    const parsed = ServerHttpStartInputSchema.parse({
      socket: "/tmp/test.sock",
      socketMode: "0660",
      socketGroup: "kara",
    });
    expect(parsed.socket).toBe("/tmp/test.sock");
    expect(parsed.socketMode).toBe("0660");
    expect(parsed.socketGroup).toBe("kara");
  });

  it("validates schema: authType restricted to known values", () => {
    expect(() =>
      ServerHttpStartInputSchema.parse({ authType: "kerberos" }),
    ).toThrow();
    expect(
      ServerHttpStartInputSchema.parse({ authType: "apikey" }).authType,
    ).toBe("apikey");
  });
});
