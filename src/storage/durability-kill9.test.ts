/**
 * SUPA-1 — durability under real process death (AC-1, AC-7).
 *
 * These tests spawn REAL HTTP server child processes against a temp
 * `DUCKBRAIN_NAMESPACES_PATH` / `DUCKBRAIN_CONFIG_PATH`, ack a write, and then
 * kill the process — the only honest way to test "the 2xx means the record is
 * durable". Unit spies prove which syscall ran; these prove the record
 * survives.
 *
 * - AC-1: fsync-mode write acked → SIGKILL before any git commit → restart
 *   replay finds the record and the file parses line-by-line.
 * - buffered mode: acked → SIGKILL → record still present (page-cache
 *   retention; process-kill safe, NOT OS-crash safe).
 * - AC-7: graceful shutdown drains the durability barrier before the pending
 *   commit flush, so the record IS committed on SIGTERM.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "vitest";
import { spawn, execSync, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import net from "net";
import path from "path";
import http from "http";
import { readFromJsonl } from "./jsonl";

const BIN_PATH = path.resolve(__dirname, "..", "..", "bin", "duckbrain.js");
const TEST_TIMEOUT = 90_000;

interface Fixture {
  dataDir: string;
  nsPath: string;
  configPath: string;
  authFilePath: string;
  port: number;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

/**
 * Temp namespace root + config with nsA pinned to fsync mode. `nsA` gets a
 * pre-existing git repo so the write path takes the DEBOUNCED commit branch
 * (DOGFOOD-005 forces a synchronous first commit when .git is missing) — that
 * is what makes "killed before any git commit" a real scenario.
 */
async function makeFixture(): Promise<Fixture> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-supa1-k9-"));
  const nsPath = path.join(dataDir, "namespaces");
  fs.mkdirSync(path.join(nsPath, "nsA"), { recursive: true });
  fs.mkdirSync(path.join(nsPath, "nsB"), { recursive: true });

  const configPath = path.join(dataDir, "duckbrain.config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      namespacesPath: nsPath,
      gitBatching: { enabled: true, maxLines: 100, maxSeconds: 30 },
      durability: { defaultMode: "buffered", overrides: { nsA: "fsync" } },
    }),
    "utf-8",
  );

  const authFilePath = path.join(dataDir, "auth.json");
  fs.writeFileSync(authFilePath, JSON.stringify({ users: {}, apiKeys: {} }), "utf-8");

  initNamespaceRepo(path.join(nsPath, "nsA"));
  initNamespaceRepo(path.join(nsPath, "nsB"));

  return { dataDir, nsPath, configPath, authFilePath, port: await findFreePort() };
}

function initNamespaceRepo(nsDir: string): void {
  execSync("git init -q", { cwd: nsDir, stdio: "pipe" });
  execSync('git config user.email "duckbrain@localhost.localdomain"', {
    cwd: nsDir,
    stdio: "pipe",
  });
  execSync('git config user.name "DuckBrain"', { cwd: nsDir, stdio: "pipe" });
  fs.writeFileSync(path.join(nsDir, ".gitkeep"), "");
  execSync("git add -A", { cwd: nsDir, stdio: "pipe" });
  execSync('git commit -q -m "chore: init namespace"', {
    cwd: nsDir,
    stdio: "pipe",
  });
}

function spawnServer(fixture: Fixture): { child: ChildProcess; output: () => string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DUCKBRAIN_CONFIG_PATH: fixture.configPath,
    DUCKBRAIN_NAMESPACES_PATH: fixture.nsPath,
    DUCKBRAIN_DATA_DIR: fixture.dataDir,
    NO_COLOR: "1",
  };
  // Never inherit a durability env override from the parent test process.
  delete env.DUCKBRAIN_DURABILITY_MODE;

  const child = spawn(
    process.execPath,
    [BIN_PATH, "http", `--port=${fixture.port}`, `--auth-file=${fixture.authFilePath}`],
    { env, stdio: "pipe" },
  );

  let buffer = "";
  child.stdout?.on("data", (d) => (buffer += d.toString()));
  child.stderr?.on("data", (d) => (buffer += d.toString()));

  return { child, output: () => buffer };
}

function waitForHealth(port: number, child: ChildProcess, timeout = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const attempt = () => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/health", timeout: 1000 },
        (res) => {
          // 200 healthy or 503 degraded — either proves liveness.
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
        reject(new Error(`child server never answered /health on ${port}`));
        return;
      }
      setTimeout(attempt, 150);
    };
    child.once("exit", (code) =>
      reject(new Error(`child exited early with code ${code}`)),
    );
    attempt();
  });
}

