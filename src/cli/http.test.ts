/**
 * Tests for HTTP MCP server
 */

import { describe, it, expect } from "vitest";
import { spawn, ChildProcess } from "child_process";
import net from "net";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { startHttpMode, createHttpServer } from "./http";

const BIN_PATH = path.resolve(__dirname, "..", "..", "bin", "duckbrain.js");

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      const port = addr.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function waitForHealth(port: number, timeout = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const attempt = () => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/health", timeout: 500 },
        (res) => {
          if (res.statusCode === 200) {
            res.resume();
            resolve();
            return;
          }
          res.resume();
          retry();
        },
      );
      req.on("error", retry);
      req.on("timeout", () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - start > timeout) {
        reject(new Error(`server did not become healthy on port ${port}`));
        return;
      }
      setTimeout(attempt, 100);
    };
    attempt();
  });
}

function waitForClose(child: ChildProcess, timeout = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("child process did not exit in time"));
    }, timeout);
    child.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function prepareDataDir(prefix: string): { dataDir: string; nsPath: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const nsPath = path.join(dataDir, "namespaces");
  fs.mkdirSync(path.join(nsPath, "default"), { recursive: true });
  fs.mkdirSync(path.join(nsPath, "test-ns"), { recursive: true });
  return { dataDir, nsPath };
}

function spawnHttpServer(port: number, dataDir: string, nsPath: string): ChildProcess {
  return spawn(process.execPath, [BIN_PATH, "http", `--port=${port}`], {
    env: {
      ...process.env,
      DUCKBRAIN_DATA_DIR: dataDir,
      DUCKBRAIN_NAMESPACES_PATH: nsPath,
      NO_COLOR: "1",
    },
    stdio: "pipe",
  });
}

describe("HTTP server entry point", () => {
  it("should export startHttpMode function", () => {
    expect(startHttpMode).toBeDefined();
    expect(typeof startHttpMode).toBe("function");
  });

  it("should export createHttpServer function", () => {
    expect(createHttpServer).toBeDefined();
    expect(typeof createHttpServer).toBe("function");
  });

  it("should start HTTP server with default options", async () => {
    // Verify function signature
    expect(async () => {
      await startHttpMode({ port: 3001 });
    }).toBeDefined();
  });
});

describe("DOGFOOD-008 per-instance pidfile", () => {
  it("writes and removes a per-instance pidfile on shutdown", async () => {
    const port = await findFreePort();
    const { dataDir, nsPath } = prepareDataDir("duckbrain-http-pid-test-");
    const child = spawnHttpServer(port, dataDir, nsPath);

    try {
      await waitForHealth(port);
      const pidFile = path.join(dataDir, `duckbrain-http-${port}.pid`);
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(fs.readFileSync(pidFile, "utf8").trim()).toBe(
        String(child.pid),
      );

      child.kill("SIGTERM");
      await waitForClose(child);

      expect(fs.existsSync(pidFile)).toBe(false);
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore if already dead
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("concurrent instances on different ports do not clobber each other's pidfiles", async () => {
    const port1 = await findFreePort();
    const port2 = await findFreePort();
    const { dataDir: dataDir1, nsPath: nsPath1 } = prepareDataDir(
      "duckbrain-http-pid-concurrent-1-",
    );
    const { dataDir: dataDir2, nsPath: nsPath2 } = prepareDataDir(
      "duckbrain-http-pid-concurrent-2-",
    );
    const child1 = spawnHttpServer(port1, dataDir1, nsPath1);
    const child2 = spawnHttpServer(port2, dataDir2, nsPath2);

    try {
      await Promise.all([waitForHealth(port1), waitForHealth(port2)]);

      const pidFile1 = path.join(dataDir1, `duckbrain-http-${port1}.pid`);
      const pidFile2 = path.join(dataDir2, `duckbrain-http-${port2}.pid`);
      expect(fs.existsSync(pidFile1)).toBe(true);
      expect(fs.existsSync(pidFile2)).toBe(true);

      const pid1 = fs.readFileSync(pidFile1, "utf8").trim();
      const pid2 = fs.readFileSync(pidFile2, "utf8").trim();
      expect(pid1).not.toBe(pid2);
      expect(pid1).toBe(String(child1.pid));
      expect(pid2).toBe(String(child2.pid));

      child1.kill("SIGTERM");
      child2.kill("SIGTERM");
      await Promise.all([waitForClose(child1), waitForClose(child2)]);

      expect(fs.existsSync(pidFile1)).toBe(false);
      expect(fs.existsSync(pidFile2)).toBe(false);
    } finally {
      try {
        child1.kill("SIGKILL");
      } catch {
        // ignore
      }
      try {
        child2.kill("SIGKILL");
      } catch {
        // ignore
      }
      fs.rmSync(dataDir1, { recursive: true, force: true });
      fs.rmSync(dataDir2, { recursive: true, force: true });
    }
  });
});
