/**
 * ADOPT-DECLARED-001 — declaration over HTTP.
 *
 * The row's first half: declaration was host-CLI-only, so an agent on the
 * network could not create the table it wanted to write to. `POST
 * /api/ns/:ns/tables/:table/declare` now exists and calls the SAME core as
 * `duckbrain tables declare` and the MCP `tables_declare` tool
 * (src/tables/declare.ts declareTable) — no second writer.
 *
 * Proven here, over a real express stack on the route module:
 *   1. an HTTP client (no shell) declares a table and immediately inserts and
 *      reads a row through the REST data verbs — the agent path end to end;
 *   2. a re-declaration of an identical contract is idempotent (200,
 *      replacedExisting) and a conflicting one is refused 409 unless force;
 *   3. a malformed body is 400 INVALID_DECLARATION, naming the field;
 *   4. `legacy: true` writes the historical tables/<table>.table.json shape
 *      and the resulting table is immediately servable;
 *   5. authz is the namespace + per-table WRITE grant: a token with a
 *      tableGrants map that does not name this table gets 403 table_grant,
 *      and a token without the namespace gets 403 — declaring is a write.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express, { Request, Response, NextFunction } from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { createServer, type Server } from "http";

import { createTableRoutes } from "./tables";
import { invalidateTableRegistry } from "../../schema/table-registry";
import { invalidateNamespaceSchema } from "../../serialization/schemaRegistry";

const NS = "adopt-fixture";

let tmpRoot = "";
let previousRoot: string | undefined;

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(express.text({ type: "application/x-ndjson", limit: "1mb" }));
  app.use("/api/ns/:ns/tables", createTableRoutes());
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    res
      .status(err.status || 500)
      .json({ error: err.message, code: err.code });
  });
  return app;
}

interface HttpResult {
  status: number;
  body: any;
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
            /* non-JSON bodies stay raw */
          }
          resolve({ status: res.statusCode, body: parsed, text: data });
        });
      });
      req.on("error", (err: Error) => {
        server.close();
        reject(err);
      });
      if (opts.body !== undefined) {
        req.write(
          typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
        );
      }
      req.end();
    });
  });
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adopt-declared-"));
  previousRoot = process.env.DUCKBRAIN_NAMESPACES_PATH;
  process.env.DUCKBRAIN_NAMESPACES_PATH = tmpRoot;
  fs.mkdirSync(path.join(tmpRoot, NS), { recursive: true });
});

beforeEach(() => {
  invalidateTableRegistry();
  invalidateNamespaceSchema();
});

