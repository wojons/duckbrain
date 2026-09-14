/**
 * DB-SUPA-3 Integration Tests: generic table→REST resource layer
 *
 * Exercises the full battery over a temp fixture namespace:
 *   - table listing from the declared registry
 *   - PostgREST filters (eq/ne/gt/gte/lt/lte/like/in)
 *   - multi-column order (asc + desc)
 *   - limit/offset paging + the 1000 clamp
 *   - X-Total-Count via Prefer: count=exact
 *   - validation 400s (unknown column, unknown op, unknown insert column)
 *   - insert: single object, NDJSON batch, positional-format append
 *   - PATCH / DELETE by declared primary key (+ missing-filter 400)
 *   - CSV rendering via Accept: text/csv
 *   - openapi.json generated from the registry
 *   - grant restriction: a scoped token without the namespace gets 403
 *
 * The fixtures write a widgets.table.json (jsonl-objects) and a
 * lane_scores.table.json (jsonl-positional, mirroring the routing
 * namespace's array-row shape) under DUCKBRAIN_NAMESPACES_PATH, then
 * drive the real route stack mounted on an Express app (the same
 * pattern as namespaces.test.ts).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import express, { Request, Response, NextFunction } from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { createTableRoutes, createNamespaceOpenApiRoutes } from "./tables";
import { invalidateTableRegistry } from "../../schema/table-registry";
import { createServer, type Server } from "http";

const FIXTURE_NS = "supa3-fixture";

let nsDir = "";
let tmpRoot = "";

function writeFixture(): void {
  fs.mkdirSync(path.join(nsDir, "tables"), { recursive: true });

  fs.writeFileSync(
    path.join(nsDir, "tables", "widgets.table.json"),
    JSON.stringify({
      name: "widgets",
      format: "jsonl-objects",
      columns: [
        { name: "id", type: "integer" },
        { name: "name", type: "varchar" },
        { name: "qty", type: "double" },
        { name: "tags", type: "json" },
      ],
      primary: "id",
      glob: "tables/widgets.jsonl",
    }),
  );

  fs.writeFileSync(
    path.join(nsDir, "tables", "lane_scores.table.json"),
    JSON.stringify({
      name: "lane_scores",
      format: "jsonl-positional",
      columns: [
        { name: "model", type: "varchar" },
        { name: "lane", type: "varchar" },
        { name: "score", type: "double" },
        { name: "rank", type: "integer" },
      ],
      primary: null,
      glob: "tables/lane_scores.jsonl",
    }),
  );

  fs.writeFileSync(
    path.join(nsDir, "tables", "widgets.jsonl"),
    [
      JSON.stringify({ id: 1, name: "alpha", qty: 1.5, tags: { a: 1 } }),
      JSON.stringify({ id: 2, name: "beta", qty: 2.5, tags: [1, 2] }),
      JSON.stringify({ id: 3, name: "gamma", qty: 3.5, tags: null }),
      JSON.stringify({ id: 4, name: "delta", qty: 4.5, tags: { b: "x,y" } }),
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(nsDir, "tables", "lane_scores.jsonl"),
    [
      JSON.stringify(["DeepSeek-V3.2", "test", 0.72, 3]),
      JSON.stringify(["MiniMax-M2.5", "code_gen", 0.75, 1]),
      JSON.stringify(["MiniMax-M2.5", "refactor", 0.5, 1]),
    ].join("\n") + "\n",
  );
}

/** app under test — rebuilt per test so the registry cache is fresh. */
function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  // NDJSON bodies must survive as raw text for the x-ndjson content type.
  app.use(
    express.text({ type: "application/x-ndjson", limit: "1mb" }),
  );
  app.use(`/api/ns/:ns/tables`, createTableRoutes());
  app.use(`/api/ns/:ns/openapi.json`, createNamespaceOpenApiRoutes());
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || 500;
    res.status(status).json({
      error: err.message || "Internal server error",
      code: err.code,
    });
  });
  return app;
}

