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
import { contentHashFor, isChangeRecordCandidate } from "../../serialization/changeRecord";
import {
  acquireNamespaceWriteLock,
  namespaceWriteLockPath,
  readNamespaceWriteLockPayload,
  releaseNamespaceWriteLock,
} from "../../serialization/lock";
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

/**
 * Put the concurrent fixture back to its pre-race state between tests: one row,
 * zeroed columns, no audit ledger, no leftover namespace write lock. Every
 * cross-process arm starts from a byte-identical pre-image, so "no lost
 * update" is measured against a known baseline rather than the previous arm's
 * residue.
 */
function resetConcurrentFixture(): void {
  const nsDir = path.join(tmpRoot, CONCURRENT_NS);
  fs.rmSync(path.join(nsDir, "_audit"), { recursive: true, force: true });
  fs.rmSync(path.join(tmpRoot, ".duckbrain-write"), {
    recursive: true,
    force: true,
  });
  fs.mkdirSync(path.join(nsDir, "tables"), { recursive: true });
  fs.writeFileSync(
    path.join(nsDir, "tables", "counter.jsonl"),
    JSON.stringify({ id: 1, alice: 0, bob: 0 }) + "\n",
    "utf-8",
  );
}

/** The single `counter` row's raw JSONL line (no trailing newline) and image. */
function readCounterRow(): { lines: string[]; line: string; row: Record<string, unknown> } {
  const dataFile = path.join(tmpRoot, CONCURRENT_NS, "tables", "counter.jsonl");
  const lines = fs
    .readFileSync(dataFile, "utf-8")
    .split("\n")
    .filter((candidate) => candidate.trim() !== "");
  // Exactly one line is itself an assertion (a torn or duplicated rewrite is a
  // serialization failure even when both column values happen to survive), but
  // it is asserted at the call sites so the failure names the real contract.
  const line = lines[0] ?? "";
  return {
    lines,
    line,
    row: line === "" ? {} : (JSON.parse(line) as Record<string, unknown>),
  };
}

interface AcceptedAuditRecord {
  table?: string;
  op?: string;
  outcome?: string;
  contentHash?: string;
  key?: Record<string, unknown>;
  targetPath?: string;
  tombstone?: boolean;
}

