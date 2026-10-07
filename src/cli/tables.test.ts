/**
 * SUPA6-DECLARE-GAP-001 — `duckbrain tables declare` battery.
 *
 * The declare verb is proven against the REAL validators, never mocks:
 *
 *   - the written schema.json is loaded through the production
 *     loadNamespaceSchema (schemaRegistry.ts) and must come back
 *     `present: true, error: null`;
 *   - the --legacy declaration is proven through the production legacy
 *     registry (listTables throws on an invalid declaration file);
 *   - the end-to-end case drives createHttpServer({ authType: "none" }) —
 *     the same production wiring http-tables-ndjson-supa3.test.ts uses —
 *     over a real 127.0.0.1 socket, proving a fresh declare makes the
 *     generic table→REST layer reachable (OpenAPI path + 201 insert).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { createServer, type Server } from "http";
import { runTablesCli, TablesCliError } from "./tables";
import { createHttpServer } from "./http";
import { removeTempDirSafely } from "../testing/race-safe-daemon";
import {
  invalidateTableRegistry,
  listTables,
} from "../schema/table-registry";
import {
  invalidateNamespaceSchema,
  loadNamespaceSchema,
} from "../serialization/schemaRegistry";

const NS = "e2e-supagap";

let tmpRoot = "";

interface HttpResult {
  status: number;
  body: any;
  text: string;
}

/** One request against `app` over a real 127.0.0.1 socket. */
function httpRequest(
  app: ReturnType<typeof createHttpServer>,
  method: string,
  reqPath: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr !== "string" ? addr.port : 0;
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: reqPath,
          method,
          headers: {
            Host: "localhost",
            ...(opts.headers || {}),
          },
        },
        (res) => {
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
              // non-JSON body — keep the raw text
            }
            resolve({ status: res.statusCode ?? 0, body: parsed, text: data });
          });
        },
      );
      req.on("error", (err: Error) => {
        server.close();
        reject(err);
      });
      if (opts.body !== undefined) req.write(opts.body);
      req.end();
    });
  });
}

function loadReal(ns: string): ReturnType<typeof loadNamespaceSchema> {
  invalidateNamespaceSchema(ns);
  return loadNamespaceSchema(ns, { namespacesPath: tmpRoot, force: true });
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tables-declare-gap-"));
  process.env.DUCKBRAIN_NAMESPACES_PATH = tmpRoot;
});

afterAll(async () => {
  // INT-CI-026 class: the in-process daemon's async writes (serializer flush
  // / audit ledger) can still be landing inside tmpRoot at teardown —
  // bounded-retry removal per the race-safe pattern.
  await removeTempDirSafely(tmpRoot);
});

