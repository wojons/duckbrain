/**
 * DF-0924-07 regression tests: an explicit auth store (--auth-file flag or
 * DUCKBRAIN_AUTH_FILE env) implies apikey enforcement on the HTTP daemon.
 *
 * Defect (reproduced 2026-09-24 on a scratch daemon, node bin/duckbrain.js
 * http --port=<p> --auth-file=<store> with NO --auth flag): the DB-GAP-043
 * block in createHttpServer loaded a FileAuthStore into authConfig.store but
 * never set authConfig.type, so authMiddleware mounted the NoneAuthBackend
 * and the daemon served everything unauthenticated (keyless GET /api/memories
 * -> 200 full data, keyless POST -> 201 created). The DB-GAP-043 scratch
 * daemon tests always passed --auth=apikey explicitly, which is why the gap
 * survived them.
 *
 * Fix contract pinned here:
 *   1. Explicit store (flag or env) + resolved type "none" -> type becomes
 *      "apikey" and a loud boot banner goes to stderr.
 *   2. An operator-set explicit type (--auth=basic) wins — no auto-flip;
 *      the store still loads and binds.
 *   3. Default (no flag, no env): REVIEW-DUCKBRAIN-006 flipped this from
 *      "none" to "apikey" — no auto-flip banner (nothing was auto-enabled),
 *      keyless reads/writes 401, /health stays open.
 *   4. On an auto-enabled daemon: keyless /api/* -> 401, valid key -> 200,
 *      valid-but-ungranted key -> 403, wrong key -> 401, /health stays open.
 *
 * Hermeticity mirrors auth-file.test.ts (DB-GAP-043): scratch data/namespaces
 * dirs under os.tmpdir(), scratch auth store, daemons killed by PID captured
 * from spawn, DUCKBRAIN_AUTH_FILE env hygiene saved/restored, the prod
 * ~/.duckbrain/auth.json is never written (default-mode daemon never
 * authenticates, so the store is only read; auto-enable applies to EXPLICIT
 * stores only).
 */
// @ts-nocheck


import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, ChildProcess } from "child_process";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { createHttpServer } from "./http";
import {
  findFreePort,
  waitForHealth,
  waitForClose,
  assertDaemonIsOurs,
  createSentinelNamespace,
  removeTempDirSafely,
} from "../testing/race-safe-daemon";

const BIN_PATH = path.resolve(__dirname, "..", "..", "bin", "duckbrain.js");
const KEY = "sk-df092407-scratch-key";
const WRONG_KEY = "sk-df092407-wrong-key";
const OTHER_NS_KEY = "sk-df092407-scoped-key";
const BANNER_MARKER = "auto-enabling apikey authentication";

/* ---------------------------------------------------------------- helpers */

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

function prepareDataDir(prefix: string): { dataDir: string; nsPath: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const nsPath = path.join(dataDir, "namespaces");
  fs.mkdirSync(path.join(nsPath, "default"), { recursive: true });
  return { dataDir, nsPath };
}

/**
 * Scratch auth store: one unrestricted key (full access), one scoped to a
 * namespace the scratch data dir never contains (for the 403 arm).
 */
