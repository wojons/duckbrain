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
 *   - Concurrent writer: two real child processes PATCH one row at once; the
 *     namespace write lock (cross-process file lock) loses no update
 *
 * Note (DB-SUPA-2 AC-1 residual): both table kinds RECORD their accepted
 * mutations through the NamespaceWriter, but their rows are still written by an
 * in-place JSONL rewrite; routing the row write through the append-only
 * serializer needs read-side version folding. See the module header of
 * src/http/routes/tables.ts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn } from "child_process";
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
  // DUCKBRAIN_NAMESPACES_PATH env override makes namespaces resolve to tmpRoot
  // itself (not tmpRoot/namespaces). See applyEnvOverrides() in config/index.ts.
  schemaNsDir = path.join(tmpRoot, SCHEMA_FIXTURE_NS);
  fs.mkdirSync(path.join(schemaNsDir, "tables"), { recursive: true });

  // schema.json for DB-SUPA-2 writer path.
  // CLOSED-WORLD schema contract: strict zod schema rejects unknown keys.
  // See schemaJson.ts TableSchema definition.
  // DECLARED_TYPES: string, int64, float64, boolean, timestamp, json, bytes
  // ROW_SHAPES: object, positional
  fs.writeFileSync(
    path.join(schemaNsDir, "schema.json"),
    JSON.stringify({
      schemaVersion: 1,
      tables: {
        widgets: {
          schemaVersion: 1,
          storage: { path: "tables/widgets.jsonl" },
          rowShape: "object",
          keyColumns: ["id"],
          columns: [
            { name: "id", type: "int64", nullable: false },
            { name: "name", type: "string", nullable: true },
            { name: "qty", type: "float64", nullable: true },
          ],
        },
      },
      views: {},
    }),
    "utf-8",
  );

  fs.writeFileSync(
    path.join(schemaNsDir, "tables", "widgets.jsonl"),
    [
      // rowShape=object: each line is a JSON object matching column names
      JSON.stringify({ id: "1", name: "alpha", qty: 1.5 }),
      JSON.stringify({ id: "2", name: "beta", qty: 3.0 }),
    ].join("\n") + "\n",
    "utf-8",
  );
}

