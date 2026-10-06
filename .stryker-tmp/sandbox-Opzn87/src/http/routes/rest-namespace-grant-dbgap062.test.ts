/**
 * DB-GAP-062 regression tests: three REST routers mounted no namespace-grant
 * middleware, so a token scoped to specific namespaces could still read
 * another namespace's key list (/api/keys), its storage shape and compact it
 * (/api/compaction*), and its activity feed (/activity) — while
 * /api/memories and the table routes already answered 403.
 *
 * Each router is mounted behind the REAL authMiddleware with an inline apikey
 * store, so these cases exercise the same auth → principal → grant chain the
 * live daemon runs (createHttpServer installs exactly this middleware). The
 * refusal asserted is the memories/tables refusal: 403 whose body names the
 * namespace, plus a `namespace_scope` denial handed to the audit sink.
 *
 * The MCP tool modules are mocked (real exports kept, so the shared
 * cli/http import chain still resolves) and /activity's DuckDB + fs are
 * mocked, so nothing touches real storage or an embedding provider.
 */
// @ts-nocheck


import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import express, { Request, Response, NextFunction, Router } from "express";
import { createServer, Server } from "http";
import fs from "fs";

vi.mock("../../mcp/tools/list_keys", () => ({
  listKeysTool: vi.fn(),
}));

vi.mock("../../mcp/tools/squash", () => ({
  squashTool: vi.fn(),
  getCompactionStatsTool: vi.fn(),
}));

// /activity reads the namespace tree from disk and queries DuckDB — mock both
// (same shape as activity.test.ts) so these cases stay hermetic.
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn(),
      readdirSync: vi.fn(),
      existsSync: vi.fn(),
      statSync: vi.fn(),
    },
    readFileSync: vi.fn(),
    readdirSync: vi.fn(),
    existsSync: vi.fn(),
    statSync: vi.fn(),
  };
});

const mockDbAll = vi.fn();
vi.mock("../../duckdb/connection", () => ({
  getDuckDBConnection: vi.fn(() => ({ all: mockDbAll })),
}));

import { authMiddleware } from "../../auth/middleware";
import { listKeysTool } from "../../mcp/tools/list_keys";
import { squashTool, getCompactionStatsTool } from "../../mcp/tools/squash";
import { createKeyRoutes } from "./keys";
import { createCompactionRoutes } from "./compaction";
import { createActivityRoutes } from "./activity";

const mockedListKeysTool = vi.mocked(listKeysTool);
const mockedSquashTool = vi.mocked(squashTool);
const mockedGetCompactionStatsTool = vi.mocked(getCompactionStatsTool);

const AUDIT = vi.fn();

const AUTH_CONFIG = {
  type: "apikey" as const,
  auditDenial: AUDIT,
  apiKeys: [
    { key: "unrestricted-key", name: "unrestricted-agent" },
    { key: "scoped-a-key", name: "scoped-agent", namespaces: ["a"] },
    { key: "scoped-ab-key", name: "scoped-ab-agent", namespaces: ["a", "b"] },
    {
      key: "scoped-default-key",
      name: "default-agent",
      namespaces: ["default"],
    },
  ],
};

const NONE_CONFIG = { type: "none" as const, auditDenial: AUDIT, apiKeys: [] };

interface HttpResponse {
  status: number;
  body: any;
}

/**
 * Mount `router` behind the real auth middleware (the same one
 * createHttpServer installs) so the grant check sees the authenticated
 * principal. Body parsing sits between auth and the router, exactly as the
 * live server orders it.
 */
function mountApp(
  mountPath: string,
  router: Router,
  authConfig: typeof AUTH_CONFIG | typeof NONE_CONFIG,
) {
  const app = express();
  app.use(authMiddleware(authConfig));
  app.use(express.json());
  app.use(mountPath, router);
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) =>
    res.status(err.status || 500).json({
      error: err.message || "Internal server error",
      ...(err.code ? { code: err.code } : {}),
    }),
  );
  return app;
}

function startServer(
  app: express.Express,
): Promise<{ server: Server; port: number }> {
  const server = createServer(app);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        server,
        port: addr && typeof addr !== "string" ? addr.port : 0,
      });
    });
  });
}

