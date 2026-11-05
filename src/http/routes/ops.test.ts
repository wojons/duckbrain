/**
 * SURFACE-HTTP-OPS-001: the operations surface.
 *
 * These tests drive the REAL implementations behind /api/ops (no mocked
 * prune/consolidate/s3 core) against a temp config + temp namespaces root, so
 * a passing test means the daemon would actually have done the work:
 *
 *   1. prune is a DRY RUN by default — the registry file is byte-identical
 *      after a call that did not ask to write;
 *   2. a real prune refuses without `confirm: true`, then removes exactly the
 *      dead mappings and reports before/after counts;
 *   3. every ops route requires the admin role (a writer token gets 403);
 *   4. the lifecycle ledger carries one line per run with op + principal;
 *   5. s3 status returns the CLI's report shape (`enabled:false` when S3 is
 *      off, registered+census rows when it is on), with no network when
 *      `probe=false`;
 *   6. consolidate reports real per-namespace counts and writes nothing;
 *   7. the CLI-only verbs are ABSENT from the router and DOCUMENTED — the
 *      decision file and the route table cannot drift apart.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import express, { Request, Response, NextFunction } from "express";
import { createServer, Server } from "http";

import { authMiddleware, type AuthConfig } from "../../auth/middleware";
import { createOpsRoutes } from "./ops";
import { createCompactionRoutes } from "./compaction";

const AUTH_CONFIG: AuthConfig = {
  type: "apikey",
  apiKeys: [
    { key: "admin-key", name: "ops-admin", roles: ["admin"] },
    { key: "writer-key", name: "ops-writer", roles: ["writer"], namespaces: ["live"] },
  ],
};

const ENV_KEYS = ["DUCKBRAIN_CONFIG_PATH", "DUCKBRAIN_NAMESPACES_PATH", "DUCKBRAIN_HOME_ROOT"] as const;

let tmpDir: string;
let nsRoot: string;
let cfgFile: string;
let envSnapshot: Record<string, string | undefined>;
let server: Server;
let port: number;

function mountApp(): express.Express {
  const app = express();
  app.use(authMiddleware(AUTH_CONFIG));
  app.use(express.json());
  app.use("/api/ops", createOpsRoutes);
  app.use("/api/compaction", createCompactionRoutes);
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.status || 500).json({
      error: err.message || "Internal server error",
      ...(err.code ? { code: err.code } : {}),
    });
  });
  return app;
}

function writeConfig(extra: Record<string, unknown> = {}): void {
  const mappings: Record<string, string> = {
    live: path.join(nsRoot, "live"),
    dead: path.join(nsRoot, "dead"),
  };
  fs.writeFileSync(
    cfgFile,
    JSON.stringify(
      { namespacesPath: nsRoot, namespaceMappings: mappings, ...extra },
      null,
      2,
    ),
    "utf-8",
  );
}

function readConfig(): any {
  return JSON.parse(fs.readFileSync(cfgFile, "utf-8"));
}

function lifecycleLines(): any[] {
  const file = path.join(nsRoot, ".s3state", "lifecycle.log");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function httpRequest(
  method: string,
  urlPath: string,
  opts: { key?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const http = require("http");
    const options: any = {
      hostname: "127.0.0.1",
      port,
      path: urlPath,
      method,
      headers: {
        Host: "localhost",
        ...(opts.key ? { "X-API-Key": opts.key } : {}),
      },
    };
    if (opts.body !== undefined) options.headers["Content-Type"] = "application/json";
    const req = http.request(options, (res: any) => {
      let data = "";
      res.on("data", (c: Buffer) => (data += c.toString()));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
    if (opts.body !== undefined) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

function seedConsolidateDay(): void {
  const nsPath = path.join(nsRoot, "live");
  fs.mkdirSync(path.join(nsPath, "concept", "2026-11"), { recursive: true });
  fs.writeFileSync(
    path.join(nsPath, "manifest.json"),
    JSON.stringify({ partitions: ["concept/2026-11"] }),
    "utf-8",
  );
  const rows = [
    {
      id: "r1",
      key: "/live/one",
      domain: "concept",
      timestamp: "2026-11-04T08:00:00.000Z",
      author: "agent",
      action: "remember",
      embedding_text: "same text",
    },
    {
      id: "r2",
      key: "/live/two",
      domain: "concept",
      timestamp: "2026-11-04T09:00:00.000Z",
      author: "agent",
      action: "remember",
      embedding_text: "same text",
    },
    {
      id: "r3",
      key: "/live/three",
      domain: "concept",
      timestamp: "2026-11-04T10:00:00.000Z",
      author: "agent",
      action: "remember",
      embedding_text: "different text",
    },
  ];
  fs.writeFileSync(
    path.join(nsPath, "concept", "2026-11", "current.jsonl"),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf-8",
  );
}

beforeEach(async () => {
  envSnapshot = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])) as Record<
    string,
    string | undefined
  >;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-surface-001-"));
  nsRoot = path.join(tmpDir, "namespaces");
  fs.mkdirSync(path.join(nsRoot, "live"), { recursive: true });
  cfgFile = path.join(tmpDir, "duckbrain.config.json");
  process.env.DUCKBRAIN_CONFIG_PATH = cfgFile;
  process.env.DUCKBRAIN_NAMESPACES_PATH = nsRoot;
  delete process.env.DUCKBRAIN_HOME_ROOT;
  writeConfig();

  const app = mountApp();
  server = createServer(app);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const addr = server.address();
  port = addr && typeof addr !== "string" ? addr.port : 0;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const k of ENV_KEYS) {
    const v = envSnapshot[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------ prune ---

describe("POST /api/ops/namespaces/prune", () => {
  it("is a dry run by default: the registry file does not change", async () => {
    const before = fs.readFileSync(cfgFile, "utf-8");

    const { status, body } = await httpRequest("POST", "/api/ops/namespaces/prune", {
      key: "admin-key",
      body: {},
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.dryRun).toBe(true);
    expect(body.registry).toMatchObject({ live: 1, dead: 1 });
    expect(body.dead.map((r: any) => r.name)).toEqual(["dead"]);
    expect(body.removed).toBeUndefined();
    // SAFE BY DEFAULT means byte-identical, not "logically the same".
    expect(fs.readFileSync(cfgFile, "utf-8")).toBe(before);
  });

  it("refuses a real prune without confirm=true (400, nothing written)", async () => {
    const before = fs.readFileSync(cfgFile, "utf-8");

    const { status, body } = await httpRequest("POST", "/api/ops/namespaces/prune", {
      key: "admin-key",
      body: { dryRun: false },
    });

    expect(status).toBe(400);
    expect(body.code).toBe("CONFIRMATION_REQUIRED");
    expect(fs.readFileSync(cfgFile, "utf-8")).toBe(before);
  });

  it("applies with dryRun=false + confirm=true and reports before/after counts", async () => {
    const { status, body } = await httpRequest("POST", "/api/ops/namespaces/prune", {
      key: "admin-key",
      body: { dryRun: false, confirm: true },
    });

    expect(status).toBe(200);
    expect(body.dryRun).toBe(false);
    expect(body.removed).toBe(1);
    expect(body.registry.dead).toBe(1);

    const after = readConfig();
    expect(Object.keys(after.namespaceMappings)).toEqual(["live"]);
  });

  it("audits every run with op + outcome + principal", async () => {
    await httpRequest("POST", "/api/ops/namespaces/prune", {
      key: "admin-key",
      body: {},
    });

    const lines = lifecycleLines();
    const entry = lines.find((l) => l.op === "prune-namespace-registry");
    expect(entry).toBeDefined();
    expect(entry.principal).toBe("ops-admin");
    expect(entry.surface).toBe("rest");
    expect(entry.dryRun).toBe(true);
    expect(entry.success).toBe(true);
  });

  it("refuses a non-admin token (403) and does not plan anything", async () => {
    const { status, body } = await httpRequest("POST", "/api/ops/namespaces/prune", {
      key: "writer-key",
      body: {},
    });
    expect(status).toBe(403);
    expect(body.error).toContain("lacks required role");
    expect(lifecycleLines()).toHaveLength(0);
  });

  it("rejects a non-boolean dryRun instead of guessing", async () => {
    const { status } = await httpRequest("POST", "/api/ops/namespaces/prune", {
      key: "admin-key",
      body: { dryRun: "yes" },
    });
    expect(status).toBe(400);
  });
});

// -------------------------------------------------------------- s3 status ---

describe("GET /api/ops/s3/status", () => {
  it("reports enabled:false when S3 is disabled, in the CLI's shape", async () => {
    const { status, body } = await httpRequest("GET", "/api/ops/s3/status", {
      key: "admin-key",
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      enabled: false,
      total: 0,
      namespaces: [],
    });
  });

  it("reports config + registry/census rows without touching the network (probe=false)", async () => {
    writeConfig({
      s3: {
        enabled: true,
        bucket: "ops-bucket",
        prefix: "fleet",
        pushOnCommit: false,
        intervalSec: 300,
        forcePathStyle: true,
      },
    });

    const { status, body } = await httpRequest(
      "GET",
      "/api/ops/s3/status?probe=false",
      { key: "admin-key" },
    );

    expect(status).toBe(200);
    expect(body.enabled).toBe(true);
    expect(body.bucket).toBe("ops-bucket");
    expect(body.prefix).toBe("fleet");
    expect(body.total).toBeGreaterThanOrEqual(1);
    const live = body.namespaces.find((r: any) => r.ns === "live");
    expect(live).toMatchObject({ local: expect.any(Number), remote: null, registered: true });
  });

  it("refuses a non-admin token (403)", async () => {
    const { status } = await httpRequest("GET", "/api/ops/s3/status", {
      key: "writer-key",
    });
    expect(status).toBe(403);
  });
});

// ------------------------------------------------------------- consolidate ---

describe("POST /api/ops/consolidate", () => {
  it("reports real per-namespace counts for the target day and writes nothing", async () => {
    seedConsolidateDay();
    const snapshot = fs.readdirSync(path.join(nsRoot, "live", "concept", "2026-11"));

    const { status, body } = await httpRequest("POST", "/api/ops/consolidate", {
      key: "admin-key",
      body: { date: "2026-11-04" },
    });

    expect(status).toBe(200);
    expect(body.readOnly).toBe(true);
    expect(body.totals).toEqual({ rows: 3, unique: 2, duplicates: 1 });
    expect(body.namespaces).toEqual([
      { namespace: "live", rows: 3, unique: 2, duplicates: 1 },
    ]);
    expect(body.digest).toContain("2026-11-04");
    expect(fs.readdirSync(path.join(nsRoot, "live", "concept", "2026-11"))).toEqual(snapshot);
  });

  it("defaults to yesterday (UTC) when no date is given", async () => {
    const { status, body } = await httpRequest("POST", "/api/ops/consolidate", {
      key: "admin-key",
      body: {},
    });

    expect(status).toBe(200);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    expect(body.date).toBe(yesterday);
  });

  it("rejects an impossible calendar day", async () => {
    const { status, body } = await httpRequest("POST", "/api/ops/consolidate", {
      key: "admin-key",
      body: { date: "2026-02-30" },
    });
    expect(status).toBe(400);
    expect(body.code).toBe("VALIDATION_ERROR");
  });
});

// ------------------------------------------------- CLI-only decision guard ---

describe("CLI-only decisions are documented AND unrouted", () => {
  const DOC = path.join(process.cwd(), "docs", "api", "ops-surface-decisions.md");

  it("the decision file names every CLI-only verb", () => {
    const doc = fs.readFileSync(DOC, "utf-8");
    for (const verb of ["s3 sync", "distill-sessions", "embeddings rebuild", "token create"]) {
      expect(doc).toContain(verb);
    }
    for (const route of [
      "/api/ops/namespaces/prune",
      "/api/ops/s3/status",
      "/api/ops/consolidate",
      "/api/compaction/squash",
    ]) {
      expect(doc).toContain(route);
    }
  });

  it("no route answers for a CLI-only verb", async () => {
    const cases: Array<[string, string]> = [
      ["POST", "/api/ops/s3/sync"],
      ["POST", "/api/ops/distill-sessions"],
      ["POST", "/api/ops/embeddings/rebuild"],
      ["POST", "/api/ops/tokens"],
      ["DELETE", "/api/ops/tokens/abc"],
    ];
    for (const [method, urlPath] of cases) {
      // No body: these probes only ask whether the route EXISTS. (Node's HTTP
      // layer answers 400 to a bodied GET/DELETE in this harness, which would
      // obscure the 404 we are asserting.)
      const { status } = await httpRequest(method, urlPath, {
        key: "admin-key",
      });
      expect(status, `${method} ${urlPath} must not exist`).toBe(404);
    }
  });
});
