/**
 * Race-safe scratch-daemon helpers for the DuckBrain test suite.
 *
 * DB-GAP-063 (kanban t_7d8b48d3): scratch-daemon rigs used to trust any
 * server that answered /health on the port they picked. A TOCTOU port race
 * — findFreePort() binds :0, closes, and the child binds ~1s later after tsx
 * boot — let a concurrent `listen(0)` on the box (a sibling vitest worker) be
 * handed the same port, so a test's probe POST landed on a FOREIGN auth=none
 * app and read foreign state. Extract of the hardening proven in
 * src/http/routes/memories-namespace-autocreate-nsauto001.test.ts:
 *
 *   1. Ports are drawn from a window the kernel never auto-assigns
 *      (21000-29999; Linux ephemeral is 32768-60999, macOS 49152-65535), so
 *      two test files cannot collide at the source.
 *   2. Every spawn is identity-verified: we pre-create a sentinel namespace
 *      under the daemon's own namespace root and require GET /api/namespaces
 *      to list it before trusting the port. A foreign listener can never
 *      fake the sentinel (the route censuses directories on disk).
 *   3. A child that dies before answering /health is rejected early instead
 *      of burning the readiness budget on a port somebody else owns, and the
 *      identity probe retries a transient 429 (the daemon's default rate
 *      limit can be exhausted by /health polling under load).
 *   4. Teardown rmSync is retried — SIGTERM makes the daemon flush + commit,
 *      which spawns git children that can still be writing inside <ns>/.git
 *      while we walk the tree, so a single rmSync throws ENOTEMPTY from
 *      rmdir (a third, pre-existing flake source). Cleanup of a temp dir must
 *      never red a test: retry briefly, then leave the orphan (harmless).
 */

import { spawnSync, type ChildProcess } from "child_process";
import crypto from "crypto";
import net from "net";
import http from "http";
import fs from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const BIN_PATH = path.join(REPO_ROOT, "bin", "duckbrain.js");

/** Port window OUTSIDE the kernel's ephemeral range. */
export const PORT_WINDOW_MIN = 21000;
export const PORT_WINDOW_MAX = 29999;