function httpRequest(
  port: number,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const http = require("http");
    const options: any = {
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: { Host: "localhost", ...(opts.headers || {}) },
    };
    if (opts.body !== undefined) {
      options.headers["Content-Type"] = "application/json";
    }
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
    if (opts.body !== undefined) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

// ---------------------------------------------------------------- fixtures --

const NS_ROOT = process.env.DUCKBRAIN_NAMESPACES_PATH || "./namespaces";

function setupMockFs(namespaceDirs: string[]) {
  const isNsPath = (s: string) =>
    s === NS_ROOT || s.startsWith(NS_ROOT + "/") || s.includes("namespaces");
  vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
    const s = p.toString();
    if (s.endsWith("duckbrain.config.json")) return true;
    if (s.includes("manifest.json")) return true;
    return isNsPath(s);
  });
  vi.mocked(fs.readdirSync).mockImplementation((p: any) => {
    const s = p.toString();
    if (
      s === NS_ROOT ||
      s === "./namespaces" ||
      (isNsPath(s) && !s.includes("partitions"))
    ) {
      return namespaceDirs as any;
    }
    return ["chunk_000.jsonl"] as any;
  });
  vi.mocked(fs.statSync).mockImplementation(
    () => ({ isDirectory: () => true, isFile: () => false }) as any,
  );
  vi.mocked(fs.readFileSync).mockImplementation((p: any) =>
    p.toString().endsWith("duckbrain.config.json")
      ? JSON.stringify({ namespacesPath: NS_ROOT })
      : "",
  );
}

function activityRow(namespace: string, id: string) {
  return {
    id,
    key: `/${namespace}/${id}`,
    domain: "raw_note",
    timestamp: "2026-10-02T10:00:00Z",
    author: "writer@example.com",
    action: "add",
    embedding_text: `${namespace} row`,
    attributes: "{}",
    filename: `${NS_ROOT}/${namespace}/partitions/2026-10/chunk_000.jsonl`,
  };
}

// ------------------------------------------------------------------- keys ---

describe("DB-GAP-062: /api/keys enforces namespace grants", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    ({ server, port } = await startServer(
      mountApp("/api/keys", createKeyRoutes, AUTH_CONFIG),
    ));
  });

  afterAll(() => server.close());

  beforeEach(() => {
    vi.clearAllMocks();
    mockedListKeysTool.mockResolvedValue({
      keys: [],
      hasMore: false,
      nextOffset: null,
      prefixes: {},
    } as any);
  });

  it("refuses a scoped token reading an ungranted namespace (403 + audited namespace_scope)", async () => {
    const { status, body } = await httpRequest(
      port,
      "GET",
      "/api/keys?namespace=b",
      {
        headers: { "X-API-Key": "scoped-a-key" },
      },
    );
    expect(status).toBe(403);
    expect(body.error).toContain("'b'");
    expect(mockedListKeysTool).not.toHaveBeenCalled();
    expect(AUDIT).toHaveBeenCalledWith(
      expect.objectContaining({
        ns: "b",
        op: "namespace.access",
        reason: "namespace_scope",
        principal: "scoped-agent",
        outcome: "denied",
      }),
    );
  });

  it("refuses a scoped token on /api/keys/flat too (router-level mount)", async () => {
    const { status } = await httpRequest(
      port,
      "GET",
      "/api/keys/flat?namespace=b",
      {
        headers: { "X-API-Key": "scoped-a-key" },
      },
    );
    expect(status).toBe(403);
    expect(mockedListKeysTool).not.toHaveBeenCalled();
  });

  it("allows a scoped token inside its grants (200) and reads exactly that namespace", async () => {
    const { status } = await httpRequest(port, "GET", "/api/keys?namespace=a", {
      headers: { "X-API-Key": "scoped-a-key" },
    });
    expect(status).toBe(200);
    expect(mockedListKeysTool).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "a" }),
    );
  });

  it("grades the canonical default namespace when the request names none", async () => {
    // The route reads the ACTIVE namespace (config defaultNamespace, here
    // "default") when ?namespace= is absent — the grant gate grades the same
    // one, so a token granted only "a" is refused rather than served the
    // server's default namespace tree.
    const { status, body } = await httpRequest(port, "GET", "/api/keys", {
      headers: { "X-API-Key": "scoped-a-key" },
    });
    expect(status).toBe(403);
    expect(body.error).toContain("'default'");
    expect(mockedListKeysTool).not.toHaveBeenCalled();

    const granted = await httpRequest(port, "GET", "/api/keys", {
      headers: { "X-API-Key": "scoped-default-key" },
    });
    expect(granted.status).toBe(200);
    expect(mockedListKeysTool).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "default" }),
    );
  });

  it("leaves unrestricted tokens unchanged (any namespace)", async () => {
    const { status } = await httpRequest(port, "GET", "/api/keys?namespace=b", {
      headers: { "X-API-Key": "unrestricted-key" },
    });
    expect(status).toBe(200);
    expect(mockedListKeysTool).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "b" }),
    );
  });
});

