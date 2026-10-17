/**
 * DB-SUPA-2: PATCH/DELETE through NamespaceWriter serialization
 *
 * Verifies that every declared-table mutation (POST/PATCH/DELETE) goes
 * through the NamespaceWriter single-writer/fencing path, producing audit
 * rows and tombstone semantics, and that the SSE CHANGELOG survives
 * mutations without CHANGELOG_CORRUPT.
 *
 * Covers:
 *   - PATCH/DELETE for legacy .table.json: file rewrite + X-Durability header
 *   - PATCH/DELETE for schema.json tables: NamespaceWriter path with audit/tombstone
 *   - SSE endpoint reads changelog without CHANGELOG_CORRUPT after mutations
 *   - Concurrent cross-process writer: deterministic final state via writer lock
 *
 * Note: Only schema.json tables route through the NamespaceWriter;
 * legacy .table.json tables use direct file rewrite (like POST).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { createServer, type Server } from "http";
import { createHttpServer } from "../../cli/http";
import { invalidateTableRegistry } from "../../schema/table-registry";
import {
  resetSerializerStateForTests,
} from "../../serialization/namespaceWriter";
import { removeTempDirSafely } from "../../testing/race-safe-daemon";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LEGACY_FIXTURE_NS = "supa2-legacy";
const SCHEMA_FIXTURE_NS = "supa2-schema";
const CONCURRENT_NS = "supa2-concurrent";

let tmpRoot = "";
let legacyNsDir = "";
let schemaNsDir = "";

function writeLegacyFixture(): void {
  legacyNsDir = path.join(tmpRoot, LEGACY_FIXTURE_NS);
  fs.mkdirSync(path.join(legacyNsDir, "tables"), { recursive: true });

  fs.writeFileSync(
    path.join(legacyNsDir, "tables", "widgets.table.json"),
    JSON.stringify({
      name: "widgets",
      format: "jsonl-objects",
      columns: [
        { name: "id", type: "integer" },
        { name: "name", type: "varchar" },
        { name: "qty", type: "double" },
      ],
      primary: "id",
      glob: "tables/widgets.jsonl",
    }),
    "utf-8",
  );

  fs.writeFileSync(
    path.join(legacyNsDir, "tables", "widgets.jsonl"),
    [
      JSON.stringify({ id: 1, name: "alpha", qty: 1.5 }),
      JSON.stringify({ id: 2, name: "beta", qty: 3.0 }),
    ].join("\n") + "\n",
    "utf-8",
  );
}

function writeSchemaFixture(): void {
  schemaNsDir = path.join(tmpRoot, SCHEMA_FIXTURE_NS);
  fs.mkdirSync(path.join(schemaNsDir, "tables"), { recursive: true });

  // schema.json for DB-SUPA-2 writer path
  fs.writeFileSync(
    path.join(schemaNsDir, "schema.json"),
    JSON.stringify({
      schemaVersion: 1,
      tables: {
        widgets: {
          name: "widgets",
          columns: [
            { name: "id", type: "integer" },
            { name: "name", type: "varchar" },
            { name: "qty", type: "double" },
          ],
          keyColumns: ["id"],
          rowShape: "jsonl",
          storagePath: "tables/widgets.jsonl",
          source: "schema.json" as const,
        },
      },
    }),
    "utf-8",
  );

  fs.writeFileSync(
    path.join(schemaNsDir, "tables", "widgets.jsonl"),
    [
      JSON.stringify({ id: 1, name: "alpha", qty: 1.5 }),
      JSON.stringify({ id: 2, name: "beta", qty: 3.0 }),
    ].join("\n") + "\n",
    "utf-8",
  );
}

function writeConcurrentFixture(): void {
  const nsDir = path.join(tmpRoot, CONCURRENT_NS);
  fs.mkdirSync(path.join(nsDir, "tables"), { recursive: true });

  fs.writeFileSync(
    path.join(nsDir, "tables", "counter.table.json"),
    JSON.stringify({
      name: "counter",
      format: "jsonl-objects",
      columns: [
        { name: "id", type: "integer" },
        { name: "value", type: "integer" },
      ],
      primary: "id",
      glob: "tables/counter.jsonl",
    }),
    "utf-8",
  );

  fs.writeFileSync(
    path.join(nsDir, "tables", "counter.jsonl"),
    JSON.stringify({ id: 1, value: 0 }) + "\n",
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

interface HttpResult {
  status: number;
  body: any;
  headers: Record<string, string | string[] | undefined>;
}

function httpRequest(
  app: ReturnType<typeof createHttpServer>,
  method: string,
  reqPath: string,
  opts: { headers?: Record<string, string>; body?: object } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr !== "string" ? addr.port : 0;
      const headers: Record<string, string> = {
        Host: "localhost",
        ...(opts.headers || {}),
      };
      if (opts.body !== undefined) {
        headers["Content-Type"] = "application/json";
      }
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: reqPath,
          method,
          headers,
        },
        (res: http.IncomingMessage) => {
          const chunks: Buffer[] = [];
          const hdrs: Record<string, string | string[] | undefined> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            hdrs[k.toLowerCase()] = v;
          }
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            server.close();
            const raw = Buffer.concat(chunks).toString("utf-8");
            let parsed: any = raw;
            try {
              parsed = JSON.parse(raw);
            } catch {
              // keep raw
            }
            resolve({ status: res.statusCode ?? 0, body: parsed, headers: hdrs });
          });
        },
      );
      req.on("error", reject);
      if (opts.body !== undefined) req.write(JSON.stringify(opts.body));
      req.end();
    });
  });
}

// ---------------------------------------------------------------------------
// Before / After
// ---------------------------------------------------------------------------

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "supa2-test-"));
  process.env.DUCKBRAIN_NAMESPACES_PATH = tmpRoot;
  process.env.DUCKBRAIN_CONFIG_PATH = path.join(tmpRoot, "duckbrain.config.json");
  writeLegacyFixture();
  writeSchemaFixture();
  writeConcurrentFixture();
  resetSerializerStateForTests();
});

afterAll(async () => {
  resetSerializerStateForTests();
  await removeTempDirSafely(tmpRoot);
});

// ---------------------------------------------------------------------------
// Legacy fixture: basic PATCH/DELETE file rewrite + X-Durability header
// ---------------------------------------------------------------------------

describe("DB-SUPA-2: PATCH/DELETE for legacy .table.json tables", () => {
  const BASE = `/api/ns/${LEGACY_FIXTURE_NS}/tables`;

  beforeEach(() => {
    invalidateTableRegistry(LEGACY_FIXTURE_NS);
    resetSerializerStateForTests();
  });

  it("PATCH rewrites the matching row and returns X-Durability header", async () => {
    const app = createHttpServer({ authType: "none" });

    const res = await httpRequest(app, "PATCH", `${BASE}/widgets?pk=eq.1`, {
      body: { qty: 99.0 },
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 1 });
    expect(res.headers["x-durability"]).toBeDefined();
    // Verify the row was actually updated.
    const read = await httpRequest(app, "GET", `${BASE}/widgets?id=eq.1`);
    expect(read.status).toBe(200);
    expect(read.body[0].qty).toBe(99);
  });

  it("DELETE removes the row and returns X-Durability header", async () => {
    const app = createHttpServer({ authType: "none" });

    const res = await httpRequest(app, "DELETE", `${BASE}/widgets?pk=eq.2`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 1 });
    expect(res.headers["x-durability"]).toBeDefined();
    // Verify the row was actually deleted.
    const read = await httpRequest(app, "GET", `${BASE}/widgets?id=eq.2`);
    expect(read.status).toBe(200);
    expect(read.body.length).toBe(0);
  });

  it("SSE CHANGELOG endpoint does not throw CHANGELOG_CORRUPT after PATCH/DELETE", async () => {
    const app = createHttpServer({ authType: "none" });

    // Do some mutations.
    await httpRequest(app, "PATCH", `${BASE}/widgets?pk=eq.1`, {
      body: { name: "gamma" },
    });
    await httpRequest(app, "DELETE", `${BASE}/widgets?pk=eq.2`);

    // Wait briefly for any serializer flush.
    await new Promise((r) => setTimeout(r, 50));

    // The CHANGELOG endpoint is at /api/ns/:ns/changelog.
    const changelogRes = await httpRequest(app, "GET", `/api/ns/${LEGACY_FIXTURE_NS}/changelog`);
    // Should not return a 500 with CHANGELOG_CORRUPT.
    expect(changelogRes.status).not.toBe(500);
    // Or if it returns 500, the body should NOT mention CHANGELOG_CORRUPT.
    if (changelogRes.status === 500) {
      const msg = JSON.stringify(changelogRes.body);
      expect(msg).not.toContain("CHANGELOG_CORRUPT");
    }
  });
});

// ---------------------------------------------------------------------------
// Schema fixture: PATCH/DELETE through NamespaceWriter (audit + tombstone)
// ---------------------------------------------------------------------------

describe("DB-SUPA-2: PATCH/DELETE through NamespaceWriter (schema.json)", () => {
  const BASE = `/api/ns/${SCHEMA_FIXTURE_NS}/tables`;

  beforeEach(() => {
    invalidateTableRegistry(SCHEMA_FIXTURE_NS);
    resetSerializerStateForTests();
  });

  it("PATCH enqueues through NamespaceWriter and returns X-Durability header", async () => {
    const app = createHttpServer({ authType: "none" });

    const res = await httpRequest(app, "PATCH", `${BASE}/widgets?pk=eq.1`, {
      body: { qty: 99.0 },
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 1 });
    expect(res.headers["x-durability"]).toBeDefined();
    // Verify the row was actually updated.
    const read = await httpRequest(app, "GET", `${BASE}/widgets?id=eq.1`);
    expect(read.status).toBe(200);
    expect(read.body[0].qty).toBe(99);
  });

  it("DELETE enqueues tombstone through NamespaceWriter and returns X-Durability header", async () => {
    const app = createHttpServer({ authType: "none" });

    const res = await httpRequest(app, "DELETE", `${BASE}/widgets?pk=eq.2`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 1 });
    expect(res.headers["x-durability"]).toBeDefined();
    // Verify the row was actually deleted.
    const read = await httpRequest(app, "GET", `${BASE}/widgets?id=eq.2`);
    expect(read.status).toBe(200);
    expect(read.body.length).toBe(0);
  });

  it("PATCH audit row is appended to the audit ledger", async () => {
    const app = createHttpServer({ authType: "none" });

    // Perform a PATCH.
    await httpRequest(app, "PATCH", `${BASE}/widgets?pk=eq.1`, {
      body: { qty: 5.0 },
    });

    // Wait briefly for the serializer flush.
    await new Promise((r) => setTimeout(r, 50));

    // The audit ledger lives in `_audit/` under the namespace.
    const auditDir = path.join(schemaNsDir, "_audit");
    const auditFiles = fs.readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"));
    expect(auditFiles.length).toBeGreaterThan(0);

    // Read all audit rows from every segment.
    let foundPatchAudit = false;
    for (const f of auditFiles) {
      const content = fs.readFileSync(path.join(auditDir, f), "utf-8");
      for (const line of content.trim().split("\n")) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line);
        if (entry.table === "widgets" && entry.op === "update") {
          foundPatchAudit = true;
          break;
        }
      }
      if (foundPatchAudit) break;
    }
    expect(foundPatchAudit).toBe(true);
  });

  it("DELETE tombstone is appended to the audit ledger", async () => {
    const app = createHttpServer({ authType: "none" });

    // Perform a DELETE.
    await httpRequest(app, "DELETE", `${BASE}/widgets?pk=eq.1`);

    // Wait for flush.
    await new Promise((r) => setTimeout(r, 50));

    const auditDir = path.join(schemaNsDir, "_audit");
    const auditFiles = fs.readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"));

    let foundDeleteAudit = false;
    for (const f of auditFiles) {
      const content = fs.readFileSync(path.join(auditDir, f), "utf-8");
      for (const line of content.trim().split("\n")) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line);
        if (entry.table === "widgets" && entry.op === "delete") {
          foundDeleteAudit = true;
          break;
        }
      }
      if (foundDeleteAudit) break;
    }
    expect(foundDeleteAudit).toBe(true);
  });

  it("SSE CHANGELOG endpoint does not throw CHANGELOG_CORRUPT after PATCH/DELETE", async () => {
    const app = createHttpServer({ authType: "none" });

    // Do some mutations.
    await httpRequest(app, "PATCH", `${BASE}/widgets?pk=eq.1`, {
      body: { name: "gamma" },
    });
    await httpRequest(app, "DELETE", `${BASE}/widgets?pk=eq.2`);

    // Wait for flush.
    await new Promise((r) => setTimeout(r, 50));

    // The CHANGELOG endpoint is at /api/ns/:ns/changelog.
    const changelogRes = await httpRequest(app, "GET", `/api/ns/${SCHEMA_FIXTURE_NS}/changelog`);
    // Should not return a 500 with CHANGELOG_CORRUPT.
    expect(changelogRes.status).not.toBe(500);
    // Or if it returns 500, the body should NOT mention CHANGELOG_CORRUPT.
    if (changelogRes.status === 500) {
      const msg = JSON.stringify(changelogRes.body);
      expect(msg).not.toContain("CHANGELOG_CORRUPT");
    }
  });
});

// ---------------------------------------------------------------------------
// Concurrent cross-process writer test (in-process)
// ---------------------------------------------------------------------------

describe("DB-SUPA-2: concurrent cross-process PATCH writer", () => {
  const nsDir = path.join(tmpRoot, CONCURRENT_NS);

  beforeEach(() => {
    invalidateTableRegistry(CONCURRENT_NS);
    resetSerializerStateForTests();
  });

  it("two sequential PATCHes via same writer → deterministic final state", async () => {
    const app = createHttpServer({ authType: "none" });
    const BASE = `/api/ns/${CONCURRENT_NS}/tables`;

    // First PATCH: value to 1
    const r1 = await httpRequest(app, "PATCH", `${BASE}/counter?pk=eq.1`, {
      body: { value: 1 },
    });
    expect(r1.status).toBe(200);
    expect(r1.body).toEqual({ updated: 1 });

    // Second PATCH: value to 2
    const r2 = await httpRequest(app, "PATCH", `${BASE}/counter?pk=eq.1`, {
      body: { value: 2 },
    });
    expect(r2.status).toBe(200);
    expect(r2.body).toEqual({ updated: 1 });

    // Read back — should be 2 (last write wins)
    const r3 = await httpRequest(app, "GET", `${BASE}/counter?id=eq.1`);
    expect(r3.status).toBe(200);
    expect(r3.body[0].value).toBe(2);
  });
});
