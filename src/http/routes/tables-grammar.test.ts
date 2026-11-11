/**
 * REST-LOGIC-FILTERS-001 — PostgREST LOGICAL filter groups are REFUSED, never
 * silently dropped.
 *
 * The defect: `filterParams()` (src/tables/operations.ts) skipped any query key
 * that was not a declared column unless its VALUE matched `^[a-z]+\.`. A
 * logical group like `?or=(id.eq.1,id.eq.2)` is neither, so it fell through
 * both branches and the request answered 200 with EVERY row while the caller
 * believed the filter applied — a silent wrong answer.
 *
 * These tests pin the replacement contract:
 *   AC1  `?or=(…)` → 400 `UNSUPPORTED_QUERY`, the operator named in the error.
 *   AC2  same for `?and=` and `?not.and=` (plus `?not.or=`).
 *   AC3  `?or=` next to a valid column filter fails the WHOLE request (and the
 *        same valid filter alone still returns exactly one row, so the refusal
 *        is attributable to the logical group, not a broken filter path).
 *   AC4  the refusal returns no rows at all.
 *
 * Hermetic: `DUCKBRAIN_NAMESPACES_PATH` points at a temp root; the repo's own
 * namespaces tree is never touched.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { createServer, type Server } from "http";
import { createHttpServer } from "../../cli/http";
import { invalidateTableRegistry } from "../../schema/table-registry";
import { removeTempDirSafely } from "../../testing/race-safe-daemon";
import { tableSelectTool } from "../../mcp/tools/tables";
import type { McpToolContext } from "../../mcp/tools/shared";

const FIXTURE_NS = "logic-filters";

let tmpRoot = "";

function writeFixture(): void {
  const tablesDir = path.join(tmpRoot, FIXTURE_NS, "tables");
  fs.mkdirSync(tablesDir, { recursive: true });

  fs.writeFileSync(
    path.join(tablesDir, "widgets.table.json"),
    JSON.stringify({
      name: "widgets",
      format: "jsonl-objects",
      columns: [
        { name: "id", type: "integer" },
        { name: "name", type: "varchar" },
        { name: "qty", type: "integer" },
      ],
      primary: "id",
      glob: "tables/widgets.jsonl",
    }),
  );
  fs.writeFileSync(
    path.join(tablesDir, "widgets.jsonl"),
    [
      JSON.stringify({ id: 1, name: "alpha", qty: 5 }),
      JSON.stringify({ id: 2, name: "beta", qty: 10 }),
      JSON.stringify({ id: 3, name: "gamma", qty: 15 }),
    ].join("\n") + "\n",
  );
}

interface HttpResult {
  status: number;
  body: any;
}

/** GET one path against a fresh app instance (no long-lived listener). */
function httpGet(
  app: ReturnType<typeof createHttpServer>,
  reqPath: string,
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
          method: "GET",
          headers: { Host: "localhost" },
        },
        (res: http.IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf-8");
            server.close();
            resolve({
              status: res.statusCode ?? 0,
              body: text.length > 0 ? JSON.parse(text) : null,
            });
          });
        },
      );
      req.on("error", (error) => {
        server.close();
        reject(error);
      });
      req.end();
    });
  });
}

/** Assert the shape of a refusal: 400 + code + the operator named, no rows. */
function expectRefusal(res: HttpResult, operator: string): void {
  expect(res.status).toBe(400);
  expect(res.body.code).toBe("UNSUPPORTED_QUERY");
  // The offending control key is machine-readable in fields.operator …
  expect(res.body.fields).toEqual({ operator });
  // … and named in the message too — `'or'` quoted, so the assertion cannot
  // pass on a substring of "order"/"oracle".
  expect(res.body.error).toContain(`'${operator}'`);
  expect(res.body.error).toContain("logical filter");
  // AC4: no rows came back, in any shape (array body or {rows: …} envelope).
  expect(Array.isArray(res.body)).toBe(false);
  expect(res.body.rows).toBeUndefined();
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "logic-filters-test-"));
  process.env.DUCKBRAIN_NAMESPACES_PATH = tmpRoot;
  process.env.DUCKBRAIN_CONFIG_PATH = path.join(tmpRoot, "duckbrain.config.json");
  writeFixture();
});

afterAll(async () => {
  await removeTempDirSafely(tmpRoot);
});

describe("REST-LOGIC-FILTERS-001: logical filter groups are refused, not dropped", () => {
  const base = `/api/ns/${FIXTURE_NS}/tables`;

  beforeEach(() => {
    invalidateTableRegistry(FIXTURE_NS);
  });

  it("AC1: ?or= returns 400 UNSUPPORTED_QUERY naming 'or'", async () => {
    const res = await httpGet(
      createHttpServer({ authType: "none" }),
      `${base}/widgets?or=(id.eq.1,id.eq.2)`,
    );
    expectRefusal(res, "or");
  });

  it("AC2: ?and= returns 400 UNSUPPORTED_QUERY naming 'and'", async () => {
    const res = await httpGet(
      createHttpServer({ authType: "none" }),
      `${base}/widgets?and=(id.eq.1,id.eq.2)`,
    );
    expectRefusal(res, "and");
  });

  it("AC2: ?not.and= returns 400 UNSUPPORTED_QUERY naming 'not.and'", async () => {
    const res = await httpGet(
      createHttpServer({ authType: "none" }),
      `${base}/widgets?not.and=(id.eq.1,id.eq.2)`,
    );
    expectRefusal(res, "not.and");
  });

  it("AC2: ?not.or= returns 400 UNSUPPORTED_QUERY naming 'not.or'", async () => {
    const res = await httpGet(
      createHttpServer({ authType: "none" }),
      `${base}/widgets?not.or=(id.eq.1,id.eq.2)`,
    );
    expectRefusal(res, "not.or");
  });

  it("AC3: a valid column filter alone still returns exactly one row", async () => {
    const res = await httpGet(
      createHttpServer({ authType: "none" }),
      `${base}/widgets?id=eq.2`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 2, name: "beta", qty: 10 }]);
  });

  it("AC3+AC4: ?or= next to a valid column filter fails the WHOLE request", async () => {
    const res = await httpGet(
      createHttpServer({ authType: "none" }),
      `${base}/widgets?id=eq.2&or=(id.eq.1,id.eq.2)`,
    );
    // Not 200-with-one-row (the valid filter applied) and not 200-with-every-row
    // (both dropped): the request is refused as a unit, no partial WHERE.
    expectRefusal(res, "or");
  });

  it("the MCP table_select transport is refused by the same shared check", async () => {
    const adminContext: McpToolContext = {
      principal: { name: "logic-filters-admin", authenticated: true, roles: ["admin"] },
    };
    const res = await tableSelectTool(
      {
        namespace: FIXTURE_NS,
        table: "widgets",
        filters: { or: "(id.eq.1,id.eq.2)" },
      },
      adminContext,
    );
    expect(res.success).toBe(false);
    expect(res.code).toBe("UNSUPPORTED_QUERY");
    expect(String(res.error)).toContain("'or'");
    expect(res.rows).toBeUndefined();
  });
});
