/**
 * REST-PK-UNIQUENESS-001 — a duplicate primary key is REFUSED (409), never
 * silently appended.
 *
 * The defect: `insertTableRows()` only validated that an incoming row HAD a
 * declared primary key (AUG-045). A second POST carrying the same key appended
 * a SECOND row with that id, so `?pk=eq.<v>` matched two rows and a
 * PATCH/DELETE addressed by that key could hit both — silent corruption.
 *
 * These tests drive the REAL HTTP server (POST /api/ns/:ns/tables/:table and
 * GET /api/ns/:ns/tables/:table?pk=eq.<v>) against a hermetic namespace root,
 * and pin:
 *   AC1  second POST of the same key → 409 `DUPLICATE_KEY`, fields.pk names it.
 *   AC2  after the refusal, ?pk=eq.<v> returns exactly ONE row.
 *   AC3  two different keys both insert (positive control).
 *   AC4  SKIPPED: no `Idempotency-Key` header store exists in this tree
 *        (idempotency exists only for session-activity receipts), so there is
 *        nothing to hook into and no new store was built.
 *
 * Batch atomicity is pinned too: a batch with one colliding key writes NOTHING.
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

const FIXTURE_NS = "pk-uniqueness";

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
      ],
      primary: "id",
      glob: "tables/widgets.jsonl",
    }),
  );
  fs.writeFileSync(
    path.join(tablesDir, "widgets.jsonl"),
    [JSON.stringify({ id: 1, name: "alpha" })].join("\n") + "\n",
  );
}

interface HttpResult {
  status: number;
  body: any;
}

/** One request against a fresh app instance (no long-lived listener). */
function request(
  app: ReturnType<typeof createHttpServer>,
  method: string,
  reqPath: string,
  payload?: unknown,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const body =
      payload === undefined ? "" : JSON.stringify(payload as object);
    const headers: Record<string, string | number> = { Host: "localhost" };
    if (body.length > 0) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(body);
    }
    const server: Server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr !== "string" ? addr.port : 0;
      const req = http.request(
        { hostname: "127.0.0.1", port, path: reqPath, method, headers },
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
      if (body.length > 0) req.write(body);
      req.end();
    });
  });
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pk-uniqueness-test-"));
  process.env.DUCKBRAIN_NAMESPACES_PATH = tmpRoot;
  process.env.DUCKBRAIN_CONFIG_PATH = path.join(tmpRoot, "duckbrain.config.json");
  writeFixture();
});

afterAll(async () => {
  await removeTempDirSafely(tmpRoot);
});

describe("REST-PK-UNIQUENESS-001: duplicate primary keys are refused", () => {
  const table = `/api/ns/${FIXTURE_NS}/tables/widgets`;

  beforeEach(() => {
    invalidateTableRegistry(FIXTURE_NS);
  });

  it("AC1: second POST of the same key returns 409 DUPLICATE_KEY", async () => {
    const app = createHttpServer({ authType: "none" });
    const first = await request(app, "POST", table, { id: 4, name: "delta" });
    expect(first.status).toBe(201);
    expect(first.body.inserted).toBe(1);

    const second = await request(app, "POST", table, {
      id: 4,
      name: "delta-again",
    });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("DUPLICATE_KEY");
    expect(second.body.fields).toEqual({ pk: "4" });
    expect(second.body.error).toContain("id=4");
  });

  it("AC2: after the refusal, ?pk=eq.<v> returns exactly ONE row", async () => {
    const app = createHttpServer({ authType: "none" });
    await request(app, "POST", table, { id: 5, name: "epsilon" });
    const refused = await request(app, "POST", table, {
      id: 5,
      name: "epsilon-again",
    });
    expect(refused.status).toBe(409);

    const rows = await request(app, "GET", `${table}?pk=eq.5`);
    expect(rows.status).toBe(200);
    expect(Array.isArray(rows.body)).toBe(true);
    expect(rows.body).toHaveLength(1);
    expect(rows.body[0].id).toBe(5);
    // The refused payload must not have been appended under another key.
    expect(rows.body[0].name).toBe("epsilon");
  });

  it("AC3: two different keys both insert (positive control)", async () => {
    const app = createHttpServer({ authType: "none" });
    const a = await request(app, "POST", table, { id: 6, name: "zeta" });
    const b = await request(app, "POST", table, { id: 7, name: "eta" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.inserted).toBe(1);
    expect(b.body.inserted).toBe(1);

    const six = await request(app, "GET", `${table}?pk=eq.6`);
    const seven = await request(app, "GET", `${table}?pk=eq.7`);
    expect(six.body).toHaveLength(1);
    expect(seven.body).toHaveLength(1);
    expect(six.body[0].name).toBe("zeta");
    expect(seven.body[0].name).toBe("eta");
  });

  it("a batch with one colliding key writes NOTHING (all-or-nothing)", async () => {
    const app = createHttpServer({ authType: "none" });
    // id 1 is in the fixture; id 8 is fresh. The batch must be refused whole.
    const res = await request(app, "POST", table, [
      { id: 8, name: "theta" },
      { id: 1, name: "alpha-again" },
    ]);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DUPLICATE_KEY");
    expect(res.body.fields).toEqual({ pk: "1" });

    const fresh = await request(app, "GET", `${table}?pk=eq.8`);
    expect(fresh.body).toHaveLength(0);
    const existing = await request(app, "GET", `${table}?pk=eq.1`);
    expect(existing.body).toHaveLength(1);
    expect(existing.body[0].name).toBe("alpha");
  });

  it("keys repeated inside one batch are refused before any write", async () => {
    const app = createHttpServer({ authType: "none" });
    const res = await request(app, "POST", table, [
      { id: 9, name: "iota" },
      { id: 9, name: "iota-again" },
    ]);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DUPLICATE_KEY");
    expect(res.body.fields).toEqual({ pk: "9" });

    const rows = await request(app, "GET", `${table}?pk=eq.9`);
    expect(rows.body).toHaveLength(0);
  });

  it("two concurrent POSTs of one key: exactly one wins, one row stored", async () => {
    const app = createHttpServer({ authType: "none" });
    const [a, b] = await Promise.all([
      request(app, "POST", table, { id: 10, name: "kappa" }),
      request(app, "POST", table, { id: 10, name: "kappa-again" }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const refused = a.status === 409 ? a : b;
    expect(refused.body.code).toBe("DUPLICATE_KEY");
    expect(refused.body.fields).toEqual({ pk: "10" });

    const rows = await request(app, "GET", `${table}?pk=eq.10`);
    expect(rows.body).toHaveLength(1);
  });
});