function waitForExit(child: ChildProcess, timeout = 20_000): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("child did not exit in time"));
    }, timeout);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function postMemory(
  port: number,
  namespace: string,
  key: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }> {
  const payload = JSON.stringify({
    key,
    domain: "concept",
    content: `supa1 kill9 record ${key}`,
  });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: `/api/memories?namespace=${namespace}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          let body: any = raw;
          try {
            body = raw ? JSON.parse(raw) : null;
          } catch {
            /* raw */
          }
          resolve({ status: res.statusCode!, headers: res.headers, body });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

function jsonlFiles(nsDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".jsonl")) found.push(full);
    }
  };
  walk(nsDir);
  return found;
}

function gitCommitCount(nsDir: string): number {
  return parseInt(
    execSync("git rev-list --count HEAD", { cwd: nsDir, stdio: "pipe" })
      .toString()
      .trim(),
    10,
  );
}

describe("SUPA-1 AC-1: kill -9 after ack (fsync mode)", () => {
  let fixture: Fixture;
  let child: ChildProcess | null = null;

  beforeEach(async () => {
    fixture = await makeFixture();
  });

  afterEach(() => {
    try {
      child?.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    child = null;
    fs.rmSync(fixture.dataDir, { recursive: true, force: true });
  });

  it(
    "acked record survives SIGKILL and restart-replay parses the file cleanly",
    async () => {
      const started = spawnServer(fixture);
      child = started.child;
      await waitForHealth(fixture.port, child);

      const nsDir = path.join(fixture.nsPath, "nsA");
      const res = await postMemory(fixture.port, "nsA", "/supa1/kill9/fsync");

      expect(res.status).toBe(201);
      expect(res.headers["x-durability"]).toBe("fsync");

      // Kill immediately — the 30s debounce window means NO git commit has
      // happened, so durability can only come from the fsync barrier.
      child.kill("SIGKILL");
      await waitForExit(child);
      expect(gitCommitCount(nsDir)).toBe(1);

      // Restart-replay: a fresh reader over the partition file.
      const files = jsonlFiles(nsDir);
      expect(files).toHaveLength(1);
      const records = readFromJsonl(files[0]);
      expect(records).toHaveLength(1);
      expect(records[0].key).toBe("/supa1/kill9/fsync");

      // ...and the file parses line-by-line without error (no torn tail).
      const lines = fs
        .readFileSync(files[0], "utf-8")
        .split("\n")
        .filter((l) => l.trim() !== "");
      expect(lines).toHaveLength(1);
      expect(() => JSON.parse(lines[0])).not.toThrow();

      // The next debounced `git add -A` commit carries the record into history.
      execSync('git add -A && git commit -q -m "chore: replay"', {
        cwd: nsDir,
        stdio: "pipe",
      });
      expect(gitCommitCount(nsDir)).toBe(2);
      const rel = path.relative(nsDir, files[0]);
      const committed = execSync(`git show HEAD:${rel}`, {
        cwd: nsDir,
        stdio: "pipe",
      }).toString();
      expect(committed).toContain("/supa1/kill9/fsync");
    },
    TEST_TIMEOUT,
  );

  it(
    "buffered-mode ack survives SIGKILL (page-cache retention)",
    async () => {
      const started = spawnServer(fixture);
      child = started.child;
      await waitForHealth(fixture.port, child);

      const nsDir = path.join(fixture.nsPath, "nsB");
      const res = await postMemory(fixture.port, "nsB", "/supa1/kill9/buffered");
      expect(res.status).toBe(201);
      expect(res.headers["x-durability"]).toBe("buffered");

      child.kill("SIGKILL");
      await waitForExit(child);

      // Buffered mode is process-kill safe: the page cache outlives the
      // process. (Its OS-crash/power-loss window is the documented RPO.)
      const files = jsonlFiles(nsDir);
      expect(files).toHaveLength(1);
      const records = readFromJsonl(files[0]);
      expect(records).toHaveLength(1);
      expect(records[0].key).toBe("/supa1/kill9/buffered");
      expect(gitCommitCount(nsDir)).toBe(1);
    },
    TEST_TIMEOUT,
  );

  it(
    "graceful shutdown flushes the pending commit after the durability drain (AC-7)",
    async () => {
      const started = spawnServer(fixture);
      child = started.child;
      await waitForHealth(fixture.port, child);

      const nsDir = path.join(fixture.nsPath, "nsA");
      const res = await postMemory(fixture.port, "nsA", "/supa1/kill9/graceful");
      expect(res.status).toBe(201);
      expect(res.headers["x-durability"]).toBe("fsync");

      // SIGTERM → drainDurableWrites() → flushAllCommits() → exit(0)
      child.kill("SIGTERM");
      const code = await waitForExit(child);
      expect(code).toBe(0);

      const files = jsonlFiles(nsDir);
      const records = readFromJsonl(files[0]);
      expect(records.map((r) => r.key)).toContain("/supa1/kill9/graceful");

      // The debounced commit WAS flushed on the way out: the record is in git
      // history, not just in the working tree.
      expect(gitCommitCount(nsDir)).toBe(2);
      const rel = path.relative(nsDir, files[0]);
      expect(
        execSync(`git show HEAD:${rel}`, { cwd: nsDir, stdio: "pipe" }).toString(),
      ).toContain("/supa1/kill9/graceful");
    },
    TEST_TIMEOUT,
  );
});