function writeScratchAuthFile(dir: string): string {
  const authFile = path.join(dir, "scratch-auth.json");
  fs.writeFileSync(
    authFile,
    JSON.stringify({
      users: [],
      apiKeys: [
        { key: KEY, name: "df092407-scratch" },
        {
          key: OTHER_NS_KEY,
          name: "df092407-scoped",
          namespaces: ["other-ns"],
        },
      ],
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

/** Kill a spawned daemon in a finally block, never by pattern. */
async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await waitForClose(child, 5000);
  } catch {
    child.kill("SIGKILL");
  }
}

/* ------------------- scratch daemons: enforcement + banner (AC1a, AC1c) */

describe("DF-0924-07 scratch daemons: auth-file implies apikey", () => {
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

  it("flag form: --auth-file without --auth enforces apikey (keyless 401, valid 200, ungranted 403, /health open)", async () => {
    const port = await findFreePort();
    const { dataDir, nsPath } = prepareDataDir("duckbrain-df092407-flag-");
    const sentinel = createSentinelNamespace(nsPath);
    const authFile = writeScratchAuthFile(dataDir);

    const child = spawnHttpServer(port, dataDir, nsPath, [
      `--auth-file=${authFile}`,
    ]);

    try {
      await waitForHealth(port, 30000, child);
      await assertDaemonIsOurs({
        port,
        child,
        nsPath,
        dataDir,
        sentinel,
        token: KEY,
      });

      // The defect: keyless requests served full data (GET 200, POST 201).
      const keylessGet = await requestStatus(port, "GET", "/api/memories");
      expect(keylessGet.status).toBe(401);

      const keylessPost = await requestStatus(
        port,
        "POST",
        "/api/memories",
        {},
        JSON.stringify({
          key: "/df092407/keyless",
          domain: "raw_note",
          content: "must be rejected",
        }),
      );
      expect(keylessPost.status).toBe(401);

      // Wrong key -> 401 (existing apikey semantics).
      expect(
        (
          await requestStatus(port, "GET", "/api/memories", {
            "X-API-Key": WRONG_KEY,
          })
        ).status,
      ).toBe(401);

      // Valid store key -> 200 on reads, 201 on writes.
      expect(
        (
          await requestStatus(port, "GET", "/api/memories", {
            "X-API-Key": KEY,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await requestStatus(
            port,
            "POST",
            "/api/memories",
            { "X-API-Key": KEY },
            JSON.stringify({
              key: "/df092407/authed",
              domain: "raw_note",
              content: "authed write",
            }),
          )
        ).status,
      ).toBe(201);

      // Valid-but-ungranted key (scoped to another namespace) -> 403.
      expect(
        (
          await requestStatus(port, "GET", "/api/memories", {
            "X-API-Key": OTHER_NS_KEY,
          })
        ).status,
      ).toBe(403);

      // /health remains unauthenticated (existing bypass). 503 = GAP-030
      // "degraded but UP" (embedding probe off in scratch daemons); either
      // way the request reached the health handler instead of a 401.
      const healthStatus = (await requestStatus(port, "GET", "/health")).status;
      expect([200, 503]).toContain(healthStatus);

      await killChild(child);
    } finally {
      await killChild(child);
      await removeTempDirSafely(dataDir);
    }
  }, 90000);

  it("env form: DUCKBRAIN_AUTH_FILE alone enforces apikey (keyless 401, key 200, no auto-flip banner)", async () => {
    const port = await findFreePort();
    const { dataDir, nsPath } = prepareDataDir("duckbrain-df092407-env-");
    const sentinel = createSentinelNamespace(nsPath);
    const authFile = writeScratchAuthFile(dataDir);

    const child = spawnHttpServer(port, dataDir, nsPath, [], {
      DUCKBRAIN_AUTH_FILE: authFile,
    });
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += d.toString()));

    try {
      await waitForHealth(port, 30000, child);
      await assertDaemonIsOurs({
        port,
        child,
        nsPath,
        dataDir,
        sentinel,
        token: KEY,
      });

      expect((await requestStatus(port, "GET", "/api/memories")).status).toBe(
        401,
      );
      expect(
        (
          await requestStatus(port, "GET", "/api/memories", {
            "X-API-Key": KEY,
          })
        ).status,
      ).toBe(200);

      // REVIEW-DUCKBRAIN-006: the CLI default is apikey, so the auto-flip
      // banner no longer fires on this shape — there is nothing to
      // auto-enable (the resolved type was already apikey, not "none"). The
      // explicit-none arm below keeps the DF-0924-07 banner covered.
      expect(stderr).not.toContain(BANNER_MARKER);
      // The default path must not claim the daemon is open either.
      expect(stderr).not.toContain("UNAUTHENTICATED");

      await killChild(child);
    } finally {
      await killChild(child);
      await removeTempDirSafely(dataDir);
    }
  }, 90000);

  it("explicit --auth=none + --auth-file still auto-enables apikey and prints the banner", async () => {
    const port = await findFreePort();
    const { dataDir, nsPath } = prepareDataDir("duckbrain-df092407-none-flip-");
    const sentinel = createSentinelNamespace(nsPath);
    const authFile = writeScratchAuthFile(dataDir);

    // The DF-0924-07 protection: an operator-set type "none" plus an explicit
    // store must NOT serve unauthenticated requests. REVIEW-DUCKBRAIN-006
    // changed the DEFAULT, not this guard.
    const child = spawnHttpServer(port, dataDir, nsPath, [
      "--auth=none",
      `--auth-file=${authFile}`,
    ]);
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += d.toString()));

    try {
      await waitForHealth(port, 30000, child);
      await assertDaemonIsOurs({
        port,
        child,
        nsPath,
        dataDir,
        sentinel,
        token: KEY,
      });

      expect((await requestStatus(port, "GET", "/api/memories")).status).toBe(
        401,
      );
      expect(
        (
          await requestStatus(port, "GET", "/api/memories", {
            "X-API-Key": KEY,
          })
        ).status,
      ).toBe(200);

      // Both messages are expected here: the opt-out warning (the operator
      // asked for none) and the auto-flip banner (the store overrode it).
      expect(stderr).toContain(BANNER_MARKER);
      expect(stderr).toContain("UNAUTHENTICATED");

      await killChild(child);
    } finally {
      await killChild(child);
      await removeTempDirSafely(dataDir);
    }
  }, 90000);

  it("explicit --auth=basic wins: no auto-flip banner, basic auth enforced, store still loads", async () => {
    const port = await findFreePort();
    const { dataDir, nsPath } = prepareDataDir("duckbrain-df092407-basic-");
    const sentinel = createSentinelNamespace(nsPath);
    const authFile = writeScratchAuthFile(dataDir);

    const child = spawnHttpServer(port, dataDir, nsPath, [
      "--auth=basic",
      `--auth-file=${authFile}`,
    ]);
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += d.toString()));

    try {
      await waitForHealth(port, 30000, child);
      await assertDaemonIsOurs({
        port,
        child,
        nsPath,
        dataDir,
        sentinel,
      });

      // No auto-enable banner: the operator's explicit type wins.
      expect(stderr).not.toContain(BANNER_MARKER);

      // Basic backend mounted: API-key requests are rejected (an apikey or
      // none backend would answer 200/401-by-key), and bad basic creds 401.
      expect(
        (
          await requestStatus(port, "GET", "/api/memories", {
            "X-API-Key": KEY,
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await requestStatus(port, "GET", "/api/memories", {
            Authorization: `Basic ${Buffer.from("admin:wrongpass").toString("base64")}`,
          })
        ).status,
      ).toBe(401);

      await killChild(child);
    } finally {
      await killChild(child);
      await removeTempDirSafely(dataDir);
    }
  }, 90000);

  it("default (no flag, no env) is fail-closed apikey: keyless read/write 401, /health open, no banner", async () => {
    const port = await findFreePort();
    const { dataDir, nsPath } = prepareDataDir("duckbrain-df092407-default-");
    const sentinel = createSentinelNamespace(nsPath);

    const child = spawnHttpServer(port, dataDir, nsPath, []);
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += d.toString()));

    try {
      await waitForHealth(port, 30000, child);
      await assertDaemonIsOurs({
        port,
        child,
        nsPath,
        dataDir,
        sentinel,
      });

      // REVIEW-DUCKBRAIN-006: the CLI default is apikey, so the production
      // startup shape (no --auth flag at all) rejects reads AND writes. No
      // auto-flip banner: nothing was auto-enabled, the default already is
      // apikey on this path.
      expect(stderr).not.toContain(BANNER_MARKER);
      expect((await requestStatus(port, "GET", "/api/memories")).status).toBe(
        401,
      );

      const keylessWrite = await requestStatus(
        port,
        "POST",
        "/api/memories?namespace=default",
        {},
        JSON.stringify({
          key: "/df092407/default-flip",
          domain: "raw_note",
          content: "must not land",
        }),
      );
      expect(keylessWrite.status).toBe(401);

      // /health stays pre-auth: liveness answers on a locked daemon.
      const healthStatus = (await requestStatus(port, "GET", "/health")).status;
      expect([200, 503]).toContain(healthStatus);

      await killChild(child);
    } finally {
      await killChild(child);
      await removeTempDirSafely(dataDir);
    }
  }, 90000);
});