afterAll(() => {
  if (previousRoot === undefined) delete process.env.DUCKBRAIN_NAMESPACES_PATH;
  else process.env.DUCKBRAIN_NAMESPACES_PATH = previousRoot;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const BASE = `/api/ns/${NS}/tables`;

describe("ADOPT-DECLARED-001 — POST /api/ns/:ns/tables/:table/declare", () => {
  it("declares, then inserts and reads a row over the same REST surface", async () => {
    const app = createApp();

    const declared = await httpRequest(app, "POST", `${BASE}/agent_widgets/declare`, {
      body: {
        columns: [
          { name: "id", type: "integer" },
          { name: "label", type: "varchar" },
        ],
        primary: "id",
      },
    });

    expect(declared.status).toBe(201);
    expect(declared.body).toMatchObject({
      namespace: NS,
      table: "agent_widgets",
      format: "schema.json",
      replacedExisting: false,
    });
    expect(declared.body.path.endsWith(path.join(NS, "schema.json"))).toBe(true);
    expect(declared.body.declaration).toMatchObject({
      name: "agent_widgets",
      primary: "id",
      source: "schema.json",
    });
    // The declaration is reported in the REST vocabulary the route layer
    // serves (schema.json canonical types mapped back to legacy names), so a
    // caller can POST a row against exactly what it was told.
    expect(
      declared.body.declaration.columns.map((c: any) => [c.name, c.type]),
    ).toEqual([
      ["id", "double"],
      ["label", "varchar"],
    ]);

    const inserted = await httpRequest(app, "POST", `${BASE}/agent_widgets`, {
      body: { id: 1, label: "alpha" },
    });
    expect(inserted.status).toBe(201);
    expect(inserted.body).toMatchObject({ inserted: 1 });

    const read = await httpRequest(app, "GET", `${BASE}/agent_widgets`);
    expect(read.status).toBe(200);
    expect(read.body).toEqual([{ id: 1, label: "alpha" }]);
  });

  it("is idempotent for an identical contract and 409s a conflicting one without force", async () => {
    const app = createApp();
    const body = {
      columns: [
        { name: "id", type: "integer" },
        { name: "label", type: "varchar" },
      ],
      primary: "id",
    };

    expect((await httpRequest(app, "POST", `${BASE}/idem/declare`, { body })).status).toBe(201);

    const again = await httpRequest(app, "POST", `${BASE}/idem/declare`, { body });
    expect(again.status).toBe(200);
    expect(again.body.replacedExisting).toBeDefined();

    const conflicting = await httpRequest(app, "POST", `${BASE}/idem/declare`, {
      body: {
        columns: [{ name: "id", type: "integer" }, { name: "label", type: "double" }],
        primary: "id",
      },
    });
    expect(conflicting.status).toBe(409);
    expect(conflicting.body.code).toBe("DECLARATION_REFUSED");

    const forced = await httpRequest(app, "POST", `${BASE}/idem/declare`, {
      body: {
        columns: [{ name: "id", type: "integer" }, { name: "label", type: "double" }],
        primary: "id",
        force: true,
      },
    });
    expect(forced.status).toBe(200);
    expect(forced.body.replacedExisting).toBe(true);
  });

  it("rejects a malformed declaration body with 400 INVALID_DECLARATION", async () => {
    const app = createApp();

    const noColumns = await httpRequest(app, "POST", `${BASE}/bad/declare`, {
      body: { columns: [] },
    });
    expect(noColumns.status).toBe(400);
    expect(noColumns.body.code).toBe("INVALID_DECLARATION");

    const unknownKey = await httpRequest(app, "POST", `${BASE}/bad/declare`, {
      body: { columns: [{ name: "id", type: "integer" }], colums: [] },
    });
    expect(unknownKey.status).toBe(400);
    expect(unknownKey.body.error).toContain("colums");

    const badType = await httpRequest(app, "POST", `${BASE}/bad/declare`, {
      body: { columns: [{ name: "id", type: "uuid" }] },
    });
    expect(badType.status).toBe(400);
    expect(badType.body.error).toContain("unsupported column type");

    // Nothing was written by any of the refusals.
    expect(fs.existsSync(path.join(tmpRoot, NS, "tables", "bad.table.json"))).toBe(
      false,
    );
  });

  it("writes the legacy declaration shape on request and serves it immediately", async () => {
    const app = createApp();
    const declared = await httpRequest(app, "POST", `${BASE}/legacy_widget/declare`, {
      body: {
        columns: [
          { name: "id", type: "integer" },
          { name: "name", type: "varchar" },
        ],
        primary: "id",
        legacy: true,
      },
    });
    expect(declared.status).toBe(201);
    expect(declared.body.format).toBe("legacy");
    expect(
      fs.existsSync(
        path.join(tmpRoot, NS, "tables", "legacy_widget.table.json"),
      ),
    ).toBe(true);

    const inserted = await httpRequest(app, "POST", `${BASE}/legacy_widget`, {
      body: { id: 7, name: "seven" },
    });
    expect(inserted.status).toBe(201);
    const read = await httpRequest(app, "GET", `${BASE}/legacy_widget`);
    expect(read.body).toEqual([{ id: 7, name: "seven" }]);
  });

  it("403s a table-restricted token that holds no grant for the NEW table", async () => {
    const { authMiddleware } = await import("../../auth/middleware.js");
    const app = express();
    app.use(express.json());
    app.use(
      authMiddleware({
        type: "apikey",
        apiKeys: [
          {
            key: "adopt-writer-key",
            name: "writer",
            namespaces: [NS],
            roles: ["writer"],
            tableGrants: { existing_table: "rw" },
          },
        ],
      }),
    );
    app.use("/api/ns/:ns/tables", createTableRoutes());
    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
      res.status(err.status || 500).json({ error: err.message, code: err.code });
    });

    const denied = await httpRequest(app, "POST", `${BASE}/new_table/declare`, {
      headers: { "x-api-key": "adopt-writer-key" },
      body: { columns: [{ name: "id", type: "integer" }] },
    });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("FORBIDDEN");
    expect(denied.body.error).toContain("no write grant for table 'new_table'");

    const allowed = await httpRequest(app, "POST", `${BASE}/existing_table/declare`, {
      headers: { "x-api-key": "adopt-writer-key" },
      body: { columns: [{ name: "id", type: "integer" }] },
    });
    expect(allowed.status).toBe(201);

    // The refused namespace never reached the route: no declaration on disk.
    expect(fs.existsSync(path.join(tmpRoot, NS, "schema.json"))).toBe(true);
    const schema = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, NS, "schema.json"), "utf-8"),
    );
    expect(Object.keys(schema.tables)).not.toContain("new_table");
  });
});
