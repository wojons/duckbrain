/**
 * DF-0923-01 Regression Tests: in-flight-push guard in the shared deletion core.
 *
 * Bug (dogfood 2026-09-23): the in-flight-push guard was CLI-only.
 * deleteNamespaceFromDisk (src/namespaces/lifecycle.ts) refused while a push
 * was in flight, but the shared core deleteNamespace
 * (src/namespaces/delete.ts) — called by BOTH the REST route
 * DELETE /api/namespaces/:name and the MCP deleteNamespaceTool — had NO such
 * check. A mid-push delete through REST/MCP could half-land a namespace on
 * S3 (the ghost-manifest state REVIEW-DUCKBRAIN-001 fought: 88 ghost
 * manifests).
 *
 * Regressions guarded:
 *  - a live lock ({pid: <alive>, ts: fresh}) at <nsRoot>/.s3state/.lock
 *    BLOCKS deleteNamespace: success:false, "Push in flight" in error, the
 *    namespace dir and the config mapping survive untouched.
 *  - a stale lock (ts older than the 10-minute window) does NOT block.
 *  - a dead-pid lock does NOT block.
 *  - the REST route surfaces the refusal as HTTP 409 CONFLICT and the
 *    namespace survives.
 *  - the existing guards are unaffected: confirm:true still required, the
 *    default namespace still refused.
 *
 * Isolation: the suite runs under the test-suite temp root
 * (src/test-setup.ts: DUCKBRAIN_NAMESPACES_PATH + DUCKBRAIN_CONFIG_PATH), so
 * no live namespace or the tracked duckbrain.config.json is ever touched.
 * The config snapshot/restore below guards the TEMP config file, never the
 * repo config; env vars are snapshotted/restored so nothing leaks to sibling
 * files in the same worker process.
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { createServer, Server } from "http";
import { createHttpServer } from "../cli/http";
import { getConfig, updateConfig } from "../config/index";
import { isPidAlive } from "../utils/pidfile";
import { deleteNamespace } from "./delete";

// Lazy (NOT module-level consts): beforeAll redirects the env to this file's
// scratch dirs, and module-level consts would capture the worker-level
// test-setup values before that redirect lands.
const CONFIG_PATH = () =>
  process.env.DUCKBRAIN_CONFIG_PATH ||
  path.join(process.cwd(), "duckbrain.config.json");
const NS_ROOT = () => process.env.DUCKBRAIN_NAMESPACES_PATH!;

/** Where the native sync's cross-process lock lives (src/s3/manifest). */
function lockPath(): string {
  return path.join(NS_ROOT(), ".s3state", ".lock");
}

function writeLock(pid: number, ts: number): void {
  fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
  fs.writeFileSync(lockPath(), JSON.stringify({ pid, ts }), "utf-8");
}

function removeLock(): void {
  try {
    fs.unlinkSync(lockPath());
  } catch {
    // already gone
  }
}

/**
 * A pid that is guaranteed NOT alive: spawn a child that exits immediately,
 * then re-use its pid. Retried in the (unlikely) event the kernel recycled
 * the pid before we probe it.
 */
function findDeadPid(): number {
  for (let i = 0; i < 5; i++) {
    const r = spawnSync(process.execPath, ["-e", ""], { timeout: 10_000 });
    if (typeof r.pid === "number" && r.status === 0 && !isPidAlive(r.pid)) {
      return r.pid;
    }
  }
  throw new Error("could not obtain a dead pid for the lock fixture");
}

/** Register a mapping + seed a namespace dir under the redirected root. */
function seedNamespace(name: string): string {
  const dirPath = path.join(NS_ROOT(), name);
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(path.join(dirPath, "current.jsonl"), '{"k":"v"}\n');
  fs.mkdirSync(path.join(dirPath, ".git", "refs"), { recursive: true });
  fs.writeFileSync(
    path.join(dirPath, ".git", "HEAD"),
    "ref: refs/heads/main\n",
  );
  const cfg = getConfig(".");
  updateConfig(".", {
    namespaceMappings: {
      ...(cfg.namespaceMappings ?? {}),
      [name]: dirPath,
    },
  });
  return dirPath;
}

// --- REST harness (mirrors namespaces-delete-dbgap032.test.ts) ---

let server: Server;
let port: number;

interface HttpResponse {
  status: number;
  body: any;
}

