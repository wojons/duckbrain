/**
 * REVIEW-DUCKBRAIN-006 regression tests: the CODE default for HTTP auth is
 * apikey, not none.
 *
 * The row: README claimed a fresh daemon requires API-key auth by default
 * while the shipped default was `none` (CLI help "(default: none)",
 * createHttpServer()'s `authType ?? "none"`, live-verified unauthenticated
 * 201 write). AUTH-DEFAULT-001 had closed this only at the deployment layer;
 * the decision (already made) is to flip the CODE default — safety over docs.
 *
 * Contract pinned here, against the REAL spawned daemon
 * (`node bin/duckbrain.js http …`, the same entry the README uses):
 *   1. No --auth at all + an auth store present -> unauthenticated writes are
 *      rejected (401) and a valid key is accepted (201). This is the exact
 *      "fresh daemon" acceptance criterion, live.
 *   2. Explicit --auth=none still boots (loud warning on stderr) and accepts
 *      unauthenticated writes — the intentional local/test opt-out.
 *   3. The unauthenticated-mode warning is NOT printed on the default path
 *      (the default is already fail-closed; the warning would be noise).
 *
 * Hermeticity (auth-file-enforcement-df092407.test.ts pattern): scratch data
 * dir, scratch namespaces path, scratch auth store under os.tmpdir(); the
 * production ~/.duckbrain/auth.json is never touched, and every child is
 * killed by the PID captured from spawn (never a pattern kill).
 */

import { describe, it, expect } from "vitest";
import { spawn, ChildProcess } from "child_process";
import net from "net";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";

const BIN_PATH = path.resolve(__dirname, "..", "..", "bin", "duckbrain.js");
/** Key literal for the scratch store — never a real credential. */
const SCRATCH_KEY = "r".repeat(32);
/** Built by concatenation so no tool display ever mangles this line. */
const AUTH_HEADER = "X-" + "API-" + "Key";
const UNAUTH_WARNING_MARKER = "UNAUTHENTICATED";

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo;
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

/** Poll /health until it answers (200 healthy or 503 degraded = alive). */
function waitForHealth(port: number, timeoutMs = 60000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/health", method: "GET" },
        (res) => {
          res.resume();
          if (res.statusCode === 200 || res.statusCode === 503) {
            resolve();
            return;
          }
          retry();
        },
      );
      req.on("error", retry);
      req.on("timeout", () => {
        req.destroy();
        retry();
      });
      req.end();
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`daemon never became healthy on port ${port}`));
        return;
      }
      setTimeout(attempt, 200);
    };
    attempt();
  });
}

interface StatusReply {
  status: number;
  body: string;
}

/** Arbitrary-method request against a spawned daemon; body echoed raw. */
function requestStatus(
  port: number,
  method: string,
  urlPath: string,
  headers: Record<string, string> = {},
  payload?: string,
): Promise<StatusReply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: {
          Host: "localhost",
          ...(payload !== undefined
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
          ...headers,
        },
        timeout: 5000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 10000);
    child.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function prepareDataDir(prefix: string): { dataDir: string; nsPath: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const nsPath = path.join(dataDir, "namespaces");
  fs.mkdirSync(path.join(nsPath, "default"), { recursive: true });
  return { dataDir, nsPath };
}

/** Scratch auth store holding exactly one unrestricted key. */
function writeScratchAuthFile(dir: string): string {
  const authFile = path.join(dir, "scratch-auth.json");
  fs.writeFileSync(
    authFile,
    JSON.stringify({
      users: [],
      apiKeys: [{ key: SCRATCH_KEY, name: "review-006-scratch" }],
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
    // Fast-fail embedding probe so /health answers promptly (INT-CI-003
    // pattern from tests/helpers.ts).
    DUCKBRAIN_EMBEDDING_PROVIDER: "openai",
    DUCKBRAIN_EMBEDDING_API_KEY: "",
    ...extraEnv,
  };
  // Never inherit another test's store override: this suite proves the
  // no-flag DEFAULT, so an ambient DUCKBRAIN_AUTH_FILE would mask it.
  delete env.DUCKBRAIN_AUTH_FILE;
  if ("DUCKBRAIN_AUTH_FILE" in extraEnv) {
    env.DUCKBRAIN_AUTH_FILE = extraEnv.DUCKBRAIN_AUTH_FILE;
  }
  return spawn(
    process.execPath,
    [BIN_PATH, "http", `--port=${port}`, ...extraArgs],
    { env, stdio: ["pipe", "pipe", "pipe"] },
  );
}

/** The write payload used by every arm (valid schema, distinct key). */
function memoryPayload(key: string): string {
  return JSON.stringify({
    key,
    domain: "raw_note",
    content: "review-006 payload",
  });
}

const WRITE_PATH = "/api/memories?namespace=default";

describe("REVIEW-DUCKBRAIN-006: fresh daemon defaults to apikey (live daemon)", () => {
  it("no --auth + store: keyless write 401, valid key write 201, /health open, silent boot", async () => {
    const port = await findFreePort();
    const { dataDir, nsPath } = prepareDataDir("duckbrain-review006-default-");
    const authFile = writeScratchAuthFile(dataDir);

    // NOTE: no --auth flag at all — this is the fresh-daemon shape.
    const child = spawnHttpServer(port, dataDir, nsPath, [
      `--auth-file=${authFile}`,
    ]);
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += d.toString()));

    try {
      await waitForHealth(port);

      const keylessWrite = await requestStatus(
        port,
        "POST",
        WRITE_PATH,
        {},
        memoryPayload("/review-006/keyless"),
      );
      expect(keylessWrite.status).toBe(401);

      const keyedWrite = await requestStatus(
        port,
        "POST",
        WRITE_PATH,
        { [AUTH_HEADER]: SCRATCH_KEY },
        memoryPayload("/review-006/keyed"),
      );
      expect(keyedWrite.status).toBe(201);

      // The default path is fail-closed, so it must NOT print the
      // unauthenticated-mode warning (nothing was opened).
      expect(stderr).not.toContain(UNAUTH_WARNING_MARKER);
    } finally {
      await killChild(child);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 90000);

  it("explicit --auth=none: boots with the unauthenticated warning and accepts keyless writes", async () => {
    const port = await findFreePort();
    const { dataDir, nsPath } = prepareDataDir("duckbrain-review006-none-");

    const child = spawnHttpServer(port, dataDir, nsPath, ["--auth=none"]);
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += d.toString()));

    try {
      await waitForHealth(port);

      const keylessWrite = await requestStatus(
        port,
        "POST",
        WRITE_PATH,
        {},
        memoryPayload("/review-006/open"),
      );
      expect(keylessWrite.status).toBe(201);

      // The opt-out is honored AND loud — the operator's evidence.
      expect(stderr).toContain(UNAUTH_WARNING_MARKER);
      expect(stderr).toContain("--auth=none");
    } finally {
      await killChild(child);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 90000);

  it("no --auth and no store at all: keyless write still 401 (fail-closed, no credential can be valid)", async () => {
    const port = await findFreePort();
    const { dataDir, nsPath } = prepareDataDir("duckbrain-review006-nostore-");

    const child = spawnHttpServer(port, dataDir, nsPath, []);

    try {
      await waitForHealth(port);

      const keylessWrite = await requestStatus(
        port,
        "POST",
        WRITE_PATH,
        {},
        memoryPayload("/review-006/nostore"),
      );
      expect(keylessWrite.status).toBe(401);

      // Liveness stays unauthenticated by design.
      const health = await requestStatus(port, "GET", "/health");
      expect([200, 503]).toContain(health.status);
    } finally {
      await killChild(child);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 90000);
});
