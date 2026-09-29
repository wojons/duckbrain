/**
 * NAMESPACE-AUTOCREATE-001 Regression Tests: typo'd ?namespace= must be LOUD,
 * and strict mode must refuse it.
 *
 * Root cause: POST /api/memories?namespace=ghostns on a fresh daemon returned
 * 201 and silently created the namespace directory + git init
 * (src/mcp/tools/remember.ts mkdirSync recursive). The README quickstart
 * implies explicit POST /api/namespaces creation, so a typo'd namespace
 * scattered memories across a directory nobody meant to create, with no
 * error, no marker, and no log line.
 *
 * Design constraint (fleet doctrine): this daemon SERVES THE FLEET — many
 * lanes write to legit namespaces over HTTP, so auto-create stays ON by
 * default (no breaking change). The fix makes the legacy behavior LOUD and
 * adds an OPT-OUT:
 *
 *  1. Default (unchanged writes): a write to a non-existent namespace still
 *     returns 201, but the response carries `namespace_autocreated: true`
 *     (absent when the namespace already existed) and the daemon logs a
 *     `[namespace-autocreate]` WARN — a typo is now visible in both the
 *     response body and the daemon log.
 *  2. Strict mode (opt-in): `DUCKBRAIN_NAMESPACES_AUTOCREATE=false` (or
 *     `"namespaces": { "autoCreate": false }` in duckbrain.config.json)
 *     makes a write to a non-existent namespace fail with 404
 *     NAMESPACE_NOT_FOUND — reusing the serializer's existing error code →
 *     HTTP mapping (throwWriteError) — and creates NO directory. The error
 *     message keeps the legacy "does not exist" substring so existing
 *     grep-based clients keep matching.
 *  3. Only "true"/"false" are accepted; anything else fails config load
 *     (same doctrine as DUCKBRAIN_DURABILITY_MODE — a typo'd toggle must not
 *     silently fall back to either side of a data-integrity knob).
 *
 * Hermeticity (DB-GAP-045 / DF-0919-05 pattern): unit legs run in-process on
 * the vitest scratch root (src/test-setup.ts redirects
 * DUCKBRAIN_NAMESPACES_PATH / DUCKBRAIN_CONFIG_PATH per worker). The REST
 * legs run against REAL scratch daemons on unique free ports with
 * DUCKBRAIN_DATA_DIR / DUCKBRAIN_NAMESPACES_PATH / DUCKBRAIN_AUTH_FILE all
 * in temp dirs; tokens are minted with `duckbrain token` against the scratch
 * auth file only. Teardown kills ONLY this suite's child pids — never
 * `pkill`, never the production :3000 daemon. No production namespace; no
 * network beyond 127.0.0.1.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import net from "net";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { rememberTool } from "../../mcp/tools/remember";
import { getConfig, resolveDuckbrainRoot } from "../../config/index";

/* ============================================================ unit legs */

const AUTO_ENV = "DUCKBRAIN_NAMESPACES_AUTOCREATE";

function scratchNsPath(ns: string): string {
  return path.join(process.env.DUCKBRAIN_NAMESPACES_PATH!, ns);
}

afterAll(() => {
  delete process.env[AUTO_ENV];
});

