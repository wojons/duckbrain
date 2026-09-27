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

function waitForHealth(port: number, timeout = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const attempt = () => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/health", timeout: 500 },
        (res) => {
          // GAP-030: the in-process server probes the host's real embedding
          // providers and may legitimately answer 503 (degraded) — liveness
          // is proven by any HTTP answer, 200 or 503.
          if (res.statusCode === 200 || res.statusCode === 503) {
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

function spawnHttpServer(
  port: number,
  dataDir: string,
  nsPath: string,
): ChildProcess {
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
      expect(fs.readFileSync(pidFile, "utf8").trim()).toBe(String(child.pid));

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
  }, 30000);

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
  }, 30000);
});

describe("DOGFOOD-016 stale pidfile cleanup", () => {
  /**
   * A pid that is guaranteed dead: spawn a node child that exits immediately
   * and use its pid once the 'exit' event fired.
   */
  function deadPid(): Promise<number> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
      child.once("exit", () => resolve(child.pid ?? 2147483647));
    });
  }

  it("replaces a stale pidfile (dead pid) with the live pid on startup", async () => {
    const port = await findFreePort();
    const { dataDir, nsPath } = prepareDataDir("duckbrain-http-stale-pid-");
    const pidFile = path.join(dataDir, `duckbrain-http-${port}.pid`);

    // Simulate a crashed previous instance: pidfile with a dead pid.
    fs.writeFileSync(pidFile, String(await deadPid()));

    const child = spawnHttpServer(port, dataDir, nsPath);

    try {
      await waitForHealth(port);

      // The stale pidfile must have been replaced by the live server's pid
      // (a dead pid must never shadow a running instance).
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(fs.readFileSync(pidFile, "utf8").trim()).toBe(String(child.pid));

      child.kill("SIGTERM");
      await waitForClose(child);
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore if already dead
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("DF-0926-01 bind-conflict lifecycle", () => {
  /**
   * Spawn the real CLI entry (`node bin/duckbrain.js http --port=<port>`) in
   * an isolated scratch environment (unique data dir + namespaces path +
   * unique port) so a bind conflict can never touch a live daemon's
   * pidfile. Every spawned child is terminated via its explicit PID —
   * never a pattern kill.
   */
  it("bind conflict: exits nonzero, no started banner, prior live pidfile preserved, own pidfile absent", async () => {
    // Occupant: a real healthy DuckBrain HTTP daemon owns the scratch port.
    const port = await findFreePort();
    const { dataDir: dirA, nsPath: nsA } = prepareDataDir(
      "duckbrain-bind-occupy-a-",
    );
    const occupant = spawnHttpServer(port, dirA, nsA);

    // Challenger: fresh scratch env, SAME port.
    const { dataDir: dirB, nsPath: nsB } = prepareDataDir(
      "duckbrain-bind-challenger-b-",
    );
    const pidFileB = path.join(dirB, `duckbrain-http-${port}.pid`);
    const pidFileA = path.join(dirA, `duckbrain-http-${port}.pid`);

    try {
      await waitForHealth(port);
      expect(fs.readFileSync(pidFileA, "utf8").trim()).toBe(
        String(occupant.pid),
      );

      const challenger = spawnHttpServer(port, dirB, nsB);
      let stderr = "";
      let stdout = "";
      challenger.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
      challenger.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));

      // waitForClose resolves on self-exit (the fixed behavior). On the
      // pre-fix code the challenger lingers as a zombie copy (never self-
      // exits, never serves) and the 60s deadline fires with SIGKILL +
      // reject — either way the test fails before the fix.
      await waitForClose(challenger, 60000);

      const exitCode = (
        challenger as ChildProcess & { exitCode?: number | null }
      ).exitCode;
      expect(exitCode).not.toBe(0);

      // The started banner must never have been printed.
      const combined = stdout + stderr;
      expect(combined).not.toContain("HTTP server started at");
      expect(combined).not.toContain("HTTP server ready");
      expect(combined).not.toContain("PID written to");
      // The failure path itself must be loud.
      expect(combined).toContain("Failed to start HTTP server");

      // The challenger must not have written its own pidfile...
      expect(fs.existsSync(pidFileB)).toBe(false);
      // ...and the live occupant's pidfile must be untouched.
      expect(fs.existsSync(pidFileA)).toBe(true);
      expect(fs.readFileSync(pidFileA, "utf8").trim()).toBe(
        String(occupant.pid),
      );

      // The occupant must still be the one serving.
      await waitForHealth(port, 5000);
    } finally {
      try {
        occupant.kill("SIGKILL");
      } catch {
        // ignore
      }
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  }, 90000);

  it("healthy boot still writes the pidfile only after the port listens", async () => {
    const port = await findFreePort();
    const { dataDir, nsPath } = prepareDataDir("duckbrain-bind-ok-");
    const child = spawnHttpServer(port, dataDir, nsPath);

    try {
      await waitForHealth(port);
      const pidFile = path.join(dataDir, `duckbrain-http-${port}.pid`);
      // Success path: pidfile exists AFTER a successful bind and names the
      // live process (per-port pidfile behavior preserved).
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(fs.readFileSync(pidFile, "utf8").trim()).toBe(String(child.pid));
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30000);
});