describe("DB-GAP-062: /api/keys under auth=none", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    ({ server, port } = await startServer(
      mountApp("/api/keys", createKeyRoutes, NONE_CONFIG),
    ));
  });

  afterAll(() => server.close());

  it("serves any namespace with no token and no principal (unchanged)", async () => {
    // Deliberately NOT a blanket clearAllMocks: AUDIT's history is cleared so
    // "no denial was audited for this request" is a real assertion.
    AUDIT.mockClear();
    mockedListKeysTool.mockResolvedValue({
      keys: [],
      hasMore: false,
      nextOffset: null,
      prefixes: {},
    } as any);
    const { status } = await httpRequest(port, "GET", "/api/keys?namespace=b");
    expect(status).toBe(200);
    expect(AUDIT).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------- compaction ---

describe("DB-GAP-062: /api/compaction enforces namespace grants", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    ({ server, port } = await startServer(
      mountApp("/api/compaction", createCompactionRoutes, AUTH_CONFIG),
    ));
  });

  afterAll(() => server.close());

  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetCompactionStatsTool.mockResolvedValue({
      success: true,
      stats: { totalRecords: 0 },
    } as any);
    mockedSquashTool.mockResolvedValue({
      success: true,
      message: "ok",
    } as any);
  });

  it("refuses a scoped token reading an ungranted namespace's stats (403, no tool call)", async () => {
    const { status, body } = await httpRequest(
      port,
      "GET",
      "/api/compaction/stats?namespace=b",
      { headers: { "X-API-Key": "scoped-a-key" } },
    );
    expect(status).toBe(403);
    expect(body.error).toContain("'b'");
    expect(mockedGetCompactionStatsTool).not.toHaveBeenCalled();
    expect(AUDIT).toHaveBeenCalledWith(
      expect.objectContaining({ ns: "b", reason: "namespace_scope" }),
    );
  });

  it("allows a scoped token its own namespace's stats", async () => {
    const { status } = await httpRequest(
      port,
      "GET",
      "/api/compaction/stats?namespace=a",
      { headers: { "X-API-Key": "scoped-a-key" } },
    );
    expect(status).toBe(200);
    expect(mockedGetCompactionStatsTool).toHaveBeenCalledWith({
      namespace: "a",
    });
  });

  it("refuses a scoped token squashing an ungranted namespace named in the BODY", async () => {
    const { status } = await httpRequest(
      port,
      "POST",
      "/api/compaction/squash",
      {
        headers: { "X-API-Key": "scoped-a-key" },
        body: { namespace: "b", dryRun: true },
      },
    );
    expect(status).toBe(403);
    expect(mockedSquashTool).not.toHaveBeenCalled();
  });

  it("refuses a scoped token squashing an ungranted namespace named in the QUERY", async () => {
    const { status } = await httpRequest(
      port,
      "POST",
      "/api/compaction/squash?namespace=b",
      { headers: { "X-API-Key": "scoped-a-key" }, body: { dryRun: true } },
    );
    expect(status).toBe(403);
    expect(mockedSquashTool).not.toHaveBeenCalled();
  });

  it("lets a scoped token squash inside its grants", async () => {
    const { status } = await httpRequest(
      port,
      "POST",
      "/api/compaction/squash",
      {
        headers: { "X-API-Key": "scoped-a-key" },
        body: { namespace: "a", dryRun: true },
      },
    );
    expect(status).toBe(200);
    expect(mockedSquashTool).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "a", dryRun: true }),
    );
  });

  it("leaves unrestricted tokens unchanged (stats + squash, named or unnamed)", async () => {
    const stats = await httpRequest(
      port,
      "GET",
      "/api/compaction/stats?namespace=b",
      { headers: { "X-API-Key": "unrestricted-key" } },
    );
    expect(stats.status).toBe(200);

    const unnamed = await httpRequest(port, "POST", "/api/compaction/squash", {
      headers: { "X-API-Key": "unrestricted-key" },
      body: { dryRun: true },
    });
    expect(unnamed.status).toBe(200);
    // No namespace in the request → the tool is handed none (it resolves the
    // active namespace itself), exactly as before this change.
    expect(mockedSquashTool).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
    );
  });
});