describe("NAMESPACE-AUTOCREATE-001: rememberTool autocreate policy (unit)", () => {
  it("(a) write to a fresh namespace succeeds AND is loud: marker + WARN", async () => {
    const ns = "nsauto001-unit-fresh";
    const warnSpy = vi.spyOn(console, "warn");
    try {
      expect(fs.existsSync(scratchNsPath(ns))).toBe(false);

      const write = await rememberTool({
        key: "/nsauto001/fresh",
        domain: "concept",
        attributes: {},
        embedding_text: "autocreate probe write",
        author: "test@example.com",
        namespace: ns,
      });

      expect(write.success).toBe(true);
      // THE marker: the 201/HTTP body surfaces this as
      // namespace_autocreated: true.
      expect(write.namespace_autocreated).toBe(true);
      // The side effect still happened (legacy behavior preserved).
      expect(fs.existsSync(scratchNsPath(ns))).toBe(true);
      // LOUD: the daemon/operator log carries the WARN.
      const warnText = warnSpy.mock.calls
        .map((args) => args.join(" "))
        .join("\n");
      expect(warnText).toContain("[namespace-autocreate]");
      expect(warnText).toContain(ns);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("(b) write to an EXISTING namespace carries no marker (existing writers unaffected)", async () => {
    const ns = "test-ns"; // pre-created by src/test-setup.ts
    expect(fs.existsSync(scratchNsPath(ns))).toBe(true);

    const write = await rememberTool({
      key: "/nsauto001/existing",
      domain: "concept",
      attributes: {},
      embedding_text: "existing namespace probe write",
      author: "test@example.com",
      namespace: ns,
    });

    expect(write.success).toBe(true);
    expect(write.namespace_autocreated).toBeUndefined();
  });

  it("(c) strict mode: write to a non-existent namespace fails NAMESPACE_NOT_FOUND, no dir created", async () => {
    const ns = "nsauto001-unit-strict";
    process.env[AUTO_ENV] = "false";
    try {
      expect(fs.existsSync(scratchNsPath(ns))).toBe(false);

      const write = await rememberTool({
        key: "/nsauto001/strict",
        domain: "concept",
        attributes: {},
        embedding_text: "strict mode probe write",
        author: "test@example.com",
        namespace: ns,
      });

      expect(write.success).toBe(false);
      // The serializer error code — throwWriteError already maps this to 404.
      expect(write.code).toBe("NAMESPACE_NOT_FOUND");
      // Legacy grep compatibility: existing clients match "does not exist".
      expect(write.error).toContain("does not exist");
      expect(write.error).toContain(ns);
      // NOTHING was created.
      expect(fs.existsSync(scratchNsPath(ns))).toBe(false);
    } finally {
      delete process.env[AUTO_ENV];
    }
  });

  it("(d) strict mode does not touch an EXISTING namespace write", async () => {
    const ns = "test-ns";
    process.env[AUTO_ENV] = "false";
    try {
      const write = await rememberTool({
        key: "/nsauto001/strict-existing",
        domain: "concept",
        attributes: {},
        embedding_text: "strict mode existing-ns probe write",
        author: "test@example.com",
        namespace: ns,
      });
      expect(write.success).toBe(true);
      expect(write.namespace_autocreated).toBeUndefined();
    } finally {
      delete process.env[AUTO_ENV];
    }
  });

  it("(e) malformed toggle value fails config load — no silent fallback", () => {
    process.env[AUTO_ENV] = "flase";
    try {
      expect(() => getConfig(resolveDuckbrainRoot())).toThrow(
        /DUCKBRAIN_NAMESPACES_AUTOCREATE/,
      );
    } finally {
      delete process.env[AUTO_ENV];
    }
  });
});

/* ============================================================ REST legs */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const BIN_PATH = path.join(REPO_ROOT, "bin", "duckbrain.js");

const EXISTING_NS = "nsauto001-rest";
const TYPO_NS = "nsauto001-rest-typo";

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
          // Embedding provider intentionally degraded (openai + empty key):
          // /health answers 503 — accept it as live (DOGFOOD-025 pattern).
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

interface ScratchDaemon {
  port: number;
  dataDir: string;
  token: string;
  child: ChildProcess;
  stderrText: string;
}

/**
 * Spawn one scratch daemon. `strict` flips DUCKBRAIN_NAMESPACES_AUTOCREATE.
 * `preExistingNamespaces` are created on disk BEFORE boot so writes to them
 * take the not-autocreated path.
 */
async function spawnScratchDaemon(
  prefix: string,
  strict: boolean,
  preExistingNamespaces: string[],
): Promise<ScratchDaemon> {
  const port = await findFreePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const nsPath = path.join(dataDir, "namespaces");
  for (const ns of preExistingNamespaces) {
    fs.mkdirSync(path.join(nsPath, ns), { recursive: true });
  }
  const { authFile, token } = mintScratchToken(dataDir);

  const child = spawn(
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
        ...(strict ? { [AUTO_ENV]: "false" } : {}),
        NO_COLOR: "1",
        // Fast-fail embedding probe so /health answers promptly.
        DUCKBRAIN_EMBEDDING_PROVIDER: "openai",
        DUCKBRAIN_EMBEDDING_API_KEY: "",
      },
      stdio: "pipe",
    },
  );
  const daemon: ScratchDaemon = {
    port,
    dataDir,
    token,
    child,
    stderrText: "",
  };
  (child.stderr as NonNullable<typeof child.stderr>).on(
    "data",
    (chunk: Buffer) => {
      daemon.stderrText += chunk.toString();
    },
  );
  await waitForHealth(port);
  return daemon;
}

async function killScratchDaemon(daemon: ScratchDaemon): Promise<void> {
  // Kill ONLY this suite's child pid — never pkill, never :3000.
  try {
    if (daemon.child.exitCode === null) daemon.child.kill("SIGTERM");
    await waitForClose(daemon.child);
  } catch {
    try {
      daemon.child.kill("SIGKILL");
    } catch {
      // already dead
    }
  }
  fs.rmSync(daemon.dataDir, { recursive: true, force: true });
}

async function postMemory(
  daemon: ScratchDaemon,
  namespace: string,
): Promise<{ status: number; body: any }> {
  const res = await fetch(
    `http://127.0.0.1:${daemon.port}/api/memories?namespace=${namespace}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": daemon.token,
      },
      body: JSON.stringify({
        key: `/${namespace}/probe`,
        domain: "concept",
        content: `namespace-autocreate probe write for ${namespace}`,
      }),
    },
  );
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

function daemonNsDir(daemon: ScratchDaemon, ns: string): string {
  return path.join(daemon.dataDir, "namespaces", ns);
}

describe("NAMESPACE-AUTOCREATE-001: REST POST /api/memories namespace policy", () => {
  let lenient: ScratchDaemon; // default behavior (autocreate on)
  let strict: ScratchDaemon; // DUCKBRAIN_NAMESPACES_AUTOCREATE=false

  beforeAll(async () => {
    lenient = await spawnScratchDaemon(
      "duckbrain-nsauto-lenient-",
      false,
      // default namespace pre-exists so leg (g) exercises the
      // already-existed path, not an autocreation.
      [EXISTING_NS],
    );
    strict = await spawnScratchDaemon("duckbrain-nsauto-strict-", true, []);
  }, 120000);

  afterAll(async () => {
    if (lenient) await killScratchDaemon(lenient);
    if (strict) await killScratchDaemon(strict);
  }, 60000);

  it("(f) POST to a typo'd namespace → 201 + namespace_autocreated:true + WARN in the daemon log", async () => {
    expect(fs.existsSync(daemonNsDir(lenient, TYPO_NS))).toBe(false);

    const post = await postMemory(lenient, TYPO_NS);

    // Legacy compatibility: the write still succeeds (201), never breaks.
    expect(post.status).toBe(201);
    // THE marker: a typo'd namespace is now visible in the response body.
    expect(post.body.namespace_autocreated).toBe(true);
    // LOUD on the daemon side too.
    const deadline = Date.now() + 10000;
    while (
      !lenient.stderrText.includes("[namespace-autocreate]") &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(lenient.stderrText).toContain("[namespace-autocreate]");
    expect(lenient.stderrText).toContain(TYPO_NS);
    // The side effect still happened.
    expect(fs.existsSync(daemonNsDir(lenient, TYPO_NS))).toBe(true);
  }, 30000);

  it("(g) POST to an existing namespace → 201 with NO marker (existing writers unaffected)", async () => {
    const post = await postMemory(lenient, EXISTING_NS);
    expect(post.status).toBe(201);
    expect(post.body.namespace_autocreated).toBeUndefined();
    // Sanity: the memory really was written to the existing namespace.
    const list = await fetch(
      `http://127.0.0.1:${lenient.port}/api/memories?namespace=${EXISTING_NS}&prefix=/${EXISTING_NS}/probe`,
      { headers: { "X-API-Key": lenient.token } },
    );
    const listBody = (await list.json()) as { items?: unknown[] };
    expect(list.status).toBe(200);
    expect(listBody.items ?? []).toHaveLength(1);
  }, 30000);

  it("(h) strict daemon: POST to a non-existent namespace → 404 NAMESPACE_NOT_FOUND, no dir created", async () => {
    expect(fs.existsSync(daemonNsDir(strict, TYPO_NS))).toBe(false);

    const post = await postMemory(strict, TYPO_NS);

    expect(post.status).toBe(404);
    expect(post.body.code ?? post.body.error?.code).toBe("NAMESPACE_NOT_FOUND");
    // Legacy grep compatibility on the wire.
    expect(JSON.stringify(post.body)).toContain("does not exist");
    // NOTHING was created — no scattered namespace dir.
    expect(fs.existsSync(daemonNsDir(strict, TYPO_NS))).toBe(false);
  }, 30000);

  it("(i) strict daemon: POST to an existing namespace still succeeds (strict only gates creation)", async () => {
    const strictWithNs = await spawnScratchDaemon(
      "duckbrain-nsauto-strict2-",
      true,
      [EXISTING_NS],
    );
    try {
      const post = await postMemory(strictWithNs, EXISTING_NS);
      expect(post.status).toBe(201);
      expect(post.body.namespace_autocreated).toBeUndefined();
    } finally {
      await killScratchDaemon(strictWithNs);
    }
  }, 60000);
});