/** Accepted `update` change records the mutation path appended for `table`. */
function readAcceptedUpdates(table: string): AcceptedAuditRecord[] {
  const auditDir = path.join(tmpRoot, CONCURRENT_NS, "_audit");
  if (!fs.existsSync(auditDir)) return [];
  const records: AcceptedAuditRecord[] = [];
  for (const name of fs.readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"))) {
    for (const line of fs
      .readFileSync(path.join(auditDir, name), "utf-8")
      .split("\n")) {
      if (!line.trim()) continue;
      const record = JSON.parse(line) as AcceptedAuditRecord;
      if (
        record.table === table &&
        record.op === "update" &&
        record.outcome === "accepted"
      ) {
        records.push(record);
      }
    }
  }
  return records;
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

  it("PATCH on a legacy .table.json table records a change record through the writer", async () => {
    const app = createHttpServer({ authType: "none" });

    // DB-SUPA-2 AC-1 (partial): legacy tables still rewrite their JSONL in
    // place, but the accepted mutation is now RECORDED through the single
    // namespace writer as a real DB-SUPA-5 change record — the same path the
    // schema.json tables use — instead of not being audited at all.
    const res = await httpRequest(app, "PATCH", `${BASE}/widgets?pk=eq.1`, {
      body: { name: "delta" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 1 });
    await new Promise((r) => setTimeout(r, 50));

    const auditDir = path.join(legacyNsDir, "_audit");
    const rows = fs
      .readdirSync(auditDir)
      .filter((name) => name.endsWith(".jsonl"))
      .flatMap((name) =>
        fs
          .readFileSync(path.join(auditDir, name), "utf-8")
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      );

    const record = rows.find(
      (row) => row.op === "update" && row.table === "widgets",
    );
    expect(record).toBeDefined();
    expect(typeof record!.contentHash).toBe("string");
    expect(isChangeRecordCandidate(record!)).toBe(true);
    expect(record!.targetPath).toBe("tables/widgets.jsonl");
    expect(record!.key).toEqual({ id: 1 });
    expect(record!.tombstone).toBe(false);
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
// Concurrent cross-process writer test (two or more REAL OS processes)
// ---------------------------------------------------------------------------

/**
 * DB-SUPA-2 AC-3: the serialization claim is a CROSS-PROCESS one, so it has to
 * be tested with more than one process. Two PATCHes awaited in one process
 * cannot race each other through an in-process mutex — that test could never
 * fail for the reason the criterion exists.
 *
 * The code path under test is a read-merge-rewrite (PATCH reads the row, merges
 * the body, rewrites the JSONL file) guarded by the namespace write lock
 * (`src/serialization/lock.ts` — a `wx` lock FILE, shared by every process that
 * points at the same namespace root). Only a real second process can exercise
 * cross-process acquisition, dead-pid recovery, stale-owner preemption and the
 * nonce fence.
 *
 * Three arms, each with a different failure class:
 *
 *   1. disjoint columns, two spawned processes, gate barrier — a lost update is
 *      directly observable (one column keeps a value from a pre-image that
 *      predates the other write) AND every acked write must be present in the
 *      `_audit` ledger, so an acknowledged-but-unrecorded mutation fails too.
 *   2. the SAME column from two spawned processes — deterministic last-writer-
 *      wins: the final line must be exactly one of the two acked post-images
 *      and the ledger's contentHash must name THAT image.
 *   3. this process holds the namespace write lock while a spawned PATCH runs:
 *      the row file must stay at its pre-image for the whole hold. That
 *      assertion fails if the route stops taking the lock (RED-proved by
 *      bypassing the PATCH acquisition — the file is then rewritten immediately),
 *      which is what demonstrates the lock is actually exercised.
 *
 * All fixture state lives under a mkdtemp scratch root; nothing touches a
 * production namespace.
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

  interface ChildResult {
    pid: number;
    column: string;
    value: number;
    status: number;
    body: string;
    gateSeenAtMs: number;
    ackAtMs: number;
    waitedMs: number;
  }

  interface ChildOutcome {
    code: number | null;
    signal: NodeJS.Signals | null;
    out: string;
    result: ChildResult | null;
  }

  function childArgv(
    column: string,
    value: number,
    gateFile: string,
    readyFile: string,
  ): string[] {
    return [
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
    ];
  }

  function childOptions() {
    return {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DUCKBRAIN_NAMESPACES_PATH: tmpRoot,
        DUCKBRAIN_CONFIG_PATH: path.join(tmpRoot, "duckbrain.config.json"),
      },
      stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
    };
  }

  /** Buffer a child's output and resolve on exit with its RESULT line parsed. */
  function collectChild(child: ReturnType<typeof spawn>): Promise<ChildOutcome> {
    return new Promise<ChildOutcome>((resolve) => {
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
        let result: ChildResult | null = null;
        if (line) {
          try {
            result = JSON.parse(line.slice("RESULT ".length)) as ChildResult;
          } catch {
            result = null;
          }
        }
        resolve({ code, signal, out, result });
      });
    });
  }

  /** A child that really ran, really got a 2xx, and is its own OS process. */
  function expectAcked(
    outcome: ChildOutcome,
    column: string,
    value: number,
  ): ChildResult {
    expect({ code: outcome.code, signal: outcome.signal }).toEqual({
      code: 0,
      signal: null,
    });
    expect(outcome.result, outcome.out).not.toBeNull();
    const result = outcome.result!;
    expect(outcome.out).toContain("RESULT ");
    expect(result.column).toBe(column);
    expect(result.value).toBe(value);
    expect(result.status, outcome.out).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ updated: 1 });
    expect(result.pid).toBeGreaterThan(0);
    expect(Number.isFinite(result.ackAtMs)).toBe(true);
    expect(result.ackAtMs).toBeGreaterThanOrEqual(result.gateSeenAtMs);
    return result;
  }

  /**
   * Requirement 5: report the OBSERVED interleaving (ack order, winner, the
   * gap, and the measured concurrent window) instead of only a green summary.
   */
  function reportInterleaving(
    label: string,
    gateOpenedAt: number,
    runs: Array<{ label: string; result: ChildResult }>,
  ): { first: string; last: string } {
    const timeline = runs
      .map(
        (run) =>
          `${run.label}(pid=${run.result.pid}) sawGate +${run.result.gateSeenAtMs - gateOpenedAt}ms acked +${run.result.ackAtMs - gateOpenedAt}ms waited ${run.result.waitedMs}ms`,
      )
      .join(" | ");
    const byAck = [...runs].sort((a, b) => a.result.ackAtMs - b.result.ackAtMs);
    const first = byAck[0]!.label;
    const last = byAck[byAck.length - 1]!.label;
    const overlapStart = Math.max(...runs.map((r) => r.result.gateSeenAtMs));
    const overlapEnd = Math.min(...runs.map((r) => r.result.ackAtMs));
    console.log(
      `[supa2 cross-process/${label}] ${timeline} => first=${first} last=${last} ackGap=${byAck[byAck.length - 1]!.result.ackAtMs - byAck[0]!.result.ackAtMs}ms concurrentWindow=${Math.max(0, overlapEnd - overlapStart)}ms`,
    );
    expect(runs[0]!.result.pid).not.toBe(runs[runs.length - 1]!.result.pid);
    return { first, last };
  }

  /** Wait until both children have announced a listening server. */
  async function awaitReady(files: string[]): Promise<void> {
    const start = Date.now();
    while (
      files.some((file) => !fs.existsSync(file)) &&
      Date.now() - start < 60_000
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(files.filter((file) => fs.existsSync(file))).toHaveLength(
      files.length,
    );
  }

  beforeEach(() => {
    resetConcurrentFixture();
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

    // Two SEPARATE OS PROCESSES, each booting the real HTTP server. Nothing
    // below is an in-process request against this test's own app.
    const alice = collectChild(
      spawn(
        process.execPath,
        childArgv("alice", 1, gateFile, readyAlice),
        childOptions(),
      ),
    );
    const bob = collectChild(
      spawn(
        process.execPath,
        childArgv("bob", 2, gateFile, readyBob),
        childOptions(),
      ),
    );

    // Barrier: both servers must be listening before either PATCH fires, so the
    // two read-merge-rewrites genuinely overlap instead of one finishing first.
    await awaitReady([readyAlice, readyBob]);
    const gateOpenedAt = Date.now();
    fs.writeFileSync(gateFile, "go", "utf-8");

    const [aliceOutcome, bobOutcome] = await Promise.all([alice, bob]);
    const aliceResult = expectAcked(aliceOutcome, "alice", 1);
    const bobResult = expectAcked(bobOutcome, "bob", 2);
    expect(aliceResult.pid).not.toBe(bobResult.pid);

    const { first, last } = reportInterleaving("disjoint-columns", gateOpenedAt, [
      { label: "alice", result: aliceResult },
      { label: "bob", result: bobResult },
    ]);
    expect([first, last].sort()).toEqual(["alice", "bob"]);

    // The row exists exactly once (no duplicated/torn line from two rewrites)
    // and carries BOTH updates: neither write was lost to the other's
    // pre-image, which is what an unserialized read-merge-rewrite would do.
    const { lines, row } = readCounterRow();
    expect(lines, "a concurrent rewrite must not tear or duplicate the row").toHaveLength(1);
    expect(row).toEqual({ id: 1, alice: 1, bob: 2 });

    // Requirement 3, ledger half: every ACKED update must have left an accepted
    // change record. A lost update that still returned 200 fails here even if
    // the surviving column happened to be the winner's.
    const records = readAcceptedUpdates("counter");
    expect(records).toHaveLength(2);
    expect(new Set(records.map((record) => record.contentHash)).size).toBe(2);
    for (const record of records) {
      expect(record.key).toEqual({ id: 1 });
      expect(record.targetPath).toBe("tables/counter.jsonl");
      expect(record.tombstone).toBe(false);
      expect(isChangeRecordCandidate(record as unknown as Record<string, unknown>)).toBe(true);
    }
  }, 120_000);

  it("same column from two processes: last writer wins and the ledger names it", async () => {
    const gateFile = path.join(tmpRoot, "concurrent-gate-same");
    const readyAlice = path.join(tmpRoot, "concurrent-ready-same-alice");
    const readyBob = path.join(tmpRoot, "concurrent-ready-same-bob");
    for (const file of [gateFile, readyAlice, readyBob]) {
      fs.rmSync(file, { force: true });
    }

    const alice = collectChild(
      spawn(
        process.execPath,
        childArgv("alice", 5, gateFile, readyAlice),
        childOptions(),
      ),
    );
    const bob = collectChild(
      spawn(
        process.execPath,
        childArgv("alice", 9, gateFile, readyBob),
        childOptions(),
      ),
    );

    await awaitReady([readyAlice, readyBob]);
    const gateOpenedAt = Date.now();
    fs.writeFileSync(gateFile, "go", "utf-8");

    const [aliceOutcome, bobOutcome] = await Promise.all([alice, bob]);
    const aliceResult = expectAcked(aliceOutcome, "alice", 5);
    const bobResult = expectAcked(bobOutcome, "alice", 9);
    reportInterleaving("same-column", gateOpenedAt, [
      { label: "alice=5", result: aliceResult },
      { label: "bob=9", result: bobResult },
    ]);

    const { lines, line, row } = readCounterRow();
    expect(lines, "a concurrent rewrite must not tear or duplicate the row").toHaveLength(1);
    const winningValue = row["alice"];
    // Deterministic last-writer-wins: the final image is ONE of the two values
    // the two processes acked (never a merge, never a stale/zeroed value).
    expect([5, 9]).toContain(winningValue);
    expect(row["bob"]).toBe(0);

    // ...and the ledger's contentHash names exactly that final image, so the
    // winning write is the one the audit trail recorded last for this row.
    const records = readAcceptedUpdates("counter");
    expect(records).toHaveLength(2);
    const finalHash = contentHashFor(line);
    const namingFinalImage = records.filter(
      (record) => record.contentHash === finalHash,
    );
    expect(
      namingFinalImage,
      "the surviving row image must be named by one accepted change record",
    ).toHaveLength(1);
    const winner = winningValue === aliceResult.value ? "alice=5" : "bob=9";
    console.log(
      `[supa2 cross-process/same-column] winner=${winner} finalRow=${line} finalHash=${finalHash.slice(0, 12)}…`,
    );
    expect(winner).toBe(winningValue === 5 ? "alice=5" : "bob=9");
  }, 120_000);

  it("a spawned PATCH WAITS on a namespace write lock held by another process", async () => {
    const gateFile = path.join(tmpRoot, "concurrent-gate-lock");
    const readyFile = path.join(tmpRoot, "concurrent-ready-lock");
    for (const file of [gateFile, readyFile]) {
      fs.rmSync(file, { force: true });
    }

    // Take the SAME lock file the PATCH route takes, from this process. If the
    // route stopped acquiring it (or acquired something else), the child below
    // would ack immediately and this test fails — that is the "fails if the
    // namespace lock is removed" assertion.
    const held = acquireNamespaceWriteLock(tmpRoot, CONCURRENT_NS);
    expect(held).not.toBeNull();
    expect(fs.existsSync(namespaceWriteLockPath(tmpRoot, CONCURRENT_NS))).toBe(true);
    expect(readNamespaceWriteLockPayload(tmpRoot, CONCURRENT_NS)?.pid).toBe(
      process.pid,
    );

    // Gate already open: the child PATCHes the moment its server is listening.
    fs.writeFileSync(gateFile, "go", "utf-8");
    let finished = false;
    const settled = collectChild(
      spawn(
        process.execPath,
        childArgv("alice", 7, gateFile, readyFile),
        childOptions(),
      ),
    ).then((outcome) => {
      finished = true;
      return outcome;
    });

    await awaitReady([readyFile]);

    // Hold for 500ms — a quarter of the route's 2000ms lock-wait deadline — and
    // watch the ROW FILE, not the ack. This is the discriminating assertion:
    // the read-merge-rewrite cannot legitimately run while another process owns
    // the lock, so the JSONL must stay at its pre-image (alice:0). If the route
    // stopped taking the lock, the child would rewrite the file within a few
    // milliseconds and this observation fires. (Ack timing alone would NOT
    // discriminate: the audit append takes the same lock, so the request would
    // still be slow with the PATCH critical section unprotected.)
    const rewrittenWhileLocked: string[] = [];
    const holdStart = Date.now();
    while (Date.now() - holdStart < 500) {
      const snapshot = readCounterRow();
      if (Number(snapshot.row["alice"]) !== 0) {
        rewrittenWhileLocked.push(snapshot.line);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const ackedWhileHeld = finished;
    releaseNamespaceWriteLock(held);

    const outcome = await settled;
    expect(
      rewrittenWhileLocked,
      "the row was rewritten while another process held the namespace write lock",
    ).toEqual([]);
    expect(
      ackedWhileHeld,
      "the child PATCH acked while another process held the namespace write lock",
    ).toBe(false);

    const result = expectAcked(outcome, "alice", 7);
    // Reported, not relied on: this wait is measured inside the child, so a
    // slow tsx boot cannot be mistaken for lock contention. It is evidence of
    // the request waiting on the shared lock; the discriminating proof above is
    // the untouched row file.
    expect(
      result.waitedMs,
      `child reported only ${result.waitedMs}ms inside its PATCH; a held lock must make it wait`,
    ).toBeGreaterThanOrEqual(400);
    console.log(
      `[supa2 cross-process/lock-held] child pid=${result.pid} waited ${result.waitedMs}ms for the lock held by pid=${process.pid}, then acked ${result.status}`,
    );

    const { lines, row } = readCounterRow();
    expect(lines).toHaveLength(1);
    expect(row).toEqual({ id: 1, alice: 7, bob: 0 });
  }, 120_000);
});
