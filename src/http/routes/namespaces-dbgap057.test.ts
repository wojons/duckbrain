/**
 * DB-GAP-057 regression tests: namespace registry split-brain.
 *
 * Incident (2026-09-22, be129bc / GAP-062): the HTTP/MCP create path started
 * passing the NAMESPACES ROOT as registerNamespace()'s configDir. That first
 * argument is the CONFIG DIRECTORY, so HTTP + MCP creates materialized a
 * stray `<nsRoot>/duckbrain.config.json` (prod: namespaces/duckbrain.config.json,
 * ~17k mappings of auger test garbage) instead of writing the mapping into
 * the config file at the duckbrain ROOT — the only file GET /api/namespaces
 * reads (getConfig(".") → resolveDuckbrainRoot()). Result: every HTTP/MCP
 * create since 09-22 returned 201 while the namespace never appeared in the
 * listing (live damage: auger AUG-051, 106 pytest setup errors on 409
 * "already exists" retries).
 *
 * Why the existing suite could never catch this: src/test-setup.ts sets
 * DUCKBRAIN_CONFIG_PATH, and getConfigPath() returns that override for ANY
 * configDir argument — masking which directory the prod code path would have
 * used. The seam tests below therefore redirect with DUCKBRAIN_HOME_ROOT
 * instead (prod-shaped: no config-path override; the config file lives at
 * <root>/duckbrain.config.json) and pin:
 *
 *   AC-1: POST 201 → immediate GET lists the namespace (REAL spawned daemon);
 *   AC-2: the mapping lands in <root>/duckbrain.config.json and NO stray
 *         namespaces/duckbrain.config.json appears;
 *   AC-3: GET /api/namespaces unions the config registry with the on-disk
 *         census, flagging drift BOTH directions (onDiskOnly rows +
 *         directoryMissing rows) with top-level drift counts (omitted when
 *         clean — healthy-rows-omit-fields REG-GONE-001 style).
 *
 * Hermeticity: the daemon runs with DUCKBRAIN_HOME_ROOT / DUCKBRAIN_DATA_DIR
 * / --auth-file all in temp dirs and DUCKBRAIN_CONFIG_PATH +
 * DUCKBRAIN_NAMESPACES_PATH explicitly REMOVED from the child env (that
 * override is what masks the bug). The repo's tracked config, the repo's
 * namespaces/ directory, ~/.duckbrain/auth.json and the production :3000
 * daemon are never touched; no network beyond 127.0.0.1. Teardown kills ONLY
 * this suite's child pid — never pkill.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import express, { Request, Response, NextFunction } from "express";
import { createServer } from "http";
import { spawn, type ChildProcess } from "child_process";
import net from "net";
import fs from "fs";
import os from "os";
import path from "path";

import { createNamespaceTool } from "../../mcp/tools/namespace";
import { CONFIG_FILENAME, registerNamespace } from "../../config";
import { createNamespaceRoutes } from "./namespaces";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const BIN_PATH = path.join(REPO_ROOT, "bin", "duckbrain.js");
const SCRATCH_KEY = "sk-scr-dbgap057";

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
      fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      })
        .then((res) => {
          res.body?.cancel().catch(() => {});
          if (res.status === 200 || res.status === 503) {
            resolve();
            return;
          }
          retry();
        })
        .catch(retry);
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

function writeScratchAuthFile(dir: string): string {
  const authFile = path.join(dir, "scratch-auth.json");
  fs.writeFileSync(
    authFile,
    JSON.stringify({
      users: [],
      apiKeys: [{ key: SCRATCH_KEY, name: "scratch-dbgap057" }],
    }),
  );
  return authFile;
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/namespaces", createNamespaceRoutes);
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || 500;
    res.status(status).json({
      error: err.message || "Internal server error",
      code: err.code,
    });
  });
  return app;
}

function httpRequest(
  app: express.Express,
  method: string,
  apiPath: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr !== "string" ? addr.port : 0;
      const http = require("http");
      const options: any = {
        hostname: "127.0.0.1",
        port,
        path: apiPath,
        method,
        headers: { Host: "localhost", "Content-Type": "application/json" },
        // Node's http client sends request bodies chunked; an explicit
        // Content-Length makes express.json() parse the body.
        ...(body
          ? { "Content-Length": Buffer.byteLength(JSON.stringify(body)) }
          : {}),
      };
      const req = http.request(options, (res: any) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          server.close();
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      });
      req.on("error", (err: Error) => {
        server.close();
        reject(err);
      });
      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  });
}

/* --------------------------------------------- AC-1/AC-2: live daemon test */

