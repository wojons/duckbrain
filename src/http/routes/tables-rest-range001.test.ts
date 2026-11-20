/**
 * REST-RANGE-001 — `Range` request support and `Content-Range` response
 * headers on the declared-table GET.
 *
 * The defect this pins: the table read had no `Range` support and emitted no
 * `Content-Range`, so postgrest-js `.range(from, to)` silently re-read page 1
 * for every page — a JS client could not paginate at all.
 *
 * Cases (the ACs, one `it` each):
 *   1. `Range: 10-19`, no count requested → exactly rows 10..19, and
 *      `Content-Range: 10-19/<total-or-*>` (total unknown, never fabricated);
 *   2. `Prefer: count=exact` → `Content-Range: 10-19/25` plus `X-Total-Count`;
 *   3. `Range` + count together → both headers on the same response;
 *   4. a window starting at/after the end → 200 `[]` + `Content-Range:
 *      (star)/25`, never clamped back onto the last page;
 *   5. `Content-Range` present on EVERY table GET (plain read, limit/offset
 *      read, empty table) — not only when a count was requested;
 *   6. `count=planned` / `count=estimated` are served as the exact total
 *      (the documented choice), and a malformed window is a 400.
 *
 * Fixture: a `rows` table of 25 objects whose `pos` column is the 0-based row
 * position, so a Range window and the returned rows compare element-for-element
 * without arithmetic in the assertions. Mounted on the real route stack over an
 * Express app (the same layout as tables-supa3.test.ts); no daemon, no port
 * other than an ephemeral loopback one.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import express, { Request, Response, NextFunction } from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { createServer, type Server } from "http";
import { createTableRoutes } from "./tables";
import { invalidateTableRegistry } from "../../schema/table-registry";

const FIXTURE_NS = "rest-range-fixture";
const ROW_COUNT = 25;

let nsDir = "";
let tmpRoot = "";

function writeFixture(): void {
  fs.mkdirSync(path.join(nsDir, "tables"), { recursive: true });

  fs.writeFileSync(
    path.join(nsDir, "tables", "rows.table.json"),
    JSON.stringify({
      name: "rows",
      format: "jsonl-objects",
      columns: [
        { name: "pos", type: "integer" },
        { name: "label", type: "varchar" },
      ],
      primary: "pos",
      glob: "tables/rows.jsonl",
    }),
  );

  fs.writeFileSync(
    path.join(nsDir, "tables", "rows.jsonl"),
    Array.from({ length: ROW_COUNT }, (_, pos) =>
      JSON.stringify({ pos, label: `row-${String(pos).padStart(2, "0")}` }),
    ).join("\n") + "\n",
  );

  // Declared but never written: the empty-table arm of "Content-Range is
  // emitted on EVERY table GET" (a table with no files must still answer with
  // the header rather than omitting it).
  fs.writeFileSync(
    path.join(nsDir, "tables", "empty.table.json"),
    JSON.stringify({
      name: "empty",
      format: "jsonl-objects",
      columns: [
        { name: "pos", type: "integer" },
        { name: "label", type: "varchar" },
      ],
      primary: "pos",
      glob: "tables/empty.jsonl",
    }),
  );
}

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(`/api/ns/:ns/tables`, createTableRoutes());
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
  opts: { headers?: Record<string, string> } = {},
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
        headers: { Host: "localhost", ...(opts.headers || {}) },
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
            // non-JSON (CSV/text) — return the raw body
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
      req.end();
    });
  });
}

const BASE = `/api/ns/${FIXTURE_NS}/tables`;

/** The `pos` values of a response body, in the order they were returned. */
function positions(body: any): number[] {
  return (body as Array<{ pos: number }>).map((row) => row.pos);
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rest-range001-"));
  nsDir = path.join(tmpRoot, FIXTURE_NS);
  process.env.DUCKBRAIN_NAMESPACES_PATH = tmpRoot;
  writeFixture();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("REST-RANGE-001: Range + Content-Range on table GET", () => {
  beforeEach(() => {
    invalidateTableRegistry(FIXTURE_NS);
  });

  it("serves rows 10-19 for Range: 10-19 with Content-Range: 10-19/* (no count requested)", async () => {
    const res = await httpRequest(createApp(), "GET", `${BASE}/rows?order=pos.asc`, {
      headers: { Range: "10-19" },
    });
    expect(res.status).toBe(200);
    expect(positions(res.body)).toEqual([
      10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    ]);
    // No count was asked for, so the total is genuinely unknown: `*`, never a
    // made-up number.
    expect(res.headers["content-range"]).toBe("10-19/*");
    expect(res.headers["x-total-count"]).toBeUndefined();
  });

  it("puts the exact total in Content-Range under Prefer: count=exact", async () => {
    const res = await httpRequest(createApp(), "GET", `${BASE}/rows?order=pos.asc`, {
      headers: { Prefer: "count=exact", Range: "10-19" },
    });
    expect(res.status).toBe(200);
    expect(positions(res.body)).toEqual([
      10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    ]);
    expect(res.headers["content-range"]).toBe(`10-19/${ROW_COUNT}`);
    // The pre-existing header keeps working alongside the new one.
    expect(res.headers["x-total-count"]).toBe(String(ROW_COUNT));
  });

  it("emits Content-Range on a GET that sends neither Range nor a count", async () => {
    const res = await httpRequest(createApp(), "GET", `${BASE}/rows?order=pos.asc`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(ROW_COUNT);
    expect(res.headers["content-range"]).toBe(`0-${ROW_COUNT - 1}/*`);
  });

  it("reports the limit/offset window it actually served", async () => {
    const res = await httpRequest(
      createApp(),
      "GET",
      `${BASE}/rows?order=pos.asc&limit=3&offset=5`,
    );
    expect(res.status).toBe(200);
    expect(positions(res.body)).toEqual([5, 6, 7]);
    expect(res.headers["content-range"]).toBe("5-7/*");
  });

  it("returns 200 [] with Content-Range: */25 when the window starts past the end", async () => {
    const res = await httpRequest(
      createApp(),
      "GET",
      `${BASE}/rows?order=pos.asc`,
      { headers: { Range: "25-34", Prefer: "count=exact" } },
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    // AC-4: an out-of-range start is an empty page, NOT a clamp back onto the
    // last page (which would make a paging loop spin forever).
    expect(res.headers["content-range"]).toBe(`*/${ROW_COUNT}`);
  });

  it("reports */<total> for a window that starts exactly at the end", async () => {
    // `from >= total` includes the boundary: row 25 in a 25-row table is past
    // the last row (0-based indexes are 0..24).
    const res = await httpRequest(createApp(), "GET", `${BASE}/rows?order=pos.asc`, {
      headers: { Range: "25-25", Prefer: "count=exact" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(res.headers["content-range"]).toBe(`*/${ROW_COUNT}`);
  });

  it("lets Range outrank ?limit and ?offset", async () => {
    const res = await httpRequest(
      createApp(),
      "GET",
      `${BASE}/rows?order=pos.asc&limit=2&offset=0`,
      { headers: { Range: "20-21" } },
    );
    expect(res.status).toBe(200);
    expect(positions(res.body)).toEqual([20, 21]);
    expect(res.headers["content-range"]).toBe("20-21/*");
  });

  it("accepts an items= unit prefix and an open-ended Range", async () => {
    const prefixed = await httpRequest(
      createApp(),
      "GET",
      `${BASE}/rows?order=pos.asc`,
      { headers: { Range: "items=3-5" } },
    );
    expect(prefixed.status).toBe(200);
    expect(positions(prefixed.body)).toEqual([3, 4, 5]);
    expect(prefixed.headers["content-range"]).toBe("3-5/*");

    // `10-` = "from row 10, one page" (the default limit keeps it bounded).
    const open = await httpRequest(createApp(), "GET", `${BASE}/rows?order=pos.asc`, {
      headers: { Range: "10-" },
    });
    expect(open.status).toBe(200);
    expect(positions(open.body)).toEqual(
      Array.from({ length: ROW_COUNT - 10 }, (_, i) => 10 + i),
    );
    expect(open.headers["content-range"]).toBe(`10-${ROW_COUNT - 1}/*`);
  });

  it("serves count=planned and count=estimated as the exact total (documented choice)", async () => {
    for (const mode of ["planned", "estimated"]) {
      const viaPrefer = await httpRequest(
        createApp(),
        "GET",
        `${BASE}/rows?order=pos.asc`,
        { headers: { Prefer: `count=${mode}`, Range: "0-4" } },
      );
      expect(viaPrefer.status).toBe(200);
      expect(viaPrefer.headers["content-range"]).toBe(`0-4/${ROW_COUNT}`);
      expect(viaPrefer.headers["x-total-count"]).toBe(String(ROW_COUNT));

      const viaQuery = await httpRequest(
        createApp(),
        "GET",
        `${BASE}/rows?order=pos.asc&count=${mode}&limit=2`,
      );
      expect(viaQuery.status).toBe(200);
      expect(viaQuery.headers["content-range"]).toBe(`0-1/${ROW_COUNT}`);
    }
  });

  it("emits Content-Range on an empty table and on a CSV read", async () => {
    const empty = await httpRequest(createApp(), "GET", `${BASE}/empty`, {
      headers: { Prefer: "count=exact" },
    });
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual([]);
    expect(empty.headers["content-range"]).toBe("*/0");

    const csv = await httpRequest(
      createApp(),
      "GET",
      `${BASE}/rows?order=pos.asc`,
      { headers: { Accept: "text/csv", Range: "0-1" } },
    );
    expect(csv.status).toBe(200);
    expect(String(csv.headers["content-type"])).toContain("text/csv");
    expect(csv.headers["content-range"]).toBe("0-1/*");
    expect(csv.text.trim().split("\n")).toHaveLength(3); // header + 2 rows
  });

  it("400s a malformed Range window instead of silently reading the whole table", async () => {
    const bad = await httpRequest(createApp(), "GET", `${BASE}/rows`, {
      headers: { Range: "10" },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("VALIDATION_ERROR");
    expect(bad.body.error).toContain("Range");

    const reversed = await httpRequest(createApp(), "GET", `${BASE}/rows`, {
      headers: { Range: "19-10" },
    });
    expect(reversed.status).toBe(400);
    expect(reversed.body.code).toBe("VALIDATION_ERROR");
  });
});
