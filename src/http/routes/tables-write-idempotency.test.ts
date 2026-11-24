/**
 * REST-PK-UNIQUENESS-001 AC2 — Idempotency-Key replay on table writes.
 *
 * A client that retries an insert (timeout, reconnect, at-least-once queue)
 * must not append twice. With an `Idempotency-Key` header:
 *   - an identical replay (same key + same body) returns the STORED FIRST
 *     result — no second row, no error;
 *   - the same key with a DIFFERENT body is a 409 `IDEMPOTENCY_CONFLICT`;
 *   - the key→result binding is DURABLE across a daemon restart (fsynced
 *     JSONL ledger at <namespacesRoot>/.duckbrain-table-idempotency/<ns>.jsonl,
 *     mirroring the session-activity receipt store).
 *
 * These tests drive the REAL HTTP server (POST /api/ns/:ns/tables/:table and
 * POST /api/ns/:ns/tables/_transaction) against a hermetic namespace root.
 * The restart arm drops the in-process binding cache via
 * resetTableIdempotencyStoresForTests() (the same reopen convention the
 * receipt-store tests use) and boots a fresh server instance.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { createServer, type Server } from "http";
import { createHttpServer } from "../../cli/http";
import { invalidateTableRegistry } from "../../schema/table-registry";
import { resetTableIdempotencyStoresForTests } from "../../tables/idempotency";
import { removeTempDirSafely } from "../../testing/race-safe-daemon";

const FIXTURE_NS = "idempotency";

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
  fs.writeFileSync(path.join(tablesDir, "widgets.jsonl"), "");
}

interface HttpResult {
  status: number;
  body: any;
  headers: http.IncomingHttpHeaders;
}

/** One request against a fresh app instance (no long-lived listener). */
function request(
  app: ReturnType<typeof createHttpServer>,
  method: string,
  reqPath: string,
  payload?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const body =
      payload === undefined ? "" : JSON.stringify(payload as object);
    const headers: Record<string, string | number> = { Host: "localhost" };
    if (body.length > 0) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(body);
    }
    for (const [name, value] of Object.entries(extraHeaders)) {
      headers[name] = value;
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
              headers: res.headers,
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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "table-idem-test-"));
  process.env.DUCKBRAIN_NAMESPACES_PATH = tmpRoot;
  process.env.DUCKBRAIN_CONFIG_PATH = path.join(tmpRoot, "duckbrain.config.json");
  writeFixture();
});

afterAll(async () => {
  await removeTempDirSafely(tmpRoot);
});

describe("REST-PK-UNIQUENESS-001 AC2: Idempotency-Key replay on table writes", () => {
  const table = `/api/ns/${FIXTURE_NS}/tables/widgets`;
  // The transaction envelope is mounted beside the table routes, NOT under
  // /:table (a declared table name can never be `_transaction`).
  const transaction = `/api/ns/${FIXTURE_NS}/tables/_transaction`;

  beforeEach(() => {
    invalidateTableRegistry(FIXTURE_NS);
  });

  it("an identical replay returns the STORED FIRST result and creates no second row", async () => {
    const app = createHttpServer({ authType: "none" });
    const key = { "Idempotency-Key": "idem-replay-1" };

    const first = await request(app, "POST", table, { id: 20, name: "first" }, key);
    expect(first.status).toBe(201);
    expect(first.body.inserted).toBe(1);

    const replay = await request(app, "POST", table, { id: 20, name: "first" }, key);
    expect(replay.status).toBe(201);
    // The stored first result, verbatim — not a duplicate-write response.
    expect(replay.body).toEqual(first.body);
    expect(replay.headers["idempotent-replayed"]).toBe("true");

    // Exactly one physical row was appended.
    const rows = await request(app, "GET", `${table}?pk=eq.20`);
    expect(rows.status).toBe(200);
    expect(rows.body).toHaveLength(1);
    expect(rows.body[0].name).toBe("first");
  });

  it("the same key with a DIFFERENT body is a 409 IDEMPOTENCY_CONFLICT and writes nothing", async () => {
    const app = createHttpServer({ authType: "none" });
    const key = { "Idempotency-Key": "idem-conflict-1" };

    const first = await request(app, "POST", table, { id: 21, name: "orig" }, key);
    expect(first.status).toBe(201);

    const conflict = await request(app, "POST", table, { id: 22, name: "other" }, key);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(conflict.body.error).toContain("idem-conflict-1");

    // The conflicting payload must not have been written under any key.
    const rows = await request(app, "GET", `${table}?pk=eq.22`);
    expect(rows.status).toBe(200);
    expect(rows.body).toHaveLength(0);
  });

  it("POST /_transaction honours Idempotency-Key replay (stored first result)", async () => {
    const app = createHttpServer({ authType: "none" });
    const key = { "Idempotency-Key": "idem-tx-1" };
    const envelope = {
      actions: [
        { op: "insert", table: "widgets", row: { id: 30, name: "tx-row" } },
      ],
    };

    const first = await request(app, "POST", transaction, envelope, key);
    expect(first.status).toBe(200);
    expect(first.body.applied).toBe(1);

    const replay = await request(app, "POST", transaction, envelope, key);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers["idempotent-replayed"]).toBe("true");

    // The replayed envelope must not have inserted a second row either.
    const rows = await request(app, "GET", `${table}?pk=eq.30`);
    expect(rows.body).toHaveLength(1);
  });

  it("the key→result binding is DURABLE across a daemon restart", async () => {
    const key = { "Idempotency-Key": "idem-restart-1" };
    const payload = { id: 40, name: "durable" };

    const firstApp = createHttpServer({ authType: "none" });
    const first = await request(firstApp, "POST", table, payload, key);
    expect(first.status).toBe(201);
    expect(first.body.inserted).toBe(1);

    // Simulate a daemon restart: drop the in-process binding cache and boot
    // a fresh server instance (same reopen convention as the receipt-store
    // durability tests). The fsynced ledger must carry the binding.
    resetTableIdempotencyStoresForTests();
    const restartedApp = createHttpServer({ authType: "none" });
    const replay = await request(restartedApp, "POST", table, payload, key);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers["idempotent-replayed"]).toBe("true");

    // Still exactly one row — the restart replay wrote nothing.
    const rows = await request(restartedApp, "GET", `${table}?pk=eq.40`);
    expect(rows.body).toHaveLength(1);

    // And after the restart the conflict arm still fires on a mutated body.
    const conflict = await request(restartedApp, "POST", table, { id: 41, name: "mutated" }, key);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("IDEMPOTENCY_CONFLICT");
  });
});
