/**
 * DB-GAP-045 regression tests: same-key concurrent write survivorship and
 * ACK fidelity on POST /api/memories.
 *
 * Dogfood race (ops/dogfood-e2e.sh phase 4, 2026-09-13): 4 concurrent POSTs
 * to one key all ACKed 201 and all 4 versions were stored — append-only
 * multi-version, never last-write-wins (SUPA-2 spec section "Same-key
 * survivorship and version ordering"). But the 201 body's `timestamp` was
 * FABRICATED BY THE ROUTE (a response-time stamp, memories.ts POST "/")
 * while the stored row kept the writer's own timestamp — a client could not
 * correlate its ACK with the stored version by the id+timestamp pair.
 *
 * Pinned here against a REAL scratch daemon:
 *
 *  (a) 4 concurrent same-key POSTs each return 201 with a distinct `id`
 *      (nothing overwritten, nothing collapsed);
 *  (b) each ACK's `id` + `timestamp` pair equals the version the list route
 *      returns for that `id` — THE DB-GAP-045 assertion (RED before the
 *      route echoed the persisted timestamp);
 *  (c) the list route returns exactly 4 non-tombstone versions for the key;
 *  (d) two consecutive list calls return an identical `id` order
 *      (deterministic per dataset under `timestamp DESC, id ASC`).
 *
 * Hermeticity: the daemon runs on a unique free port with DUCKBRAIN_DATA_DIR
 * / DUCKBRAIN_NAMESPACES_PATH / DUCKBRAIN_AUTH_FILE all in a temp dir; the
 * auth store is created with `duckbrain token --name=test` against the
 * scratch path only. Teardown kills ONLY this suite's child pid — never
 * `pkill -f duckbrain`, never the production :3000 daemon. No production
 * namespace; no network beyond 127.0.0.1.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import net from "net";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const BIN_PATH = path.join(REPO_ROOT, "bin", "duckbrain.js");

const NS = "dbgap045";
const KEY = "/dbgap045/same-key";
const KEY_PREFIX = "/dbgap045/same-key";
const CONCURRENCY = 4;

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
          // The embedding provider is intentionally degraded (openai +
          // empty key), so /health answers 503 — accept it as live
          // (DOGFOOD-025 fast-fail pattern).
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

function prepareDataDir(prefix: string): { dataDir: string; nsPath: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const nsPath = path.join(dataDir, "namespaces");
  fs.mkdirSync(path.join(nsPath, NS), { recursive: true });
  return { dataDir, nsPath };
}

/**
 * Mint a token into a SCRATCH auth store via the DUCKBRAIN_AUTH_FILE
 * redirect — a missing env path is created on first mint and the production
 * store is never touched (DOGFOOD-026 semantics). The raw token is printed
 * once on stdout ("Generated API token:" then the 64-hex token).
 */
function mintScratchToken(dataDir: string): {
  authFile: string;
  token: string;
} {
  const authFile = path.join(dataDir, "scratch-auth.json");
  const res = spawnSync(process.execPath, [BIN_PATH, "token", "--name=test"], {
    env: { ...process.env, DUCKBRAIN_AUTH_FILE: authFile },
    encoding: "utf-8",
  });
  if (res.status !== 0) {
    throw new Error(`token mint failed (${res.status}): ${res.stderr}`);
  }
  const lines = res.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const token = lines[1] ?? "";
  if (!/^[0-9a-f]{64}$/.test(token)) {
    throw new Error(
      `could not parse raw token from mint output: ${JSON.stringify(res.stdout)}`,
    );
  }
  return { authFile, token };
}

/* ----------------------------------------------------------------- tests */