describe("duckbrain tables declare (SUPA6-DECLARE-GAP-001)", () => {
  it("AC1: declares schema.json that the REAL registry loader validates", async () => {
    const code = await runTablesCli([
      "declare",
      NS,
      "widgets",
      "--column",
      "id=integer",
      "--column",
      "name=varchar",
      "--primary",
      "id",
    ]);
    expect(code).toBe(0);

    const file = path.join(tmpRoot, NS, "schema.json");
    expect(fs.existsSync(file)).toBe(true);

    // REAL loader — no mock of the validator anywhere in this battery.
    const loaded = loadReal(NS);
    expect(loaded.present).toBe(true);
    expect(loaded.error).toBeNull();
    const widgets = loaded.document.tables.widgets;
    expect(widgets).toBeDefined();
    expect(widgets!.keyColumns).toEqual(["id"]);
    expect(widgets!.rowShape).toBe("object");
    expect(widgets!.columns[0]).toEqual({
      name: "id",
      type: "float64",
      nullable: false,
    });
    expect(widgets!.columns[1]).toEqual({
      name: "name",
      type: "string",
      nullable: true,
    });

    // The switch must be journaled in the DDL journal directory so later
    // crash recovery stays classifiable.
    const journalDir = path.join(tmpRoot, NS, ".duckbrain-ddl");
    expect(fs.readdirSync(journalDir).some((f) => f.endsWith(".json"))).toBe(
      true,
    );
  });

  it("merges a second table into the same schema.json", async () => {
    const code = await runTablesCli([
      "declare",
      NS,
      "gadgets",
      "--column",
      "id=integer",
    ]);
    expect(code).toBe(0);
    const loaded = loadReal(NS);
    expect(Object.keys(loaded.document.tables).sort()).toEqual([
      "gadgets",
      "widgets",
    ]);
  });

  it("refuses a different contract without --force; replaces with it", async () => {
    const refused = await runTablesCli([
      "declare",
      NS,
      "widgets",
      "--column",
      "id=integer",
      "--column",
      "other=varchar",
    ]);
    expect(refused).toBe(1);
    // The refused declare must not have mutated the document.
    expect(
      loadReal(NS).document.tables.widgets!.columns.some(
        (c) => c.name === "other",
      ),
    ).toBe(false);

    const forced = await runTablesCli([
      "declare",
      NS,
      "widgets",
      "--column",
      "id=integer",
      "--column",
      "other=varchar",
      "--force",
    ]);
    expect(forced).toBe(0);
    expect(
      loadReal(NS).document.tables.widgets!.columns.some(
        (c) => c.name === "other",
      ),
    ).toBe(true);

    // Restore the AC1 contract so the end-to-end case below can POST
    // {"id": 1, "name": "a"} against widgets as freshly declared.
    const restored = await runTablesCli([
      "declare",
      NS,
      "widgets",
      "--column",
      "id=integer",
      "--column",
      "name=varchar",
      "--primary",
      "id",
      "--force",
    ]);
    expect(restored).toBe(0);
  });

  it("--legacy writes a declaration the legacy table registry accepts", async () => {
    const code = await runTablesCli([
      "declare",
      NS,
      "legacy_items",
      "--column",
      "id=integer",
      "--column",
      "note=varchar",
      "--legacy",
    ]);
    expect(code).toBe(0);
    expect(
      fs.existsSync(path.join(tmpRoot, NS, "tables", "legacy_items.table.json")),
    ).toBe(true);
    // REAL legacy validator: listTables throws on an invalid declaration.
    invalidateTableRegistry(NS);
    const names = listTables(NS).map((t) => t.name);
    expect(names).toContain("legacy_items");
    expect(names).toContain("widgets");
  });

  it("AC3: invalid column type exits nonzero with a clear error", async () => {
    await expect(
      runTablesCli(["declare", NS, "broken", "--column", "id=floobits"]),
    ).rejects.toBeInstanceOf(TablesCliError);
    await expect(
      runTablesCli(["declare", NS, "broken", "--column", "id=floobits"]),
    ).rejects.toThrow(/unsupported column type 'floobits'/);
    // Nothing may have been written for the failed declare.
    expect(fs.existsSync(path.join(tmpRoot, NS, "schema.json"))).toBe(true); // still the valid one
    expect(loadReal(NS).document.tables.broken).toBeUndefined();
  });

  it("AC3: invalid table and namespace names are refused", async () => {
    await expect(
      runTablesCli(["declare", NS, "Bad Table", "--column", "id=integer"]),
    ).rejects.toThrow(/must match/);
    await expect(
      runTablesCli(["declare", "UPPER", "things", "--column", "id=integer"]),
    ).rejects.toThrow(/must match/);
    expect(fs.existsSync(path.join(tmpRoot, "UPPER"))).toBe(false);
  });

  it("AC2: end-to-end — the REST layer serves the freshly declared table", async () => {
    invalidateTableRegistry(NS);
    const BASE = `/api/ns/${NS}`;

    const openapi = await httpRequest(
      createHttpServer({ authType: "none" }),
      "GET",
      `${BASE}/openapi.json`,
    );
    expect(openapi.status).toBe(200);
    expect(Object.keys(openapi.body.paths)).toContain(
      `${BASE}/tables/widgets`,
    );

    const post = await httpRequest(
      createHttpServer({ authType: "none" }),
      "POST",
      `${BASE}/tables/widgets`,
      {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: 1, name: "a" }),
      },
    );
    expect(post.status).toBe(201);
    expect(post.body).toEqual({ inserted: 1 });

    // The inserted row must read back through the same production app.
    const read = await httpRequest(
      createHttpServer({ authType: "none" }),
      "GET",
      `${BASE}/tables/widgets?id=gte.0&order=id.asc`,
    );
    expect(read.status).toBe(200);
    expect(read.body.map((r: any) => r.id)).toEqual([1]);
    expect(read.body.map((r: any) => r.name)).toEqual(["a"]);
  });
});
