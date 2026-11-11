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
 *   REST-SELECT-001 covers `?select=id`, unknown columns, declared relation embeds,
 *   and MCP parity.
 *
 * REST-SELECT-001 traceability:
 * ch:trace row=REST-SELECT-001 spec=.coding-hermes/board/tasks.jsonl#acceptance_criteria wave=.coding-hermes/waves/duckbrain-foreman-2026-11-11-10-16-08.json test=src/http/routes/tables-grammar.test.ts evidence=none:worker-commit-will-be-bound-by-foreman witness=none:ephemeral-worker-verification verdict=none:foreman-will-run commit=none:foreman-will-bind memory=none:foreman-will-write
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
        {
          name: "child_id",
          type: "integer",
          references: { table: "children", column: "id" },
        },
      ],
      primary: "id",
      glob: "tables/widgets.jsonl",
    }),
  );
  fs.writeFileSync(
    path.join(tablesDir, "children.table.json"),
    JSON.stringify({
      name: "children",
      format: "jsonl-objects",
      columns: [
        { name: "id", type: "integer" },
        { name: "label", type: "varchar" },
      ],
      primary: "id",
      glob: "tables/children.jsonl",
    }),
  );
  fs.writeFileSync(
    path.join(tablesDir, "children.jsonl"),
    JSON.stringify({ id: 7, label: "child" }) + "\n",
  );
  fs.writeFileSync(
    path.join(tablesDir, "widgets.jsonl"),
    [
      JSON.stringify({ id: 1, name: "alpha", qty: 5, child_id: 7 }),
      JSON.stringify({ id: 2, name: "beta", qty: 10, child_id: 7 }),
      JSON.stringify({ id: 3, name: "gamma", qty: 15, child_id: null }),
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
  headers: Record<string, string> = {},
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
          headers: { Host: "localhost", ...headers },
        },
        (res: http.IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf-8");
            server.close();
            resolve({
              status: res.statusCode ?? 0,
              body:
                res.headers["content-type"]?.includes("text/csv")
                  ? text
                  : text.length > 0
                    ? JSON.parse(text)
                    : null,
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
  process.env.DUCKBRAIN_CONFIG_PATH = path.join(
    tmpRoot,
    "duckbrain.config.json",
  );
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
    expect(res.body).toEqual([{ id: 2, name: "beta", qty: 10, child_id: 7 }]);
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

  it("REST-SELECT-001: ?select=id returns only the selected key", async () => {
    const res = await httpGet(
      createHttpServer({ authType: "none" }),
      `${base}/widgets?select=id`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    for (const row of res.body) expect(Object.keys(row)).toEqual(["id"]);
  });

  it("REST-SELECT-001: CSV ?select=id has one cell per row", async () => {
    const res = await httpGet(
      createHttpServer({ authType: "none" }),
      `${base}/widgets?select=id`,
      { Accept: "text/csv" },
    );
    expect(res.status).toBe(200);
    const lines = String(res.body).trim().split("\r\n");
    expect(lines[0]).toBe("id");
    expect(lines.slice(1)).toHaveLength(3);
    for (const line of lines.slice(1)) {
      expect(line.split(",")).toHaveLength(1);
      expect(line).not.toContain(",,");
    }
  });

  it("REST-SELECT-001: CSV ?select=id,name keeps requested column order", async () => {
    const res = await httpGet(
      createHttpServer({ authType: "none" }),
      `${base}/widgets?select=id,name`,
      { Accept: "text/csv" },
    );
    expect(res.status).toBe(200);
    expect(String(res.body).split("\r\n")[0]).toBe("id,name");
  });

  it("REST-SELECT-001: CSV ?select=* keeps the declared column list", async () => {
    const res = await httpGet(
      createHttpServer({ authType: "none" }),
      `${base}/widgets?select=*`,
      { Accept: "text/csv" },
    );
    expect(res.status).toBe(200);
    expect(String(res.body).split("\r\n")[0]).toBe("id,name,qty,child_id");
  });

  it("REST-SELECT-001: CSV embeds are JSON-encoded in one escaped cell", async () => {
    const res = await httpGet(
      createHttpServer({ authType: "none" }),
      `${base}/widgets?select=*,children(*)`,
      { Accept: "text/csv" },
    );
    expect(res.status).toBe(200);
    const lines = String(res.body).trim().split("\r\n");
    expect(lines[0]).toBe("id,name,qty,child_id,children(*)");
    expect(lines[1]).toContain('"{""id"":7,""label"":""child""}"');
    expect(lines[1]).not.toContain("undefined");
  });

  it("REST-SELECT-001: unknown projection columns refuse with declared columns", async () => {
    const res = await httpGet(
      createHttpServer({ authType: "none" }),
      `${base}/widgets?select=id,nope`,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("UNKNOWN_COLUMN");
    expect(res.body.error).toContain("nope");
    expect(res.body.error).toContain("id, name, qty, child_id");
  });

  it("REST-SELECT-001: relation projection embeds the declared child", async () => {
    const res = await httpGet(
      createHttpServer({ authType: "none" }),
      `${base}/widgets?select=*,children(*)`,
    );
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ children: { id: 7, label: "child" } });
    expect(Object.keys(res.body[0])).toContain("children");
  });

  it("REST-SELECT-001: undeclared relation refuses instead of returning full rows", async () => {
    const res = await httpGet(
      createHttpServer({ authType: "none" }),
      `${base}/widgets?select=*,child(*)`,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("UNSUPPORTED_QUERY");
    expect(res.body.error).toContain("child");
  });

  it("REST-SELECT-001: MCP projection matches the shared contract", async () => {
    const adminContext: McpToolContext = {
      principal: {
        name: "projection-admin",
        authenticated: true,
        roles: ["admin"],
      },
    };
    const selected = await tableSelectTool(
      { namespace: FIXTURE_NS, table: "widgets", select: "id" },
      adminContext,
    );
    expect(selected.success).toBe(true);
    for (const row of selected.rows as Array<Record<string, unknown>>) {
      expect(Object.keys(row)).toEqual(["id"]);
    }
    const unknown = await tableSelectTool(
      { namespace: FIXTURE_NS, table: "widgets", select: "id,nope" },
      adminContext,
    );
    expect(unknown.success).toBe(false);
    expect(unknown.code).toBe("UNKNOWN_COLUMN");
  });

  it("the MCP table_select transport is refused by the same shared check", async () => {
    const adminContext: McpToolContext = {
      principal: {
        name: "logic-filters-admin",
        authenticated: true,
        roles: ["admin"],
      },
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