describe("DB-GAP-045: same-key concurrent write survivorship + ACK fidelity", () => {
  let port: number;
  let dataDir: string;
  let nsPath: string;
  let token: string;
  let daemon: ChildProcess | undefined;

  beforeAll(async () => {
    port = await findFreePort();
    ({ dataDir, nsPath } = prepareDataDir("duckbrain-dbgap045-"));
    const { authFile, token: minted } = mintScratchToken(dataDir);
    token = minted;

    daemon = spawn(
      process.execPath,
      [
        BIN_PATH,
        "http",
        `--port=${port}`,
        "--auth=apikey",
        `--auth-file=${authFile}`,
      ],
      {
        env: {
          ...process.env,
          DUCKBRAIN_DATA_DIR: dataDir,
          DUCKBRAIN_NAMESPACES_PATH: nsPath,
          NO_COLOR: "1",
          // Fast-fail embedding probe so /health answers promptly
          // (tests/helpers.ts INT-CI-003 pattern).
          DUCKBRAIN_EMBEDDING_PROVIDER: "openai",
          DUCKBRAIN_EMBEDDING_API_KEY: "",
        },
        stdio: "pipe",
      },
    );
    await waitForHealth(port);
  }, 60000);

  afterAll(async () => {
    // Kill ONLY this suite's child pid — never pkill, never :3000.
    if (daemon) {
      try {
        if (daemon.exitCode === null) daemon.kill("SIGTERM");
        await waitForClose(daemon);
      } catch {
        try {
          daemon.kill("SIGKILL");
        } catch {
          // already dead
        }
      }
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }, 30000);

  async function postMemory(
    content: string,
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/memories?namespace=${NS}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": token,
        },
        body: JSON.stringify({
          key: KEY,
          domain: "concept",
          content,
        }),
      },
    );
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  async function listVersions(): Promise<{ status: number; body: any }> {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/memories?namespace=${NS}` +
        `&prefix=${encodeURIComponent(KEY_PREFIX)}&limit=50`,
      { headers: { "X-API-Key": token } },
    );
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  it(
    "(a) 4 concurrent same-key POSTs all 201 with distinct ids; " +
      "(b) each ACK id+timestamp pair matches the stored version; " +
      "(c) exactly 4 non-tombstone versions survive; " +
      "(d) list order is deterministic across calls",
    async () => {
      // (a) the race — fire CONCURRENCY same-key writes concurrently.
      const acks = await Promise.all(
        Array.from({ length: CONCURRENCY }, (_, i) =>
          postMemory(`dbgap045 same-key concurrent write v${i + 1}`),
        ),
      );
      for (const ack of acks) {
        expect(ack.status).toBe(201);
      }
      const ids = acks.map((ack) => ack.body.id as string);
      expect(new Set(ids).size).toBe(CONCURRENCY);

      // (b) DB-GAP-045: every ACK's id+timestamp pair equals the stored
      // version the list route returns for that id.
      const first = await listVersions();
      expect(first.status).toBe(200);
      const items = first.body.items as Array<Record<string, unknown>>;
      const byId = new Map(items.map((m) => [m.id as string, m]));
      for (const ack of acks) {
        const stored = byId.get(ack.body.id);
        expect(
          stored,
          `list route must return the version for ACK id ${ack.body.id}`,
        ).toBeDefined();
        // THE load-bearing assertion: pre-fix, the route stamped a
        // response-time value that differs from the persisted row.
        expect(stored!.timestamp).toBe(ack.body.timestamp);
      }

      // (c) append-only multi-version: no overwrite, no collapse, no
      // tombstone — exactly CONCURRENCY versions for the key.
      expect(items).toHaveLength(CONCURRENCY);
      expect(items.every((m) => m.key === KEY)).toBe(true);
      expect(items.every((m) => m.isTombstone === false)).toBe(true);
      expect(items.every((m) => m.action === "add")).toBe(true);
      expect(first.body.total).toBe(CONCURRENCY);

      // (d) deterministic order: two consecutive list calls return the
      // same id order (timestamp DESC, id ASC is stable per dataset).
      const second = await listVersions();
      expect(second.status).toBe(200);
      expect(
        (second.body.items as Array<Record<string, unknown>>).map((m) => m.id),
      ).toEqual(items.map((m) => m.id));
    },
    30000,
  );
});
