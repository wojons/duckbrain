/**
 * DB-GAP-043 regression tests: --auth-file / DUCKBRAIN_AUTH_FILE isolation
 * for scratch/judge daemons.
 *
 * Incident (2026-08-25): the gitreins tier-2 judge for DB-GAP-041 spawned
 * scratch duckbrain HTTP daemons that SHARED the production auth store
 * (src/cli/http.ts hardcoded ~/.duckbrain/auth.json) — 13 prod tokens were
 * wiped and the live :3000 daemon was SIGTERMed. These tests pin the fix:
 *
 *  1. resolveAuthStorePath precedence: --auth-file flag > DUCKBRAIN_AUTH_FILE
 *     env > prod default (~/.duckbrain/auth.json).
 *  2. An explicit auth-file that is missing/unparseable is a FATAL startup
 *     error (never a silent fallback to the prod store).
 *  3. A scratch daemon started with --auth-file=<temp> serves auth from the
 *     temp file (401 without key, 200 with the temp file's key) and leaves
 *     the REAL ~/.duckbrain/auth.json byte-identical (content hash + mtime).
 *
 * Hermeticity: daemons run with DUCKBRAIN_DATA_DIR / DUCKBRAIN_NAMESPACES_PATH
 * in temp dirs (http.test.ts pattern); nothing here ever writes to the real
 * ~/.duckbrain/auth.json — the prod file is only READ for the unchanged
 * assertion, and only its sha256 is compared so a failure can never print
 * prod secrets into test output.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, ChildProcess } from "child_process";
import crypto from "crypto";
import net from "net";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import {
  createHttpServer,
  resolveAuthStorePath,
  defaultAuthStorePath,
} from "./http";

const BIN_PATH = path.resolve(__dirname, "..", "..", "bin", "duckbrain.js");
const PROD_AUTH_PATH = path.join(os.homedir(), ".duckbrain", "auth.json");
const SCRATCH_KEY = "sk-scratch-dbgap043";

/* ---------------------------------------------------------------- helpers */

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

function waitForClose(
  child: ChildProcess,
  timeout = 30000,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("child process did not exit in time"));
    }, timeout);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** GET a path, resolve with the status code (body discarded). */
function httpStatus(
  port: number,
  urlPath: string,
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: urlPath, headers, timeout: 5000 },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("request timeout")));
  });
}

function prepareDataDir(prefix: string): { dataDir: string; nsPath: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const nsPath = path.join(dataDir, "namespaces");
  fs.mkdirSync(path.join(nsPath, "default"), { recursive: true });
  return { dataDir, nsPath };
}

function writeScratchAuthFile(dir: string): string {
  const authFile = path.join(dir, "scratch-auth.json");
  fs.writeFileSync(
    authFile,
    JSON.stringify({
      users: [],
      apiKeys: [{ key: SCRATCH_KEY, name: "scratch-judge" }],
    }),
  );
  return authFile;
}

function spawnHttpServer(
  port: number,
  dataDir: string,
  nsPath: string,
  extraArgs: string[],
  extraEnv: Record<string, string> = {},
): ChildProcess {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DUCKBRAIN_DATA_DIR: dataDir,
    DUCKBRAIN_NAMESPACES_PATH: nsPath,
    NO_COLOR: "1",
    // Fast-fail embedding probe so /health answers promptly (tests/helpers.ts
    // INT-CI-003 pattern).
    DUCKBRAIN_EMBEDDING_PROVIDER: "openai",
    DUCKBRAIN_EMBEDDING_API_KEY: "",
    ...extraEnv,
  };
  // Flag-form tests must not inherit an env override leaked by another test.
  if (!("DUCKBRAIN_AUTH_FILE" in extraEnv)) {
    delete env.DUCKBRAIN_AUTH_FILE;
  }
  return spawn(
    process.execPath,
    [BIN_PATH, "http", `--port=${port}`, ...extraArgs],
    {
      env,
      stdio: "pipe",
    },
  );
}

/**
 * Snapshot of the prod auth store that is safe to compare (and safe to
 * print on failure): existence + sha256 + mtime — never the raw bytes.
 */
function snapshotProdAuth(): {
  exists: boolean;
  sha256: string | null;
  mtimeMs: number | null;
} {
  if (!fs.existsSync(PROD_AUTH_PATH)) {
    return { exists: false, sha256: null, mtimeMs: null };
  }
  const bytes = fs.readFileSync(PROD_AUTH_PATH);
  return {
    exists: true,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    mtimeMs: fs.statSync(PROD_AUTH_PATH).mtimeMs,
  };
}

/* ------------------------------------------------- unit: path resolution */

describe("DB-GAP-043 resolveAuthStorePath", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.DUCKBRAIN_AUTH_FILE;
    delete process.env.DUCKBRAIN_AUTH_FILE;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.DUCKBRAIN_AUTH_FILE;
    } else {
      process.env.DUCKBRAIN_AUTH_FILE = savedEnv;
    }
  });

  it("falls back to the prod default when neither flag nor env is set", () => {
    const { authFilePath, explicit } = resolveAuthStorePath(undefined);
    expect(authFilePath).toBe(defaultAuthStorePath());
    expect(authFilePath).toBe(
      path.join(os.homedir(), ".duckbrain", "auth.json"),
    );
    expect(explicit).toBe(false);
  });

  it("picks up the DUCKBRAIN_AUTH_FILE env fallback when no flag is given", () => {
    process.env.DUCKBRAIN_AUTH_FILE = "/tmp/scratch-env-auth.json";
    const { authFilePath, explicit } = resolveAuthStorePath(undefined);
    expect(authFilePath).toBe("/tmp/scratch-env-auth.json");
    expect(explicit).toBe(true);
  });

  it("prefers the --auth-file flag over the env fallback", () => {
    process.env.DUCKBRAIN_AUTH_FILE = "/tmp/scratch-env-auth.json";
    const { authFilePath, explicit } = resolveAuthStorePath(
      "/tmp/scratch-flag-auth.json",
    );
    expect(authFilePath).toBe("/tmp/scratch-flag-auth.json");
    expect(explicit).toBe(true);
  });
});