describe("DB-GAP-057: live daemon create → immediate list (scratch root)", () => {
  let port: number;
  let scratchRoot: string;
  let dataDir: string;
  let nsPath: string;
  let daemon: ChildProcess | undefined;

  beforeAll(async () => {
    port = await findFreePort();
    scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dbgap057-root-"));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbgap057-data-"));
    nsPath = path.join(scratchRoot, "namespaces");
    // Seed the default namespace the way prod always has it (dir + mapping),
    // so the drift census measures only what these tests create.
    fs.mkdirSync(path.join(nsPath, "default"), { recursive: true });
    fs.writeFileSync(
      path.join(scratchRoot, CONFIG_FILENAME),
      JSON.stringify({
        namespacesPath: "./namespaces",
        namespaceMappings: {
          default: path.join(nsPath, "default"),
        },
      }) + "\n",
    );
    const authFile = writeScratchAuthFile(dataDir);

    // Prod-shaped env: DUCKBRAIN_CONFIG_PATH / DUCKBRAIN_NAMESPACES_PATH are
    // REMOVED (the override is what masks the bug in the vitest env) and the
    // duckbrain root is pinned via DUCKBRAIN_HOME_ROOT — the config file the
    // daemon reads/writes is <scratchRoot>/duckbrain.config.json.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.DUCKBRAIN_CONFIG_PATH;
    delete env.DUCKBRAIN_NAMESPACES_PATH;
    delete env.DUCKBRAIN_AUTH_FILE;
    env.DUCKBRAIN_HOME_ROOT = scratchRoot;
    env.DUCKBRAIN_DATA_DIR = dataDir;
    env.NO_COLOR = "1";
    // Fast-fail embedding probe so /health answers promptly
    // (tests/helpers.ts INT-CI-003 pattern).
    env.DUCKBRAIN_EMBEDDING_PROVIDER = "openai";
    env.DUCKBRAIN_EMBEDDING_API_KEY = "";

    daemon = spawn(
      process.execPath,
      [
        BIN_PATH,
        "http",
        `--port=${port}`,
        "--auth=apikey",
        `--auth-file=${authFile}`,
      ],
      // cwd IS part of the pin: getConfig(".") resolves its fallback
      // `<cwd>/duckbrain.config.json` against the process cwd (the same
      // cwd-relative semantics prod relies on), so the daemon must run FROM
      // the scratch root or the list half would read the repo's real config
      // (observed: prod-shaped 23 directoryMissing rows leaking in). The
      // DUCKBRAIN_CONFIG_PATH redirect would mask the seam instead of
      // pinning it — the override wins for ANY configDir, which is exactly
      // why the split-brain survived the whole suite.
      { env, stdio: "pipe", cwd: scratchRoot },
    );
    await waitForHealth(port);
  }, 60000);

  afterAll(async () => {
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
    fs.rmSync(scratchRoot, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }, 30000);

  it("AC-1: POST 201 → immediate GET lists the namespace (the auger failure shape)", async () => {
    const headers = {
      "Content-Type": "application/json",
      "X-API-Key": SCRATCH_KEY,
    };
    const created = await fetch(`http://127.0.0.1:${port}/api/namespaces`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "dbgap057-live" }),
    });
    expect(created.status).toBe(201);
    await created.body?.cancel().catch(() => {});

    // Immediate GET — no sleep. The bug made the namespace invisible here.
    const listed = await fetch(`http://127.0.0.1:${port}/api/namespaces`, {
      headers: { "X-API-Key": SCRATCH_KEY },
    });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      namespaces: Array<{ name: string; path: string }>;
      drift?: unknown;
    };
    const row = body.namespaces.find((n: any) => n.name === "dbgap057-live");
    expect(row).toBeDefined();
    expect(row?.path).toBe(path.join(nsPath, "dbgap057-live"));

    // Clean scratch: no drift counts (drift omitted when clean — the
    // healthy-rows-omit-fields REG-GONE-001 style, pinned here at the
    // response level).
    expect(body.drift).toBeUndefined();
  });

  it("AC-2: mapping lands in the ROOT config; no stray namespaces/duckbrain.config.json", async () => {
    const headers = {
      "Content-Type": "application/json",
      "X-API-Key": SCRATCH_KEY,
    };
    const created = await fetch(`http://127.0.0.1:${port}/api/namespaces`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "dbgap057-default",
        setDefault: true,
      }),
    });
    expect(created.status).toBe(201);
    await created.body?.cancel().catch(() => {});

    // The config file the list half reads holds the mappings.
    const rootConfig = (await fs.promises
      .readFile(path.join(scratchRoot, CONFIG_FILENAME), "utf-8")
      .then((raw) => JSON.parse(raw))) as {
      namespaceMappings: Record<string, string>;
      defaultNamespace?: string;
    };
    expect(rootConfig.namespaceMappings["dbgap057-live"]).toBe(
      path.join(nsPath, "dbgap057-live"),
    );
    expect(rootConfig.namespaceMappings["dbgap057-default"]).toBe(
      path.join(nsPath, "dbgap057-default"),
    );
    expect(rootConfig.defaultNamespace).toBe("dbgap057-default");

    // THE defect marker: no stray config inside the namespaces root.
    expect(fs.existsSync(path.join(nsPath, CONFIG_FILENAME))).toBe(false);
  });
});

