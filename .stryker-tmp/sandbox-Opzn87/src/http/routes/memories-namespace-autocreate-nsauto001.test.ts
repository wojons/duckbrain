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
 *
 * Port discipline (t_7d8b48d3 / DB-GAP-063): a free port is not OURS until
 * our child binds it, and another `listen(0)` on the box can be handed the
 * same port in that window (CI run 37074375725 attempt 1: the "strict" leg
 * talked to a foreign auth=none app in a sibling worker and read
 * namespace_autocreated: true — green on the same tree at attempt 2). Ports
 * are therefore drawn from a window the kernel never auto-assigns, and every
 * spawn is identity-verified against a sentinel namespace before it is used.
 */
// @ts-nocheck


import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import crypto from "crypto";
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

/**
 * Port window OUTSIDE the kernel's ephemeral range (Linux 32768-60999,
 * macOS 49152-65535).
 *
 * t_7d8b48d3 / DB-GAP-063: binding :0 hands back a port from that shared
 * ephemeral pool, and the port only becomes OURS ~1s later when the child
 * binds it — any concurrent `listen(0)` on the box (sibling test files in
 * this very suite do it, e.g. src/cli/cli-security.test.ts) can be handed
 * the same port in that window. Drawing from a window the kernel never
 * auto-assigns removes the collision at the source; `assertDaemonIsOurs()`
 * below is the hard guard for whatever still slips through.
 */
const PORT_WINDOW_MIN = 21000;
const PORT_WINDOW_MAX = 29999;

/** How many times a spawn may be re-attempted before the rig gives up. */
const SCRATCH_DAEMON_ATTEMPTS = 3;
/** Per-attempt readiness budget (NOT per test): boot is ~1-2s. */
const SCRATCH_DAEMON_READY_MS = 15000;

/**
 * TEST-ONLY seam: when set, the next findFreePort() returns this port
 * verbatim. Used by the port-race regression test below to force a collision
 * with a foreign listener deterministically.
 */
let forcedPortForNextSpawn: number | null = null;

