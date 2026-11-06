/**
 * REST-ATOMICITY-001 — HTTP surface of upsert, the transaction envelope and
 * one-level embedding.
 *
 * Drives the REAL route stack (`createTableRoutes`) over a real 127.0.0.1
 * socket against a temp namespace whose tables are declared in `schema.json`,
 * so the responses prove the wire contract (status codes, body shape,
 * durability headers) rather than the helper functions alone.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express, { NextFunction, Request, Response } from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { createServer, type Server } from "http";
import {
  createNamespaceOpenApiRoutes,
  createTableRoutes,
} from "./tables";
import { invalidateTableRegistry } from "../../schema/table-registry";
import { invalidateNamespaceSchema } from "../../serialization/schemaRegistry";

const NS = "rest-atomicity-http";

let tmpRoot = "";
let nsDir = "";
const originalNsPath = process.env.DUCKBRAIN_NAMESPACES_PATH;
const originalDurability = process.env.DUCKBRAIN_DURABILITY_MODE;

const CUSTOMERS = [
  JSON.stringify({ id: "c1", name: "Ada", tier: "gold" }),
  JSON.stringify({ id: "c2", name: "Grace", tier: "gold" }),
];
const ORDERS = [
  JSON.stringify({ id: "o1", customer_id: "c1", total: 10 }),
  JSON.stringify({ id: "o2", customer_id: "c2", total: 20 }),
];

function schemaDocument(): unknown {
  return {
    schemaVersion: 1,
    tables: {
      customers: {
        schemaVersion: 1,
        storage: { path: "tables/customers/current.jsonl" },
        rowShape: "object",
        keyColumns: ["id"],
        columns: [
          { name: "id", type: "string", nullable: false },
          { name: "name", type: "string", nullable: false },
          { name: "tier", type: "string", nullable: true },
        ],
      },
      orders: {
        schemaVersion: 1,
        storage: { path: "tables/orders/current.jsonl" },
        rowShape: "object",
        keyColumns: ["id"],
        columns: [
          { name: "id", type: "string", nullable: false },
          {
            name: "customer_id",
            type: "string",
            nullable: true,
            references: { table: "customers", column: "id" },
          },
          { name: "total", type: "float64", nullable: false },
        ],
      },
    },
    views: {},
  };
}

function writeFile(relative: string, lines: string[]): void {
  const file = path.join(nsDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n") + "\n");
}

function resetFixture(): void {
  fs.rmSync(path.join(nsDir, "tables"), { recursive: true, force: true });
  fs.rmSync(path.join(nsDir, "_audit"), { recursive: true, force: true });
  fs.writeFileSync(
    path.join(nsDir, "schema.json"),
    JSON.stringify(schemaDocument(), null, 2) + "\n",
  );
  writeFile("tables/customers/current.jsonl", CUSTOMERS);
  writeFile("tables/orders/current.jsonl", ORDERS);
  invalidateNamespaceSchema(NS);
  invalidateTableRegistry(NS);
}

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(`/api/ns/:ns/tables`, createTableRoutes());
  app.use(`/api/ns/:ns/openapi.json`, createNamespaceOpenApiRoutes());
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.status || 500).json({ error: err.message, code: err.code });
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
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : 0;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const http = require("http");
      const request = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: reqPath,
          method,
          headers: {
            Host: "localhost",
            ...(opts.body !== undefined
              ? { "Content-Type": "application/json" }
              : {}),
            ...(opts.headers || {}),
          },
        },
        (response: any) => {
          let data = "";
          response.on("data", (chunk: Buffer) => {
            data += chunk.toString();
          });
          response.on("end", () => {
            server.close();
            let parsed: any = data;
            try {
              parsed = JSON.parse(data);
            } catch {
              // non-JSON body — keep raw text
            }
            resolve({
              status: response.statusCode ?? 0,
              body: parsed,
              headers: response.headers,
              text: data,
            });
          });
        },
      );
      request.on("error", (error: Error) => {
        server.close();
        reject(error);
      });
      if (opts.body !== undefined) request.write(JSON.stringify(opts.body));
      request.end();
    });
  });
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rest-atomicity-http-"));
  nsDir = path.join(tmpRoot, NS);
  fs.mkdirSync(nsDir, { recursive: true });
  process.env.DUCKBRAIN_NAMESPACES_PATH = tmpRoot;
  process.env.DUCKBRAIN_DURABILITY_MODE = "fsync";
  resetFixture();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (originalNsPath === undefined) delete process.env.DUCKBRAIN_NAMESPACES_PATH;
  else process.env.DUCKBRAIN_NAMESPACES_PATH = originalNsPath;
  if (originalDurability === undefined)
    delete process.env.DUCKBRAIN_DURABILITY_MODE;
  else process.env.DUCKBRAIN_DURABILITY_MODE = originalDurability;
});

beforeEach(() => {
  resetFixture();
});

const base = `/api/ns/${NS}/tables`;

describe("PUT /tables/:table/:pk — upsert over HTTP", () => {
  it("answers 201 with outcome=inserted for a new key", async () => {
    const app = createApp();
    const res = await httpRequest(app, "PUT", `${base}/customers/c3`, {
      body: { name: "Linus" },
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      outcome: "inserted",
      inserted: true,
      row: { id: "c3", name: "Linus", tier: null },
    });
    expect(res.headers["x-durability"]).toBe("fsync");
  });

  it("answers 200 with outcome=updated for an existing key and keeps ONE row", async () => {
    const app = createApp();
    const first = await httpRequest(app, "PUT", `${base}/customers/c1`, {
      body: { name: "Ada L.", tier: "platinum" },
    });
    expect(first.status).toBe(200);
    expect(first.body.outcome).toBe("updated");
    expect(first.body.row).toEqual({
      id: "c1",
      name: "Ada L.",
      tier: "platinum",
    });
    const second = await httpRequest(app, "PUT", `${base}/customers/c1`, {
      body: { name: "Ada Lovelace" },
    });
    expect(second.status).toBe(200);
    const rows = fs
      .readFileSync(path.join(nsDir, "tables/customers/current.jsonl"), "utf-8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
    expect(rows.filter((row: any) => row.id === "c1")).toHaveLength(1);
    expect(rows.find((row: any) => row.id === "c1").name).toBe("Ada Lovelace");
  });

  it("answers 404 for an undeclared table", async () => {
    const app = createApp();
    const res = await httpRequest(app, "PUT", `${base}/invoices/x1`, {
      body: { total: 1 },
    });
    expect(res.status).toBe(404);
  });

  it("answers 409 when the body contradicts the resource key", async () => {
    const app = createApp();
    const res = await httpRequest(app, "PUT", `${base}/customers/c1`, {
      body: { id: "c2", name: "Wrong" },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PRIMARY_KEY_CONFLICT");
  });
});

describe("POST /tables/_transaction — envelope over HTTP", () => {
  it("applies an ordered envelope and reports every action", async () => {
    const app = createApp();
    const res = await httpRequest(app, "POST", `${base}/_transaction`, {
      body: {
        actions: [
          { op: "insert", table: "orders", row: { id: "o9", customer_id: "c1", total: 99 } },
          { op: "update", table: "customers", pk: "eq.c2", patch: { tier: "silver" } },
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(2);
    expect(res.body.results.map((r: any) => r.outcome)).toEqual([
      "inserted",
      "updated",
    ]);
    expect(res.headers["x-durability"]).toBe("fsync");
  });

  it("answers with applied:0 and rolls back when an action fails", async () => {
    const app = createApp();
    const before = fs.readFileSync(
      path.join(nsDir, "tables/orders/current.jsonl"),
    );
    const res = await httpRequest(app, "POST", `${base}/_transaction`, {
      body: {
        actions: [
          { op: "insert", table: "orders", row: { id: "o9", total: 1 } },
          { op: "delete", table: "orders", pk: "eq.nope" },
        ],
      },
    });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      applied: 0,
      rolledBack: true,
      failedAction: 1,
      code: "NOT_FOUND",
    });
    expect(
      fs
        .readFileSync(path.join(nsDir, "tables/orders/current.jsonl"))
        .equals(before),
    ).toBe(true);
  });

  it("answers 400 for an unknown op", async () => {
    const app = createApp();
    const res = await httpRequest(app, "POST", `${base}/_transaction`, {
      body: { actions: [{ op: "teleport", table: "orders" }] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("unknown op");
  });

  it("is not shadowed by the :table insert route", async () => {
    const app = createApp();
    const res = await httpRequest(app, "POST", `${base}/_transaction`, {
      body: { actions: [] },
    });
    // The envelope's own validation answers — not "Table '_transaction' not found".
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("at least one action");
  });
});

describe("GET /tables/:table?embed= — declared relation embedding", () => {
  it("embeds the referenced row", async () => {
    const app = createApp();
    const res = await httpRequest(app, "GET", `${base}/orders?embed=customers`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].customers).toEqual({
      id: "c1",
      name: "Ada",
      tier: "gold",
    });
  });

  it("answers 400 for an undeclared relation", async () => {
    const app = createApp();
    const res = await httpRequest(app, "GET", `${base}/orders?embed=invoices`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("declares no reference");
  });
});

describe("REST-ATOMICITY-001: the new verbs are in the generated OpenAPI", () => {
  it("documents the upsert resource and the transaction envelope", async () => {
    const app = createApp();
    const res = await httpRequest(
      app,
      "GET",
      `/api/ns/${NS}/openapi.json`,
    );
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.paths)).toContain(
      `/api/ns/${NS}/tables/customers/{pk}`,
    );
    expect(res.body.paths[`/api/ns/${NS}/tables/customers/{pk}`].put.operationId).toBe(
      "upsert_customers",
    );
    expect(
      res.body.paths[`/api/ns/${NS}/tables/_transaction`].post.operationId,
    ).toBe("run_table_transaction");
  });
});