/* ----------------------------------- seam unit: createNamespaceTool (root) */

describe("DB-GAP-057: createNamespaceTool registers against the duckbrain ROOT", () => {
  let scratchRoot: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dbgap057-unit-"));
    fs.mkdirSync(path.join(scratchRoot, "namespaces"), { recursive: true });
    // Swap to the prod-shaped redirect: no config-path override (that would
    // mask which directory the register write targets), root pinned via
    // DUCKBRAIN_HOME_ROOT, namespaces derived from the config's own
    // namespacesPath ("./namespaces").
    savedEnv = {
      DUCKBRAIN_CONFIG_PATH: process.env.DUCKBRAIN_CONFIG_PATH,
      DUCKBRAIN_NAMESPACES_PATH: process.env.DUCKBRAIN_NAMESPACES_PATH,
      DUCKBRAIN_HOME_ROOT: process.env.DUCKBRAIN_HOME_ROOT,
    };
    delete process.env.DUCKBRAIN_CONFIG_PATH;
    delete process.env.DUCKBRAIN_NAMESPACES_PATH;
    process.env.DUCKBRAIN_HOME_ROOT = scratchRoot;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  });

  it("AC-2: mapping written to <root>/duckbrain.config.json; no stray namespaces/duckbrain.config.json; GAP-062 dir placement unchanged", async () => {
    const result = await createNamespaceTool({
      name: "dbgap057-unit",
      setDefault: false,
    });
    expect(result.success).toBe(true);

    const nsPath = path.join(scratchRoot, "namespaces", "dbgap057-unit");
    expect(result.path).toBe(nsPath);

    // Directory still lands under the namespaces root (GAP-062 intact).
    expect(fs.existsSync(nsPath)).toBe(true);
    expect(fs.existsSync(path.join(nsPath, "manifest.json"))).toBe(true);

    // Mapping lands in the ROOT config — the file getConfig(".") reads.
    const rootConfig = JSON.parse(
      fs.readFileSync(path.join(scratchRoot, CONFIG_FILENAME), "utf-8"),
    );
    expect(rootConfig.namespaceMappings["dbgap057-unit"]).toBe(nsPath);

    // THE defect marker: no stray config inside the namespaces root.
    expect(
      fs.existsSync(path.join(scratchRoot, "namespaces", CONFIG_FILENAME)),
    ).toBe(false);
  });

  it("setDefault writes defaultNamespace into the ROOT config", async () => {
    const result = await createNamespaceTool({
      name: "dbgap057-def",
      setDefault: true,
    });
    expect(result.success).toBe(true);

    const rootConfig = (await fs.promises
      .readFile(path.join(scratchRoot, CONFIG_FILENAME), "utf-8")
      .then((raw) => JSON.parse(raw))) as { defaultNamespace?: string };
    expect(rootConfig.defaultNamespace).toBe("dbgap057-def");
    expect(
      fs.existsSync(path.join(scratchRoot, "namespaces", CONFIG_FILENAME)),
    ).toBe(false);
  });
});

/* ----------------------------- AC-3: union listing + drift flags (GET) */