describe("DB-GAP-062: /api/compaction under auth=none", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    ({ server, port } = await startServer(
      mountApp("/api/compaction", createCompactionRoutes, NONE_CONFIG),
    ));
  });

  afterAll(() => server.close());

  it("squashes with no token and no principal (unchanged)", async () => {
    AUDIT.mockClear();
    mockedSquashTool.mockResolvedValue({ success: true, message: "ok" } as any);
    const { status } = await httpRequest(
      port,
      "POST",
      "/api/compaction/squash",
      {
        body: { namespace: "b", dryRun: true },
      },
    );
    expect(status).toBe(200);
    expect(AUDIT).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------- activity ---

describe("DB-GAP-062: /activity enforces namespace grants", () => {
  let server: Server;
  let port: number;
  let lastSql: string;

  beforeAll(async () => {
    ({ server, port } = await startServer(
      mountApp("/activity", createActivityRoutes, AUTH_CONFIG),
    ));
  });

  afterAll(() => server.close());

  beforeEach(() => {
    vi.clearAllMocks();
    setupMockFs(["a", "b", "c"]);
    lastSql = "";
    mockDbAll.mockImplementation((sql: string, callback: Function) => {
      lastSql = sql;
      callback(null, [
        activityRow("a", "a1"),
        activityRow("b", "b1"),
        activityRow("c", "c1"),
      ]);
    });
  });

  it("refuses a scoped token asking for an ungranted namespace (403 + audited namespace_scope)", async () => {
    const { status, body } = await httpRequest(
      port,
      "GET",
      "/activity?namespace=c",
      { headers: { "X-API-Key": "scoped-ab-key" } },
    );
    expect(status).toBe(403);
    expect(body.error).toContain("'c'");
    expect(AUDIT).toHaveBeenCalledWith(
      expect.objectContaining({
        ns: "c",
        op: "namespace.access",
        reason: "namespace_scope",
        principal: "scoped-ab-agent",
        outcome: "denied",
      }),
    );
  });

  it("serves a scoped token only its granted namespaces, even without ?namespace=", async () => {
    const { status, body } = await httpRequest(port, "GET", "/activity", {
      headers: { "X-API-Key": "scoped-a-key" },
    });
    expect(status).toBe(200);
    // Rows from b and c exist in the store; the scoped token sees only a.
    expect(body.activities.map((r: any) => r.namespace)).toEqual(["a"]);
    // and the ungranted segments were never even read — the per-namespace glob
    // matches <root>/<ns>/<domain>/<YYYY-MM>/<file>.jsonl (THREE wildcards
    // below the namespace: the layout the root glob's four wildcards imply).
    expect(lastSql).toContain(`${NS_ROOT}/a/*/*/*.jsonl`);
    expect(lastSql).not.toContain("/b/*");
    expect(lastSql).not.toContain("/c/*");
  });

  it("honors ?namespace= for a scoped token inside its grants", async () => {
    const { status, body } = await httpRequest(
      port,
      "GET",
      "/activity?namespace=b",
      { headers: { "X-API-Key": "scoped-ab-key" } },
    );
    expect(status).toBe(200);
    expect(body.activities.map((r: any) => r.namespace)).toEqual(["b"]);
    expect(lastSql).toContain(`${NS_ROOT}/b/*/*/*.jsonl`);
    expect(lastSql).not.toContain("/a/*");
  });

  it("leaves unrestricted tokens unchanged (all namespaces)", async () => {
    const { status, body } = await httpRequest(port, "GET", "/activity", {
      headers: { "X-API-Key": "unrestricted-key" },
    });
    expect(status).toBe(200);
    expect(body.activities.map((r: any) => r.namespace)).toEqual([
      "a",
      "b",
      "c",
    ]);
    // unchanged read plan: the single root glob, not per-namespace globs
    expect(lastSql).toContain(`${NS_ROOT}/*/*/*/*.jsonl`);
  });
});

describe("DB-GAP-062: /activity under auth=none", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    ({ server, port } = await startServer(
      mountApp("/activity", createActivityRoutes, NONE_CONFIG),
    ));
  });

  afterAll(() => server.close());

  it("serves every namespace with no token and no principal (unchanged)", async () => {
    AUDIT.mockClear();
    setupMockFs(["a", "b", "c"]);
    mockDbAll.mockImplementation((_sql: string, callback: Function) =>
      callback(null, [activityRow("a", "a1"), activityRow("c", "c1")]),
    );
    const { status, body } = await httpRequest(port, "GET", "/activity");
    expect(status).toBe(200);
    expect(body.activities.map((r: any) => r.namespace)).toEqual(["a", "c"]);
    expect(AUDIT).not.toHaveBeenCalled();
  });
});