interface HttpResult {
  status: number;
  body: any;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

function httpRequest(
  app: express.Express,
  method: string,
  reqPath: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr !== "string" ? addr.port : 0;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const http = require("http");
      const options: any = {
        hostname: "127.0.0.1",
        port,
        path: reqPath,
        method,
        headers: {
          Host: "localhost",
          ...(opts.body !== undefined && !opts.headers?.["Content-Type"]
            ? { "Content-Type": "application/json" }
            : {}),
          ...(opts.headers || {}),
        },
      };
      const req = http.request(options, (res: any) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          server.close();
          let parsed: any = data;
          try {
            parsed = JSON.parse(data);
          } catch {
            // non-JSON (CSV/text) — return raw
          }
          resolve({
            status: res.statusCode,
            body: parsed,
            headers: res.headers,
            text: data,
          });
        });
      });
      req.on("error", (err: Error) => {
        server.close();
        reject(err);
      });
      if (opts.body !== undefined) {
        req.write(
          typeof opts.body === "string"
            ? opts.body
            : JSON.stringify(opts.body),
        );
      }
      req.end();
    });
  });
}

const BASE = `/api/ns/${FIXTURE_NS}/tables`;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "supa3-test-"));
  nsDir = path.join(tmpRoot, FIXTURE_NS);
  process.env.DUCKBRAIN_NAMESPACES_PATH = tmpRoot;
  writeFixture();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("DB-SUPA-3: generic table→REST layer", () => {
  beforeEach(() => {
    invalidateTableRegistry(FIXTURE_NS);
  });

  it("lists declared tables from the registry", async () => {
    const res = await httpRequest(createApp(), "GET", BASE);
    expect(res.status).toBe(200);
    expect(res.body.namespace).toBe(FIXTURE_NS);
    const names = res.body.tables.map((t: any) => t.name).sort();
    expect(names).toEqual(["lane_scores", "widgets"]);
    const widgets = res.body.tables.find((t: any) => t.name === "widgets");
    expect(widgets.format).toBe("jsonl-objects");
    expect(widgets.primary).toBe("id");
    expect(widgets.columns.map((c: any) => c.type)).toEqual([
      "integer",
      "varchar",
      "double",
      "json",
    ]);
  });

  it("404s on an unknown table and an unknown namespace", async () => {
    const res = await httpRequest(createApp(), "GET", `${BASE}/nope`);
    expect(res.status).toBe(404);
    const res2 = await httpRequest(
      createApp(),
      "GET",
      "/api/ns/ghost-ns/tables",
    );
    expect(res2.status).toBe(200);
    expect(res2.body.tables).toEqual([]);
  });

  it("returns all rows as JSON by default", async () => {
    const res = await httpRequest(createApp(), "GET", `${BASE}/widgets`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(4);
    expect(res.body[0]).toMatchObject({ id: 1, name: "alpha", qty: 1.5 });
  });

  it("filters with eq / ne", async () => {
    const eq = await httpRequest(createApp(), "GET", `${BASE}/widgets?id=eq.2`);
    expect(eq.status).toBe(200);
    expect(eq.body).toHaveLength(1);
    expect(eq.body[0].name).toBe("beta");

    const ne = await httpRequest(createApp(), "GET", `${BASE}/widgets?id=ne.2`);
    expect(ne.status).toBe(200);
    expect(ne.body.map((r: any) => r.id).sort()).toEqual([1, 3, 4]);
  });

  it("filters with gt / gte / lt / lte", async () => {
    const gt = await httpRequest(createApp(), "GET", `${BASE}/widgets?qty=gt.2.5`);
    expect(gt.body.map((r: any) => r.id).sort()).toEqual([3, 4]);

    const gte = await httpRequest(createApp(), "GET", `${BASE}/widgets?qty=gte.2.5`);
    expect(gte.body.map((r: any) => r.id).sort()).toEqual([2, 3, 4]);

    const lt = await httpRequest(createApp(), "GET", `${BASE}/widgets?qty=lt.2.5`);
    expect(lt.body.map((r: any) => r.id)).toEqual([1]);

    const lte = await httpRequest(createApp(), "GET", `${BASE}/widgets?qty=lte.2.5`);
    expect(lte.body.map((r: any) => r.id).sort()).toEqual([1, 2]);
  });

  it("filters with like (case-sensitive)", async () => {
    const res = await httpRequest(
      createApp(),
      "GET",
      `${BASE}/widgets?name=like.%25ga%25`,
    );
    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => r.name)).toEqual(["gamma"]);
  });

  it("filters with in.(a,b,c)", async () => {
    const res = await httpRequest(
      createApp(),
      "GET",
      `${BASE}/widgets?id=in.(1,3,99)`,
    );
    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => r.id).sort()).toEqual([1, 3]);
  });

  it("combines multiple filters with AND", async () => {
    const res = await httpRequest(
      createApp(),
      "GET",
      `${BASE}/widgets?id=gte.2&qty=lte.3.5`,
    );
    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => r.id)).toEqual([2, 3]);
  });

  it("orders by multiple columns asc + desc", async () => {
    const res = await httpRequest(
      createApp(),
      "GET",
      `${BASE}/lane_scores?order=rank.desc,score.asc`,
    );
    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => `${r.model}:${r.lane}`)).toEqual([
      "DeepSeek-V3.2:test", // rank 3 first
      "MiniMax-M2.5:refactor", // rank 1, score 0.5
      "MiniMax-M2.5:code_gen", // rank 1, score 0.75
    ]);
  });

  it("pages with limit and offset", async () => {
    const page1 = await httpRequest(
      createApp(),
      "GET",
      `${BASE}/widgets?order=id.asc&limit=2`,
    );
    expect(page1.body.map((r: any) => r.id)).toEqual([1, 2]);

    const page2 = await httpRequest(
      createApp(),
      "GET",
      `${BASE}/widgets?order=id.asc&limit=2&offset=2`,
    );
    expect(page2.body.map((r: any) => r.id)).toEqual([3, 4]);
  });

  it("clamps limit above the hard cap instead of erroring", async () => {
    const res = await httpRequest(
      createApp(),
      "GET",
      `${BASE}/widgets?limit=5000`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(4); // only 4 rows exist — clamp must not 400
    // Verify the clamp actually binds by counting rows through a 1001-row table.
    const bigPath = path.join(nsDir, "tables", "big.jsonl");
    fs.writeFileSync(
      bigPath,
      Array.from(
        { length: 1500 },
        (_, i) => JSON.stringify({ id: i + 1, name: `n${i}`, qty: 0, tags: null }),
      ).join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(nsDir, "tables", "big.table.json"),
      JSON.stringify({
        name: "big",
        format: "jsonl-objects",
        columns: [
          { name: "id", type: "integer" },
          { name: "name", type: "varchar" },
          { name: "qty", type: "double" },
          { name: "tags", type: "json" },
        ],
        primary: "id",
        glob: "tables/big.jsonl",
      }),
    );
    invalidateTableRegistry(FIXTURE_NS);
    try {
      const capped = await httpRequest(
        createApp(),
        "GET",
        `${BASE}/big?limit=5000&order=id.asc`,
      );
      expect(capped.status).toBe(200);
      expect(capped.body).toHaveLength(1000); // clamped from 5000 to 1000
      const page2 = await httpRequest(
        createApp(),
        "GET",
        `${BASE}/big?limit=1000&offset=1000&order=id.asc`,
      );
      expect(page2.body).toHaveLength(500); // remainder
    } finally {
      fs.rmSync(path.join(nsDir, "tables", "big.table.json"));
      fs.rmSync(bigPath);
      invalidateTableRegistry(FIXTURE_NS);
    }
  });

  it("adds X-Total-Count via Prefer: count=exact", async () => {
    const res = await httpRequest(
      createApp(),
      "GET",
      `${BASE}/widgets?limit=2`,
      { headers: { Prefer: "count=exact" } },
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.headers["x-total-count"]).toBe("4");
  });

  it("adds X-Total-Count via ?count=exact", async () => {
    const res = await httpRequest(
      createApp(),
      "GET",
      `${BASE}/widgets?count=exact&limit=1`,
    );
    expect(res.headers["x-total-count"]).toBe("4");
  });

  it("400s an unknown filter column", async () => {
    const res = await httpRequest(
      createApp(),
      "GET",
      `${BASE}/widgets?nope=eq.1`,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("400s an unknown operator", async () => {
    const res = await httpRequest(
      createApp(),
      "GET",
      `${BASE}/widgets?id=hack.1`,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("400s an invalid order clause", async () => {
    const res = await httpRequest(
      createApp(),
      "GET",
      `${BASE}/widgets?order=id;DROP`,
    );
    expect(res.status).toBe(400);
  });

  it("posts a single JSON object (201, inserted: 1)", async () => {
    const res = await httpRequest(createApp(), "POST", `${BASE}/widgets`, {
      body: { id: 10, name: " posted ", qty: 9.5, tags: { k: "v" } },
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ inserted: 1 });
    const read = await httpRequest(
      createApp(),
      "GET",
      `${BASE}/widgets?id=eq.10`,
    );
    expect(read.body[0].name).toBe(" posted ");
    expect(read.body[0].tags).toEqual({ k: "v" });
  });

  it("posts an NDJSON batch of 3 rows", async () => {
    const ndjson = [
      JSON.stringify({ id: 21, name: "nd1", qty: 1, tags: null }),
      JSON.stringify({ id: 22, name: "nd2", qty: 2, tags: [7] }),
      JSON.stringify({ id: 23, name: "nd3", qty: 3, tags: { z: 1 } }),
    ].join("\n");
    const res = await httpRequest(createApp(), "POST", `${BASE}/widgets`, {
      headers: { "Content-Type": "application/x-ndjson" },
      body: ndjson,
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ inserted: 3 });
    const read = await httpRequest(
      createApp(),
      "GET",
      `${BASE}/widgets?id=gte.21&order=id.asc`,
    );
    expect(read.body.map((r: any) => r.id)).toEqual([21, 22, 23]);
  });

  it("400s an insert with an unknown column", async () => {
    const res = await httpRequest(createApp(), "POST", `${BASE}/widgets`, {
      body: { id: 30, name: "x", qty: 1, mystery: true },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    // And nothing was appended.
    const read = await httpRequest(
      createApp(),
      "GET",
      `${BASE}/widgets?id=eq.30`,
    );
    expect(read.body).toHaveLength(0);
  });

  it("422s an insert with a wrong primitive shape", async () => {
    const res = await httpRequest(createApp(), "POST", `${BASE}/widgets`, {
      body: { id: "not-an-int", name: "x", qty: 1 },
    });
    expect(res.status).toBe(422);
  });

  it("appends positional rows to the positional table", async () => {
    const res = await httpRequest(createApp(), "POST", `${BASE}/lane_scores`, {
      body: { model: "glm-5.3", lane: "debug", score: 0.8, rank: 2 },
    });
    expect(res.status).toBe(201);
    const raw = fs
      .readFileSync(path.join(nsDir, "tables", "lane_scores.jsonl"), "utf-8")
      .trim()
      .split("\n");
    // Positional storage: the new row is a JSON ARRAY in declared column order.
    expect(JSON.parse(raw[raw.length - 1]!)).toEqual([
      "glm-5.3",
      "debug",
      0.8,
      2,
    ]);
    const read = await httpRequest(
      createApp(),
      "GET",
      `${BASE}/lane_scores?model=eq.glm-5.3`,
    );
    expect(read.body).toHaveLength(1);
    expect(read.body[0]).toMatchObject({ lane: "debug", score: 0.8, rank: 2 });
  });

  it("patches a row by primary key", async () => {
    const res = await httpRequest(
      createApp(),
      "PATCH",
      `${BASE}/widgets?pk=eq.2`,
      { body: { qty: 22.5, name: "beta-updated" } },
    );
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
    const read = await httpRequest(
      createApp(),
      "GET",
      `${BASE}/widgets?id=eq.2`,
    );
    expect(read.body[0]).toMatchObject({ id: 2, name: "beta-updated", qty: 22.5 });
  });

  it("400s PATCH without the pk filter", async () => {
    const res = await httpRequest(createApp(), "PATCH", `${BASE}/widgets`, {
      body: { qty: 1 },
    });
    expect(res.status).toBe(400);
  });

  it("400s PATCH with a non-eq pk filter", async () => {
    const res = await httpRequest(
      createApp(),
      "PATCH",
      `${BASE}/widgets?pk=gte.1`,
      { body: { qty: 1 } },
    );
    expect(res.status).toBe(400);
  });

  it("deletes a row by primary key", async () => {
    const res = await httpRequest(
      createApp(),
      "DELETE",
      `${BASE}/widgets?pk=eq.3`,
    );
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1);
    const read = await httpRequest(
      createApp(),
      "GET",
      `${BASE}/widgets?id=eq.3`,
    );
    expect(read.body).toHaveLength(0);
  });

  it("400s DELETE without the pk filter", async () => {
    const res = await httpRequest(createApp(), "DELETE", `${BASE}/widgets`);
    expect(res.status).toBe(400);
  });

  it("renders CSV via Accept: text/csv", async () => {
    const res = await httpRequest(
      createApp(),
      "GET",
      `${BASE}/widgets?order=id.asc&limit=2`,
      { headers: { Accept: "text/csv" } },
    );
    expect(res.status).toBe(200);
    expect(String(res.headers["content-type"])).toContain("text/csv");
    // Parse the CSV output with the stdlib csv parser.
    const parsed = parseCsv(res.text);
    expect(parsed.header).toEqual(["id", "name", "qty", "tags"]);
    expect(parsed.rows.length).toBe(2);
    expect(parsed.rows[0]).toEqual(["1", "alpha", "1.5", '{"a":1}']);
  });

  it("serves openapi.json containing both tables and filter params", async () => {
    const res = await httpRequest(
      createApp(),
      "GET",
      `/api/ns/${FIXTURE_NS}/openapi.json`,
    );
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.1.0");
    expect(Object.keys(res.body.paths).sort()).toEqual([
      `/api/ns/${FIXTURE_NS}/tables/lane_scores`,
      `/api/ns/${FIXTURE_NS}/tables/widgets`,
    ]);
    const widgets = res.body.paths[`/api/ns/${FIXTURE_NS}/tables/widgets`];
    expect(widgets.get.parameters.some((p: any) => p.name === "order")).toBe(
      true,
    );
    expect(widgets.get.parameters.some((p: any) => p.name === "id")).toBe(true);
    expect(widgets.post).toBeDefined();
    expect(widgets.patch).toBeDefined();
    expect(widgets.delete).toBeDefined();
  });

  it("403s a restricted token without a namespace grant (mirror of memories-auth)", async () => {
    // Build the app with the same auth middleware chain the real server uses,
    // with a scoped token that lacks a grant for the fixture namespace.
    const { authMiddleware } = await import("../../auth/middleware.js");
    const app = express();
    app.use(express.json());
    app.use(
      express.text({ type: "application/x-ndjson", limit: "1mb" }),
    );
    app.use(
      authMiddleware({
        type: "apikey",
        apiKeys: [
          { key: "supa3-scoped-key", name: "scoped", namespaces: ["other-ns"] },
        ],
      }),
    );
    app.use(`/api/ns/:ns/tables`, createTableRoutes());
  app.use(`/api/ns/:ns/openapi.json`, createNamespaceOpenApiRoutes());
    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
      res.status(err.status || 500).json({ error: err.message, code: err.code });
    });

    const denied = await httpRequest(app, "GET", `${BASE}/widgets`, {
      headers: { "x-api-key": "supa3-scoped-key" },
    });
    expect(denied.status).toBe(403);

    const granted = await httpRequest(
      app,
      "GET",
      "/api/ns/other-ns/tables",
      { headers: { "x-api-key": "supa3-scoped-key" } },
    );
    expect(granted.status).toBe(200);
  });
});

/** Minimal RFC-4180 CSV parser for test assertions. */
function parseCsv(text: string): {
  header: string[];
  rows: string[][];
} {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      if (field !== "" || row.length > 0) {
        row.push(field);
        rows.push(row);
        field = "";
        row = [];
      }
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift() ?? [];
  return { header, rows };
}