describe("DB-GAP-057: GET /api/namespaces unions on-disk census with config rows", () => {
  let tmpRoot: string;
  let nsRoot: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dbgap057-union-"));
    nsRoot = path.join(tmpRoot, "namespaces");
    fs.mkdirSync(nsRoot, { recursive: true });
    // Seed the default namespace the way prod always has it (dir + mapping):
    // the real listNamespacesTool auto-unshifts a synthetic "default" row
    // when it is absent from the registry, and a synthetic row without a
    // directory would pollute the drift census this suite measures.
    fs.mkdirSync(path.join(nsRoot, "default"), { recursive: true });
    registerNamespace(".", "default", path.join(nsRoot, "default"));

    savedEnv = {
      DUCKBRAIN_CONFIG_PATH: process.env.DUCKBRAIN_CONFIG_PATH,
      DUCKBRAIN_NAMESPACES_PATH: process.env.DUCKBRAIN_NAMESPACES_PATH,
    };
    process.env.DUCKBRAIN_CONFIG_PATH = path.join(tmpRoot, CONFIG_FILENAME);
    process.env.DUCKBRAIN_NAMESPACES_PATH = nsRoot;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("AC-3: onDiskOnly rows for unmapped dirs, directoryMissing rows for dead mappings, drift counts for both", async () => {
    // (a) config-listed namespace WITH directory → healthy, no flags.
    fs.mkdirSync(path.join(nsRoot, "healthy"), { recursive: true });
    registerNamespace(".", "healthy", path.join(nsRoot, "healthy"));

    // (b) mapping with NO directory → directoryMissing (REG-GONE-001 kept).
    registerNamespace(".", "ghost", path.join(nsRoot, "ghost"));

    // (c) directory with NO mapping → onDiskOnly (DB-GAP-057).
    fs.mkdirSync(path.join(nsRoot, "ondisk-only"), { recursive: true });

    // Noise the census must skip: a hidden dir (.s3state) and the stray
    // config FILE the be129bc bug produced in prod (a file, not a dir).
    fs.mkdirSync(path.join(nsRoot, ".s3state"), { recursive: true });
    fs.writeFileSync(path.join(nsRoot, CONFIG_FILENAME), "{}\n");

    const app = createApp();
    const { status, body } = await httpRequest(app, "GET", "/api/namespaces");

    expect(status).toBe(200);
    const byName = new Map<string, any>(
      body.namespaces.map((n: any) => [n.name, n]),
    );

    // (a) healthy: no flags.
    const healthy = byName.get("healthy");
    expect(healthy).toBeDefined();
    expect(healthy).not.toHaveProperty("directoryMissing");
    expect(healthy).not.toHaveProperty("onDiskOnly");

    // (b) dead mapping: directoryMissing only.
    const ghost = byName.get("ghost");
    expect(ghost).toBeDefined();
    expect(ghost.directoryMissing).toBe(true);
    expect(ghost).not.toHaveProperty("onDiskOnly");

    // (c) unmapped dir: onDiskOnly row with the root-derived path.
    const onDisk = byName.get("ondisk-only");
    expect(onDisk).toBeDefined();
    expect(onDisk.onDiskOnly).toBe(true);
    expect(onDisk.isDefault).toBe(false);
    expect(onDisk.path).toBe(path.join(nsRoot, "ondisk-only"));

    // Census skips hidden dirs and non-directories.
    expect(byName.has(".s3state")).toBe(false);
    expect(byName.has(CONFIG_FILENAME)).toBe(false);

    // Top-level drift counts, both directions.
    expect(body.drift).toEqual({ onDiskOnly: 1, directoryMissing: 1 });
  });

  it("REG-GONE-001 semantics survive the union: healthy rows stay flag-free when drift exists elsewhere", async () => {
    fs.mkdirSync(path.join(nsRoot, "healthy"), { recursive: true });
    registerNamespace(".", "healthy", path.join(nsRoot, "healthy"));
    // Drift in both directions (unmapped dir + dead mapping)...
    registerNamespace(".", "ghost", path.join(nsRoot, "ghost"));
    fs.mkdirSync(path.join(nsRoot, "ondisk-only"), { recursive: true });

    const app = createApp();
    const { status, body } = await httpRequest(app, "GET", "/api/namespaces");

    expect(status).toBe(200);
    const healthy = body.namespaces.find((n: any) => n.name === "healthy");
    expect(healthy).toBeDefined();
    expect(healthy).not.toHaveProperty("directoryMissing");
    expect(healthy).not.toHaveProperty("onDiskOnly");
  });
});