function httpRequest(
  method: string,
  pathName: string,
  body?: Record<string, unknown>,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const http = require("http");
    const payload = body ? JSON.stringify(body) : undefined;
    const options: any = {
      hostname: "127.0.0.1",
      port,
      path: pathName,
      method,
      headers: {
        Host: "localhost",
        "Content-Type": "application/json",
        // Node's http client treats DELETE as bodyless (Express 5's
        // express.json() then leaves req.body undefined) — set the framing
        // explicitly, same as the dbgap032 suite.
        ...(payload !== undefined
          ? { "Content-Length": Buffer.byteLength(payload) }
          : {}),
      },
    };
    const req = http.request(options, (res: any) => {
      let data = "";
      res.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

// --- env + config isolation ---

const ENV_KEYS = ["DUCKBRAIN_NAMESPACES_PATH", "DUCKBRAIN_CONFIG_PATH"];
let envSnapshot: Record<string, string | undefined> = {};
let configSnapshot: string;
let scratchTmp: string | undefined;

beforeAll(async () => {
  envSnapshot = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  scratchTmp = fs.mkdtempSync(path.join(os.tmpdir(), "df0923-01-"));
  // Point the suite at a fresh scratch root for this file only.
  process.env.DUCKBRAIN_NAMESPACES_PATH = scratchTmp;
  process.env.DUCKBRAIN_CONFIG_PATH = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "df0923-01-cfg-")),
    "duckbrain.config.json",
  );

  const app = createHttpServer();
  server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr !== "string") port = addr.port;
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
  removeLock();
  // Restore the worker-process env so sibling files are unaffected.
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
});

beforeEach(() => {
  configSnapshot = fs.existsSync(CONFIG_PATH())
    ? fs.readFileSync(CONFIG_PATH(), "utf-8")
    : "";
});

afterEach(() => {
  // Restore the (temp) config file so a test never leaks mappings.
  if (configSnapshot) {
    fs.writeFileSync(CONFIG_PATH(), configSnapshot, "utf-8");
  } else if (fs.existsSync(CONFIG_PATH())) {
    fs.unlinkSync(CONFIG_PATH());
  }
  removeLock();
});

describe("DF-0923-01: in-flight-push guard in the shared deletion core", () => {
  it("BLOCKED: a live, fresh lock refuses deletion and leaves everything intact", () => {
    const name = "df0923-01-blocked";
    const dirPath = seedNamespace(name);
    writeLock(process.pid, Date.now()); // process.pid is alive; ts is fresh

    const result = deleteNamespace(name, true);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Push in flight");
    expect(result.error).toContain(name);
    // Nothing was removed: dir + contents + mapping all survive.
    expect(fs.existsSync(dirPath)).toBe(true);
    expect(fs.existsSync(path.join(dirPath, "current.jsonl"))).toBe(true);
    expect(getConfig(".").namespaceMappings?.[name]).toBeDefined();
  });

  it("STALE LOCK PROCEEDS: a lock older than the 10-minute window does not block", () => {
    const name = "df0923-01-stale";
    const dirPath = seedNamespace(name);
    writeLock(process.pid, Date.now() - 11 * 60 * 1000);

    const result = deleteNamespace(name, true);

    expect(result.success).toBe(true);
    expect(fs.existsSync(dirPath)).toBe(false);
    expect(getConfig(".").namespaceMappings?.[name]).toBeUndefined();
  });

  it("DEAD-PID LOCK PROCEEDS: a lock held by a nonexistent pid does not block", () => {
    const name = "df0923-01-deadpid";
    const dirPath = seedNamespace(name);
    writeLock(findDeadPid(), Date.now());

    const result = deleteNamespace(name, true);

    expect(result.success).toBe(true);
    expect(fs.existsSync(dirPath)).toBe(false);
    expect(getConfig(".").namespaceMappings?.[name]).toBeUndefined();
  });

  it("REST 409: DELETE /api/namespaces/:name surfaces the refusal as 409 CONFLICT", async () => {
    const name = "df0923-01-rest409";
    const created = await httpRequest("POST", "/api/namespaces", {
      name,
      setDefault: false,
    });
    expect(created.status).toBe(201);
    const dirPath = path.join(NS_ROOT(), name);
    expect(fs.existsSync(dirPath)).toBe(true);
    writeLock(process.pid, Date.now());

    const { status, body } = await httpRequest(
      "DELETE",
      `/api/namespaces/${name}`,
      { confirm: true },
    );

    expect(status).toBe(409);
    expect(body.error).toContain("Push in flight");
    // The namespace survives: dir + mapping.
    expect(fs.existsSync(dirPath)).toBe(true);
    const live = JSON.parse(fs.readFileSync(CONFIG_PATH(), "utf-8"));
    expect(live.namespaceMappings[name]).toBeDefined();
  });

  it("existing guards unaffected: confirm still required, default namespace still refused", () => {
    const name = "df0923-01-guards";
    seedNamespace(name);

    const noConfirm = deleteNamespace(name, false);
    expect(noConfirm.success).toBe(false);
    expect(noConfirm.error).toContain("Confirmation required");
    expect(fs.existsSync(path.join(NS_ROOT(), name))).toBe(true);

    // The default namespace is refused regardless of lock state (no lock
    // written here — the confirm/default guards must hold on their own).
    removeLock();
    const def = deleteNamespace("default", true);
    expect(def.success).toBe(false);
  });
});