function writeConcurrentFixture(): void {
  const nsDir = path.join(tmpRoot, CONCURRENT_NS);
  fs.mkdirSync(path.join(nsDir, "tables"), { recursive: true });

  // Two INDEPENDENT columns on one row: the concurrency claim under test is
  // "no lost update", and independent columns make a lost update visible — a
  // single overwritten column would look identical to last-write-wins.
  fs.writeFileSync(
    path.join(nsDir, "tables", "counter.table.json"),
    JSON.stringify({
      name: "counter",
      format: "jsonl-objects",
      columns: [
        { name: "id", type: "integer" },
        { name: "alice", type: "integer" },
        { name: "bob", type: "integer" },
      ],
      primary: "id",
      glob: "tables/counter.jsonl",
    }),
    "utf-8",
  );

  fs.writeFileSync(
    path.join(nsDir, "tables", "counter.jsonl"),
    JSON.stringify({ id: 1, alice: 0, bob: 0 }) + "\n",
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
// Concurrent cross-process writer test (two real OS processes)
// ---------------------------------------------------------------------------

/**
 * DB-SUPA-2 AC-3: the PATCH/DELETE serialization claim is a CROSS-PROCESS one,
 * so it has to be tested with more than one process. The previous version of
 * this test issued two PATCHes sequentially from the test process and called
 * that "concurrent"; it could never fail, because a single process cannot race
 * itself through an in-process mutex.
 *
 * Here two child Node processes each boot a real HTTP server, both wait on a
 * gate file so their PATCHes fire at the same instant, and both mutate the
 * SAME row through the real route. Each patches a DIFFERENT column, so a lost
 * update is directly observable: if the read-merge-rewrite were not serialized
 * by the namespace write lock (a file lock shared across processes), one
 * process would rewrite the file from a pre-image that predates the other's
 * write and drop that column's update.
 */
describe("DB-SUPA-2: concurrent cross-process PATCH writer", () => {
  const CHILD_SCRIPT = path.resolve(
    process.cwd(),
    "src",
    "http",
    "routes",
    "fixtures",
    "supa2-patch-child.ts",
  );

  interface ChildOutcome {
    code: number | null;
    signal: NodeJS.Signals | null;
    out: string;
    result: { pid: number; column: string; value: number; status: number; body: string } | null;
  }

  function spawnPatchChild(
    column: string,
    value: number,
    gateFile: string,
    readyFile: string,
  ): { child: ReturnType<typeof spawn>; done: Promise<ChildOutcome> } {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        CHILD_SCRIPT,
        tmpRoot,
        CONCURRENT_NS,
        "counter",
        column,
        String(value),
        gateFile,
        readyFile,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DUCKBRAIN_NAMESPACES_PATH: tmpRoot,
          DUCKBRAIN_CONFIG_PATH: path.join(tmpRoot, "duckbrain.config.json"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const done = new Promise<ChildOutcome>((resolve) => {
      let out = "";
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 90_000);
      child.stdout!.on("data", (chunk: Buffer) => {
        out += chunk.toString();
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        out += chunk.toString();
      });
      child.on("exit", (code, signal) => {
        clearTimeout(killTimer);
        const line = out
          .split("\n")
          .find((candidate) => candidate.startsWith("RESULT "));
        let result: ChildOutcome["result"] = null;
        if (line) {
          try {
            result = JSON.parse(line.slice("RESULT ".length));
          } catch {
            result = null;
          }
        }
        resolve({ code, signal, out, result });
      });
    });
    return { child, done };
  }

  beforeEach(() => {
    invalidateTableRegistry(CONCURRENT_NS);
    resetSerializerStateForTests();
  });

  it("two node processes PATCH the same row at once and lose no update", async () => {
    const gateFile = path.join(tmpRoot, "concurrent-gate");
    const readyAlice = path.join(tmpRoot, "concurrent-ready-alice");
    const readyBob = path.join(tmpRoot, "concurrent-ready-bob");
    for (const file of [gateFile, readyAlice, readyBob]) {
      fs.rmSync(file, { force: true });
    }

    const alice = spawnPatchChild("alice", 1, gateFile, readyAlice);
    const bob = spawnPatchChild("bob", 2, gateFile, readyBob);

    // Barrier: both servers must be listening before either PATCH fires, so
    // the two mutations genuinely overlap instead of one finishing first.
    const start = Date.now();
    while (
      (!fs.existsSync(readyAlice) || !fs.existsSync(readyBob)) &&
      Date.now() - start < 60_000
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(fs.existsSync(readyAlice) && fs.existsSync(readyBob)).toBe(true);
    fs.writeFileSync(gateFile, "go", "utf-8");

    const [aliceOutcome, bobOutcome] = await Promise.all([
      alice.done,
      bob.done,
    ]);

    // Both processes really ran their own server and really got a 2xx from the
    // real route — not a skip, not a lock rejection.
    for (const [outcome, column] of [
      [aliceOutcome, "alice"],
      [bobOutcome, "bob"],
    ] as const) {
      expect({ code: outcome.code, signal: outcome.signal }).toEqual({
        code: 0,
        signal: null,
      });
      expect(outcome.result).not.toBeNull();
      expect(outcome.result!.column).toBe(column);
      expect(outcome.result!.status, outcome.out).toBe(200);
      expect(JSON.parse(outcome.result!.body)).toEqual({ updated: 1 });
      // Two distinct OS processes, not two calls in this one.
      expect(outcome.result!.pid).toBeGreaterThan(0);
    }
    expect(aliceOutcome.result!.pid).not.toBe(bobOutcome.result!.pid);

    // The row exists exactly once (no duplicated/torn row from two rewrites)
    // and carries BOTH updates — neither write was lost.
    const dataFile = path.join(tmpRoot, CONCURRENT_NS, "tables", "counter.jsonl");
    const lines = fs
      .readFileSync(dataFile, "utf-8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(row).toEqual({ id: 1, alice: 1, bob: 2 });
  }, 120_000);
});
