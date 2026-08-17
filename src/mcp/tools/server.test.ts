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
import { spawn } from "child_process";

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
      fs.writeFileSync(pidFile, String(process.pid));

      const result = await serverStatusTool({ port: 3555 });

      expect(result.pid).toBe(process.pid);
      expect(result.pidFile).toBe(pidFile);
      expect(result.pidFileExists).toBe(true);
      expect(result.pidStale).toBe(false);
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
      fs.writeFileSync(pidFile, String(process.pid));

      const result = await serverStatusTool({
        port: 3000,
        socket: "/tmp/test.sock",
      });

      expect(result.pid).toBe(process.pid);
      expect(result.pidFile).toBe(pidFile);
      expect(result.pidFileExists).toBe(true);
      expect(result.pidStale).toBe(false);
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
      expect(result.pidFileExists).toBe(false);
      expect(result.pidStale).toBe(false);
      expect(result.stalePid).toBeNull();
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

describe("server_status instance-awareness (DOGFOOD-015)", () => {
  it("resolves the port from DUCKBRAIN_API_PORT when no input.port is given", async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-server-status-envport-"),
    );
    const previousDataDir = process.env.DUCKBRAIN_DATA_DIR;
    const previousApiPort = process.env.DUCKBRAIN_API_PORT;
    process.env.DUCKBRAIN_DATA_DIR = tmpDir;
    process.env.DUCKBRAIN_API_PORT = "3999";
    try {
      const result = await serverStatusTool({});

      expect(result.port).toBe(3999);
      expect(result.portSource).toBe("env");
      expect(result.pidFile).toBe(
        path.join(tmpDir, "duckbrain-http-3999.pid"),
      );
    } finally {
      if (previousDataDir === undefined) {
        delete process.env.DUCKBRAIN_DATA_DIR;
      } else {
        process.env.DUCKBRAIN_DATA_DIR = previousDataDir;
      }
      if (previousApiPort === undefined) {
        delete process.env.DUCKBRAIN_API_PORT;
      } else {
        process.env.DUCKBRAIN_API_PORT = previousApiPort;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("prefers an explicit input.port over DUCKBRAIN_API_PORT", async () => {
    const previousApiPort = process.env.DUCKBRAIN_API_PORT;
    process.env.DUCKBRAIN_API_PORT = "3999";
    try {
      const result = await serverStatusTool({ port: 3888 });

      expect(result.port).toBe(3888);
      expect(result.portSource).toBe("input");
    } finally {
      if (previousApiPort === undefined) {
        delete process.env.DUCKBRAIN_API_PORT;
      } else {
        process.env.DUCKBRAIN_API_PORT = previousApiPort;
      }
    }
  });

  it("falls back to the default port when DUCKBRAIN_API_PORT is unset", async () => {
    const previousApiPort = process.env.DUCKBRAIN_API_PORT;
    delete process.env.DUCKBRAIN_API_PORT;
    try {
      const result = await serverStatusTool({});

      expect(result.port).toBe(3000);
      expect(result.portSource).toBe("default");
    } finally {
      if (previousApiPort === undefined) {
        delete process.env.DUCKBRAIN_API_PORT;
      } else {
        process.env.DUCKBRAIN_API_PORT = previousApiPort;
      }
    }
  });

  it("reports a dead pid from the pidfile as stale, not live", async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-server-status-stale-"),
    );
    const previousDataDir = process.env.DUCKBRAIN_DATA_DIR;
    process.env.DUCKBRAIN_DATA_DIR = tmpDir;
    try {
      const dead = await deadPid();
      const pidFile = path.join(tmpDir, "duckbrain-http-3557.pid");
      fs.writeFileSync(pidFile, String(dead));

      const result = await serverStatusTool({ port: 3557 });

      expect(result.pid).toBeNull();
      expect(result.pidStale).toBe(true);
      expect(result.stalePid).toBe(dead);
      expect(result.pidFileExists).toBe(true);
      expect(result.pidFile).toBe(pidFile);
    } finally {
      if (previousDataDir === undefined) {
        delete process.env.DUCKBRAIN_DATA_DIR;
      } else {
        process.env.DUCKBRAIN_DATA_DIR = previousDataDir;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reports a live pid from the pidfile as alive", async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-server-status-alive-"),
    );
    const previousDataDir = process.env.DUCKBRAIN_DATA_DIR;
    process.env.DUCKBRAIN_DATA_DIR = tmpDir;
    try {
      const pidFile = path.join(tmpDir, "duckbrain-http-3558.pid");
      fs.writeFileSync(pidFile, String(process.pid));

      const result = await serverStatusTool({ port: 3558 });

      expect(result.pid).toBe(process.pid);
      expect(result.pidStale).toBe(false);
      expect(result.stalePid).toBeNull();
      expect(result.pidFileExists).toBe(true);
    } finally {
      if (previousDataDir === undefined) {
        delete process.env.DUCKBRAIN_DATA_DIR;
      } else {
        process.env.DUCKBRAIN_DATA_DIR = previousDataDir;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("treats an unparseable pidfile as stale", async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-server-status-unparseable-"),
    );
    const previousDataDir = process.env.DUCKBRAIN_DATA_DIR;
    process.env.DUCKBRAIN_DATA_DIR = tmpDir;
    try {
      const pidFile = path.join(tmpDir, "duckbrain-http-3560.pid");
      fs.writeFileSync(pidFile, "not-a-pid\n");

      const result = await serverStatusTool({ port: 3560 });

      expect(result.pid).toBeNull();
      expect(result.pidStale).toBe(true);
      expect(result.stalePid).toBeNull();
      expect(result.pidFileExists).toBe(true);
    } finally {
      if (previousDataDir === undefined) {
        delete process.env.DUCKBRAIN_DATA_DIR;
      } else {
        process.env.DUCKBRAIN_DATA_DIR = previousDataDir;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reports the resolved config so callers can identify the instance", async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-server-status-config-"),
    );
    const nsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-server-status-ns-"),
    );
    const scratchConfig = path.join(tmpDir, "scratch-config.json");
    const previousDataDir = process.env.DUCKBRAIN_DATA_DIR;
    const previousNsPath = process.env.DUCKBRAIN_NAMESPACES_PATH;
    const previousConfigPath = process.env.DUCKBRAIN_CONFIG_PATH;
    process.env.DUCKBRAIN_DATA_DIR = tmpDir;
    process.env.DUCKBRAIN_NAMESPACES_PATH = nsDir;
    process.env.DUCKBRAIN_CONFIG_PATH = scratchConfig;
    try {
      const result = await serverStatusTool({ port: 3559 });

      expect(result.config?.namespacesPath).toBe(nsDir);
      expect(result.config?.configFile).toBe(scratchConfig);
      // The scratch config's pidfile, not the live :3000 daemon's.
      expect(result.pidFile).toBe(
        path.join(tmpDir, "duckbrain-http-3559.pid"),
      );
    } finally {
      if (previousDataDir === undefined) {
        delete process.env.DUCKBRAIN_DATA_DIR;
      } else {
        process.env.DUCKBRAIN_DATA_DIR = previousDataDir;
      }
      if (previousNsPath === undefined) {
        delete process.env.DUCKBRAIN_NAMESPACES_PATH;
      } else {
        process.env.DUCKBRAIN_NAMESPACES_PATH = previousNsPath;
      }
      if (previousConfigPath === undefined) {
        delete process.env.DUCKBRAIN_CONFIG_PATH;
      } else {
        process.env.DUCKBRAIN_CONFIG_PATH = previousConfigPath;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(nsDir, { recursive: true, force: true });
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