function bindCandidate(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function findFreePort(): Promise<number> {
  if (forcedPortForNextSpawn !== null) {
    const forced = forcedPortForNextSpawn;
    forcedPortForNextSpawn = null;
    return forced;
  }

  // 1. Private window: the kernel never auto-assigns these to anyone else.
  const span = PORT_WINDOW_MAX - PORT_WINDOW_MIN + 1;
  for (let attempt = 0; attempt < 200; attempt++) {
    const candidate = PORT_WINDOW_MIN + Math.floor(Math.random() * span);
    if (await bindCandidate(candidate)) return candidate;
  }

  // 2. Window unusable (tiny box / everything taken) — the kernel's own
  //    choice again; the identity check in spawnScratchDaemon still guards it.
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

function waitForHealth(
  port: number,
  timeout = 30000,
  child?: ChildProcess,
): Promise<void> {
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
      // t_7d8b48d3: a dead child can never answer — fail over to a fresh port
      // instead of burning the whole readiness budget on a port somebody else
      // already owns.
      if (child && (child.exitCode !== null || child.signalCode !== null)) {
        reject(
          new Error(
            `scratch daemon exited (code ${child.exitCode}) before it answered ` +
              `/health on port ${port} — most likely EADDRINUSE from a port race`,
          ),
        );
        return;
      }
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
    // t_7d8b48d3: an already-exited child never emits 'close' again, so a late
    // listener would hang for the full timeout. Observed when re-rolling a
    // scratch daemon whose bind had failed with EADDRINUSE.
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
      return;
    }
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
  nsPath: string;
  /** Identity witness: a namespace only THIS daemon's root has. */
  sentinel: string;
  token: string;
  child: ChildProcess;
  stderrText: string;
}

/**
 * Spawn one VERIFIED scratch daemon. `strict` flips
 * DUCKBRAIN_NAMESPACES_AUTOCREATE. `preExistingNamespaces` are created on
 * disk BEFORE boot so writes to them take the not-autocreated path.
 *
 * t_7d8b48d3 / DB-GAP-063 — why readiness alone is not enough:
 * `findFreePort()` releases the port before the child binds it (~1s of tsx
 * boot), so a concurrent `listen(0)` on the box can be handed the same port.
 * On CI (run 37074375725 attempt 1) leg (i)'s STRICT child died with
 * EADDRINUSE, `/health` was answered by a foreign auth=none app running in
 * another vitest worker (src/cli/cli-security.test.ts does exactly that with
 * `listen(0)`), the probe POST landed on that app — whose namespace root was
 * the *worker's* test-setup root, not this rig's — and the response was
 * 201 + `namespace_autocreated: true`, i.e. the assertion under test failed
 * even though the strict daemon never answered. Attempt 2 of the same run was
 * green on byte-identical tree content.
 *
 * Each attempt therefore proves the IDENTITY of the process behind the port
 * (it must serve a sentinel namespace only this spawn created) and re-rolls a
 * fresh port otherwise.
 */
async function spawnScratchDaemon(
  prefix: string,
  strict: boolean,
  preExistingNamespaces: string[],
): Promise<ScratchDaemon> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= SCRATCH_DAEMON_ATTEMPTS; attempt++) {
    const daemon = await spawnScratchDaemonOnce(
      prefix,
      strict,
      preExistingNamespaces,
    );
    try {
      await waitForHealth(daemon.port, SCRATCH_DAEMON_READY_MS, daemon.child);
      await assertDaemonIsOurs(daemon);
      return daemon;
    } catch (error) {
      lastError = error;
      await killScratchDaemon(daemon);
    }
  }
  throw new Error(
    `could not obtain a verified scratch daemon after ` +
      `${SCRATCH_DAEMON_ATTEMPTS} attempts: ` +
      `${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function spawnScratchDaemonOnce(
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
  // Identity witness: a namespace that exists under THIS root and nowhere
  // else. `/api/namespaces` censuses the directories on disk, so a foreign
  // listener can never fake it.
  const sentinel = `nsauto001-sentinel-${crypto.randomBytes(4).toString("hex")}`;
  fs.mkdirSync(path.join(nsPath, sentinel), { recursive: true });
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
    nsPath,
    sentinel,
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
  return daemon;
}

/**
 * Fail unless the server listening on `daemon.port` is the daemon this rig
 * spawned. Verified by asking it to census its namespace root: the sentinel
 * directory created under `daemon.nsPath` must be visible. A foreign process
 * that grabbed our port (another test file's `listen(0)`, an unrelated
 * service) answers without it — and, for an auth=none listener, would happily
 * accept our probe write and mutate its own storage instead.
 */
async function assertDaemonIsOurs(daemon: ScratchDaemon): Promise<void> {
  if (daemon.child.exitCode !== null || daemon.child.signalCode !== null) {
    throw new Error(
      `scratch daemon on port ${daemon.port} exited (code ` +
        `${daemon.child.exitCode}) before it could be verified — a foreign ` +
        `process most likely owns the port`,
    );
  }
  const res = await fetch(`http://127.0.0.1:${daemon.port}/api/namespaces`, {
    headers: { "X-API-Key": daemon.token },
  });
  const body = (await res.json().catch(() => null)) as {
    namespaces?: Array<{ name?: string }>;
  } | null;
  const names = (body?.namespaces ?? []).map((ns) => ns.name);
  if (!names.includes(daemon.sentinel)) {
    throw new Error(
      `port ${daemon.port} is not serving this rig's namespace root ` +
        `(${daemon.nsPath}): /api/namespaces (status ${res.status}) does not ` +
        `list the sentinel '${daemon.sentinel}' — a foreign listener owns the port`,
    );
  }
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
  // t_7d8b48d3: SIGTERM makes the daemon flush + commit, which spawns git
  // children that can still be writing inside <ns>/.git while we walk the
  // tree — fs.rmSync then throws ENOTEMPTY from rmdir mid-removal (observed
  // on the PRE-fix file too, 2 of 4 loaded runs; a third flake source in this
  // suite). Cleanup of a temp dir must never red a test: retry briefly, then
  // leave it (an orphaned temp dir is harmless, a false red is not).
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(daemon.dataDir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
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

/* ==================================================== port-race regression */

/**
 * t_7d8b48d3 regression: the rig must never trust a server just because it
 * answers /health on the port we picked.
 *
 * This leg recreates the CI race deterministically — a FOREIGN auth=none
 * daemon (its own namespace root, none of our namespaces) squats the port the
 * rig is about to hand to its child — and asserts spawnScratchDaemon()
 * rejects the impostor and re-rolls onto a port it can prove it owns.
 *
 * Without the identity check this reproduces the CI failure byte for byte:
 * the strict child dies with EADDRINUSE, /health is answered by the foreign
 * app, and the POST comes back 201 + namespace_autocreated: true (CI run
 * 37074375725 attempt 1, leg (i)).
 */
describe("NAMESPACE-AUTOCREATE-001: scratch-daemon rig rejects a foreign listener (port race)", () => {
  it("(j) a squatter on the assigned port is rejected and the spawn lands on a verified port", async () => {
    const foreignData = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-nsauto-foreign-"),
    );
    const foreignNs = path.join(foreignData, "namespaces");
    fs.mkdirSync(foreignNs, { recursive: true });
    const foreignPort = await findFreePort();
    const foreign = spawn(
      process.execPath,
      [BIN_PATH, "http", `--port=${foreignPort}`, "--auth=none"],
      {
        env: {
          ...process.env,
          DUCKBRAIN_DATA_DIR: foreignData,
          DUCKBRAIN_NAMESPACES_PATH: foreignNs,
          NO_COLOR: "1",
          DUCKBRAIN_EMBEDDING_PROVIDER: "openai",
          DUCKBRAIN_EMBEDDING_API_KEY: "",
        },
        stdio: "pipe",
      },
    );
    let daemon: ScratchDaemon | null = null;
    try {
      await waitForHealth(foreignPort, 30000, foreign);
      // The rig is now told this port is free — exactly the state findFreePort
      // left behind on CI just before the foreign app was handed the port.
      forcedPortForNextSpawn = foreignPort;

      daemon = await spawnScratchDaemon("duckbrain-nsauto-racetest-", true, [
        EXISTING_NS,
      ]);

      // It re-rolled instead of trusting the squatter.
      expect(daemon.port).not.toBe(foreignPort);
      // ...and the daemon it kept is provably ours: the strict daemon sees the
      // namespace this rig pre-created, so the write is NOT an autocreation.
      const post = await postMemory(daemon, EXISTING_NS);
      expect(post.status).toBe(201);
      expect(post.body.namespace_autocreated).toBeUndefined();
      // The foreign listener's root never received our write.
      expect(fs.existsSync(path.join(foreignNs, EXISTING_NS))).toBe(false);
    } finally {
      forcedPortForNextSpawn = null;
      if (daemon) await killScratchDaemon(daemon);
      if (foreign.exitCode === null && foreign.signalCode === null) {
        foreign.kill("SIGTERM");
      }
      fs.rmSync(foreignData, { recursive: true, force: true });
    }
  }, 120000);
});