/* --------------------------------------- unit: createHttpServer contract */

describe("DB-GAP-043 createHttpServer auth-file contract", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.DUCKBRAIN_AUTH_FILE;
    delete process.env.DUCKBRAIN_AUTH_FILE;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.DUCKBRAIN_AUTH_FILE;
    } else {
      process.env.DUCKBRAIN_AUTH_FILE = savedEnv;
    }
  });

  it("throws a clear error when --auth-file points at a missing file", () => {
    const missing = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "dbgap043-missing-")),
      "no-such-auth.json",
    );
    expect(() => createHttpServer({ authFile: missing })).toThrow(
      /--auth-file not found/,
    );
  });

  it("throws a clear error when DUCKBRAIN_AUTH_FILE points at a missing file", () => {
    const missing = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "dbgap043-missing-env-")),
      "no-such-auth.json",
    );
    process.env.DUCKBRAIN_AUTH_FILE = missing;
    expect(() => createHttpServer({})).toThrow(/--auth-file not found/);
  });

  it("throws when an explicit auth-file exists but is not valid JSON", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbgap043-badjson-"));
    const bad = path.join(dir, "auth.json");
    fs.writeFileSync(bad, "{ not json");
    expect(() => createHttpServer({ authFile: bad })).toThrow(
      /Could not parse --auth-file/,
    );
  });

  it("accepts an explicit existing auth-file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbgap043-ok-"));
    const authFile = writeScratchAuthFile(dir);
    expect(() => createHttpServer({ authFile })).not.toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("default (unset) behavior is unchanged: never throws, prod file authoritative", () => {
    // Whether or not ~/.duckbrain/auth.json exists on this host, the
    // default path must construct without error (best-effort load).
    expect(() => createHttpServer({})).not.toThrow();
  });
});

/* --------------------------- scratch daemon: prod store stays untouched */

describe("DB-GAP-043 scratch daemon auth-store isolation", () => {
  it("daemon with --auth-file serves auth from the temp file and never touches ~/.duckbrain/auth.json", async () => {
    const port = await findFreePort();
    const { dataDir, nsPath } = prepareDataDir("duckbrain-dbgap043-");
    const authFile = writeScratchAuthFile(dataDir);
    const prodBefore = snapshotProdAuth();

    const child = spawnHttpServer(port, dataDir, nsPath, [
      "--auth=apikey",
      `--auth-file=${authFile}`,
    ]);

    try {
      await waitForHealth(port);

      // No key → 401; wrong key → 401; the temp file's key → 200.
      expect(await httpStatus(port, "/stats")).toBe(401);
      expect(
        await httpStatus(port, "/stats", { "X-API-Key": "sk-wrong-key" }),
      ).toBe(401);
      expect(
        await httpStatus(port, "/stats", { "X-API-Key": SCRATCH_KEY }),
      ).toBe(200);

      child.kill("SIGTERM");
      const code = await waitForClose(child);
      expect(code).toBe(0);

      // The prod auth store must be byte-identical (content + mtime).
      expect(snapshotProdAuth()).toEqual(prodBefore);
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore if already dead
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 90000);

  it("daemon with DUCKBRAIN_AUTH_FILE (env fallback) serves auth from the temp file", async () => {
    const port = await findFreePort();
    const { dataDir, nsPath } = prepareDataDir("duckbrain-dbgap043-env-");
    const authFile = writeScratchAuthFile(dataDir);
    const prodBefore = snapshotProdAuth();

    const child = spawnHttpServer(port, dataDir, nsPath, ["--auth=apikey"], {
      DUCKBRAIN_AUTH_FILE: authFile,
    });

    try {
      await waitForHealth(port);
      expect(await httpStatus(port, "/stats")).toBe(401);
      expect(
        await httpStatus(port, "/stats", { "X-API-Key": SCRATCH_KEY }),
      ).toBe(200);

      child.kill("SIGTERM");
      await waitForClose(child);
      expect(snapshotProdAuth()).toEqual(prodBefore);
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore if already dead
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 90000);

  it("daemon with a missing --auth-file exits nonzero with a clear error and leaves prod untouched", async () => {
    const port = await findFreePort();
    const { dataDir, nsPath } = prepareDataDir("duckbrain-dbgap043-miss-");
    const missing = path.join(dataDir, "does-not-exist.json");
    const prodBefore = snapshotProdAuth();

    const child = spawnHttpServer(port, dataDir, nsPath, [
      "--auth=apikey",
      `--auth-file=${missing}`,
    ]);
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += d.toString()));

    try {
      const code = await waitForClose(child);
      expect(code).not.toBe(0);
      expect(stderr).toContain("--auth-file not found");
      expect(snapshotProdAuth()).toEqual(prodBefore);
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore if already dead
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 90000);
});