function bindCandidate(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Pick a free TCP port the kernel will never hand to anyone else.
 *
 * 1. Private window: the kernel never auto-assigns 21000-29999, so two
 *    concurrent test files cannot collide at the source.
 * 2. Window unusable (tiny box / everything taken) — fall back to the
 *    kernel's own choice; the identity check in assertDaemonIsOurs still
 *    guards whatever slips through.
 */
export async function findFreePort(): Promise<number> {
  const span = PORT_WINDOW_MAX - PORT_WINDOW_MIN + 1;
  for (let attempt = 0; attempt < 200; attempt++) {
    const candidate = PORT_WINDOW_MIN + Math.floor(Math.random() * span);
    if (await bindCandidate(candidate)) return candidate;
  }

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

/**
 * Poll /health until it answers. 200 (healthy), 401 (a fail-closed daemon's
 * liveness is still an answer) and 503 (degraded but UP — GAP-030) all prove
 * the port is serving. When `child` is supplied, a child that exits before
 * answering rejects immediately instead of burning the whole budget on a port
 * somebody else owns.
 */
export function waitForHealth(
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
          if (
            res.statusCode === 200 ||
            res.statusCode === 401 ||
            res.statusCode === 503
          ) {
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

/** Wait for a child to exit (already-exited children resolve immediately). */
export function waitForClose(
  child: ChildProcess,
  timeout = 30000,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
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

/**
 * Create a sentinel namespace directory under `nsPath` and return its name.
 * The sentinel is the identity witness: it exists under THIS daemon's
 * namespace root and nowhere else, and GET /api/namespaces censuses
 * directories on disk, so a foreign listener can never fake it.
 */
export function createSentinelNamespace(nsPath: string, prefix = "scratch-sentinel-"): string {
  const sentinel = `${prefix}${crypto.randomBytes(4).toString("hex")}`;
  fs.mkdirSync(path.join(nsPath, sentinel), { recursive: true });
  return sentinel;
}

/** Everything assertDaemonIsOurs needs to prove a spawn is ours. */
export interface DaemonIdentity {
  port: number;
  child: ChildProcess;
  /** The daemon's namespace root (where the sentinel lives). */
  nsPath: string;
  /** The daemon's data dir (where the per-port pidfile lives). */
  dataDir: string;
  /** Sentinel namespace name, pre-created under `nsPath`. */
  sentinel: string;
  /** API key for apikey-auth'd daemons; undefined for auth=none. */
  token?: string;
}

/**
 * GET /api/namespaces against a scratch daemon, retrying on 429.
 *
 * DB-GAP-063: the scratch daemons run the DEFAULT rate limit (100 req/min),
 * and waitForHealth's /health polling — which runs BEFORE the identity probe —
 * can exhaust the token bucket under load. A 429 here is transient (the
 * bucket refills at ~1.7 tokens/sec), so retry briefly instead of failing.
 */
async function probeNamespaces(
  port: number,
  token: string | undefined,
): Promise<{ status: number; names: string[] }> {
  const headers = token ? { "X-API-Key": token } : {};
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`http://127.0.0.1:${port}/api/namespaces`, {
      headers,
    });
    if (res.status === 200) {
      const body = (await res.json().catch(() => null)) as {
        namespaces?: Array<{ name?: string }>;
      } | null;
      return {
        status: 200,
        names: (body?.namespaces ?? []).map((ns) => ns.name ?? ""),
      };
    }
    res.body?.cancel().catch(() => {});
    if (res.status !== 429) {
      return { status: res.status, names: [] };
    }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  return { status: 429, names: [] };
}

/**
 * Fail unless the server listening on `daemon.port` is the daemon this rig
 * spawned. Verified by asking it to census its namespace root: the sentinel
 * directory created under `nsPath` must be visible. A foreign process that
 * grabbed our port answers without it.
 *
 * Fail-closed daemons (apikey with no valid key, or basic) answer 401 to
 * GET /api/namespaces; for those we fall back to the pidfile — our child
 * writes `<dataDir>/duckbrain-http-<port>.pid` only AFTER a successful bind,
 * so a matching pidfile proves our child owns the port. When even the pidfile
 * cannot exist (DUCKBRAIN_DATA_DIR is a regular file — the ENOTDIR shape),
 * the residual proof is liveness: our child is still running, so it bound the
 * port (EADDRINUSE would have killed it).
 */
export async function assertDaemonIsOurs(daemon: DaemonIdentity): Promise<void> {
  if (daemon.child.exitCode !== null || daemon.child.signalCode !== null) {
    throw new Error(
      `scratch daemon on port ${daemon.port} exited (code ${daemon.child.exitCode}) ` +
        `before it could be verified — a foreign process most likely owns the port`,
    );
  }

  const { status, names } = await probeNamespaces(daemon.port, daemon.token);

  if (status === 200) {
    if (!names.includes(daemon.sentinel)) {
      throw new Error(
        `port ${daemon.port} is not serving this rig's namespace root ` +
          `(${daemon.nsPath}): /api/namespaces (status ${status}) does not ` +
          `list the sentinel '${daemon.sentinel}' — a foreign listener owns the port`,
      );
    }
    return;
  }

  if (status === 429) {
    throw new Error(
      `port ${daemon.port} stayed rate-limited (429) on /api/namespaces`,
    );
  }

  // Fail-closed (401/403): /api/namespaces is behind auth and no valid key
  // exists. Fall back to the pidfile identity proof.
  if (status === 401 || status === 403) {
    const pidFile = path.join(
      daemon.dataDir,
      `duckbrain-http-${daemon.port}.pid`,
    );
    try {
      const pid = fs.readFileSync(pidFile, "utf-8").trim();
      if (pid === String(daemon.child.pid)) {
        // Our child bound the port and wrote its own pidfile.
        return;
      }
    } catch {
      // pidfile missing/unreadable — fall through to liveness.
    }
    // Residual proof (ENOTDIR data dir): our child is still alive, so it
    // bound the port — a foreign listener would have killed it EADDRINUSE.
    if (daemon.child.exitCode === null && daemon.child.signalCode === null) {
      return;
    }
    throw new Error(
      `port ${daemon.port} is fail-closed (${status}) and its pidfile does ` +
        `not name this rig's child — a foreign listener owns the port`,
    );
  }

  throw new Error(
    `unexpected /api/namespaces status ${status} on port ${daemon.port}`,
  );
}

/**
 * Best-effort removal of a temp dir, retried briefly. SIGTERM makes the
 * daemon flush + commit, which spawns git children that can still be writing
 * inside <ns>/.git while we walk the tree — fs.rmSync then throws ENOTEMPTY
 * from rmdir mid-removal. Cleanup of a temp dir must never red a test: retry
 * briefly, then leave the orphan (harmless).
 */
export async function removeTempDirSafely(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

/**
 * Mint a token into a SCRATCH auth store via the DUCKBRAIN_AUTH_FILE
 * redirect — a missing env path is created on first mint and the production
 * store is never touched. The raw 64-hex token is the second stdout line.
 */
export function mintScratchToken(dataDir: string): {
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