/* -------------- in-process: bin-shaped createHttpServer calls (AC1a, AC1b) */

describe("DF-0924-07 createHttpServer: bin-shaped option pairs", () => {
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

  /** In-process server on an ephemeral port; caller closes it. */
  async function startInProcess(
    options: Parameters<typeof createHttpServer>[0],
  ): Promise<{ server: http.Server; port: number }> {
    const app = createHttpServer(options);
    const server = http.createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("no TCP address");
    }
    return { server, port: address.port };
  }

  function close(server: http.Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
  }

  it('authType "none" (an explicit opt-out) + authFile still enforces apikey', async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-df092407-unit-"),
    );
    const nsPath = path.join(dir, "namespaces");
    fs.mkdirSync(path.join(nsPath, "default"), { recursive: true });
    const authFile = writeScratchAuthFile(dir);

    // An explicit --auth=none (the operator opt-out) is still fail-closed
    // when an auth store is supplied: REVIEW-DUCKBRAIN-006 flipped the CLI
    // DEFAULT to apikey, but the DF-0924-07 auto-flip must keep protecting
    // callers that pass type none on purpose. This is that option shape.
    const { server, port } = await startInProcess({
      authType: "none",
      authFile,
      namespacesPath: nsPath,
    });
    try {
      const keyless = await fetch(`http://127.0.0.1:${port}/api/memories`, {
        headers: { Host: "localhost" },
      });
      expect(keyless.status).toBe(401);

      const authed = await fetch(`http://127.0.0.1:${port}/api/memories`, {
        headers: { Host: "localhost", "X-API-Key": KEY },
      });
      expect(authed.status).toBe(200);
    } finally {
      await close(server);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("authType basic + authFile keeps type basic (no auto-flip)", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-df092407-unit-basic-"),
    );
    const nsPath = path.join(dir, "namespaces");
    fs.mkdirSync(path.join(nsPath, "default"), { recursive: true });
    const authFile = writeScratchAuthFile(dir);

    const { server, port } = await startInProcess({
      authType: "basic",
      authFile,
      namespacesPath: nsPath,
    });
    try {
      // A mounted apikey backend would accept the store key; none would pass
      // everything. Only the basic backend rejects an X-API-Key request.
      const withApiKeyHeader = await fetch(
        `http://127.0.0.1:${port}/api/memories`,
        { headers: { Host: "localhost", "X-API-Key": KEY } },
      );
      expect(withApiKeyHeader.status).toBe(401);
    } finally {
      await close(server);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("DUCKBRAIN_AUTH_FILE env alone (no flag) enforces apikey", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-df092407-unit-env-"),
    );
    const nsPath = path.join(dir, "namespaces");
    fs.mkdirSync(path.join(nsPath, "default"), { recursive: true });
    const authFile = writeScratchAuthFile(dir);

    process.env.DUCKBRAIN_AUTH_FILE = authFile;
    try {
      const { server, port } = await startInProcess({
        namespacesPath: nsPath,
      });
      try {
        const keyless = await fetch(`http://127.0.0.1:${port}/api/memories`, {
          headers: { Host: "localhost" },
        });
        expect(keyless.status).toBe(401);

        const authed = await fetch(`http://127.0.0.1:${port}/api/memories`, {
          headers: { Host: "localhost", "X-API-Key": KEY },
        });
        expect(authed.status).toBe(200);
      } finally {
        await close(server);
      }
    } finally {
      delete process.env.DUCKBRAIN_AUTH_FILE;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
