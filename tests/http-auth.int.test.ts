import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ChildProcess } from "child_process";
import {
  getRandomPort,
  startDuckbrainHttp,
  stopProcess,
  waitForUrl,
  curl,
  DAEMON_READY_TIMEOUT_MS,
} from "./helpers";
import fs from "fs";
import path from "path";
import os from "os";
import bcrypt from "bcryptjs";
import { removeTempDirSafely } from "../src/testing/race-safe-daemon";

const port = getRandomPort();
let server: ChildProcess;
let scratchDir: string;
let authFile: string;

describe("HTTP Auth Integration", () => {
  beforeAll(async () => {
    scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-http-auth-int-"),
    );
    const authDir = path.join(scratchDir, "home", ".duckbrain");
    const namespacesPath = path.join(scratchDir, "namespaces");
    authFile = path.join(authDir, "auth.json");
    fs.mkdirSync(authDir, { recursive: true });
    fs.mkdirSync(path.join(namespacesPath, "default"), { recursive: true });
    const hash = await bcrypt.hash("testpass123", 4);
    fs.writeFileSync(
      authFile,
      JSON.stringify({
        users: [{ username: "admin", passwordHash: hash, roles: ["admin"] }],
        apiKeys: [],
      }),
    );

    server = await startDuckbrainHttp({
      port,
      authType: "basic",
      authFile,
      env: {
        HOME: path.join(scratchDir, "home"),
        DUCKBRAIN_DATA_DIR: scratchDir,
        DUCKBRAIN_NAMESPACES_PATH: namespacesPath,
      },
    });
    // INT-CI-002: 15s was occasionally insufficient for tsx compile +
    // node-duckdb native load under CI Node-22 parallel load. 30s + the
    // child's stderr tail (surfaced by waitForUrl on timeout) turns the
    // flake into a real diagnostic. INT-CI-003: 60s (shared constant) +
    // globalSetup pre-warm — the 3rd flake landed the daemon's "started"
    // line AT the 30s instant on a loaded runner.
    await waitForUrl(
      `http://127.0.0.1:${port}/health`,
      DAEMON_READY_TIMEOUT_MS,
      server,
    );
    // INT-CI-003: hook timeout must exceed the 60s daemon wait or vitest
    // fails the hook BEFORE waitForUrl's cap (masking the stderr tail).
  }, 120000);

  afterAll(async () => {
    // Teardown must JOIN the daemon: a fire-and-forget SIGTERM leaves git
    // (namespace commits) and DuckDB writers (extension files) racing the
    // recursive rm below — the ENOTEMPTY CI flake (runs 39584807338,
    // 39590592568). stopProcess awaits the child's exit; removeTempDirSafely
    // then retries the bounded ENOTEMPTY/EBUSY window (same proven shape as
    // fe0dcf57 in memories-dogfood010.test.ts).
    await stopProcess(server);
    await removeTempDirSafely(scratchDir);
  });

  it("should allow /health without auth", async () => {
    const res = await curl(`http://127.0.0.1:${port}/health`);
    // GAP-030: /health answers 503 when degraded — the scratch daemon may be
    // degraded on this host, so accept both codes (body carries the signal).
    expect([200, 503]).toContain(res.status);
    const body = JSON.parse(res.body);
    // DOGFOOD-020: status may be "degraded" (embedding providers broken) —
    // the scratch daemon probes the host's real providers.
    expect(["healthy", "degraded"]).toContain(body.status);
    expect(body.embedding).toBeDefined();
  });

  it("should reject /namespaces without auth", async () => {
    const res = await curl(`http://127.0.0.1:${port}/namespaces`);
    expect(res.status).toBe(401);
  });

  it("should reject /stats with wrong credentials", async () => {
    const res = await curl(`-u wrong:creds http://127.0.0.1:${port}/stats`);
    expect(res.status).toBe(401);
  });

  it("should reject /namespaces with wrong auth header format", async () => {
    const res = await curl(
      `-H "Authorization: Bearer sometoken" http://127.0.0.1:${port}/namespaces`,
    );
    expect(res.status).toBe(401);
  });

  it("should allow /namespaces with correct basic auth", async () => {
    const res = await curl(
      `-u admin:testpass123 http://127.0.0.1:${port}/namespaces`,
    );
    expect(res.status).toBe(200);
  });

  it("should allow /stats with correct basic auth", async () => {
    const res = await curl(
      `-u admin:testpass123 http://127.0.0.1:${port}/stats`,
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// DB-SUPA-4-R2: per-table grants on the generic-table surface
// ---------------------------------------------------------------------------
//
// The generic-table surface is mounted at /api/ns/:ns/tables (src/cli/http.ts)
// and every table-DATA verb now runs requireNamespaceGrant (outer scope) and
// then requireTableGrant (resource grant). These arms drive a REAL daemon with
// an apikey auth.json, so the whole chain is exercised end to end — auth.json
// parse → principal (roles/namespaces/tableGrants) → grant middleware → route —
// rather than an in-process mount that could agree with a broken resolver.
//
// Pinned here: the two review-proven gaps (a write-only grant still answered
// GET; a read-only grant could PATCH and DELETE) AND the deliberately minimal
// list design. GET /api/ns/:ns/tables returns registry metadata, not rows, and
// stays namespace-scoped, because `tableGrants` keys are constrained to
// /^[a-z0-9_./-]+$/ (src/auth/storeSchema.ts) — no "*" wildcard can even be
// stored, so a wildcard-guarded list would 403 every grant-bearing token with
// no way to grant list access back. The per-table READ grant is enforced on
// GET /:table. See the module header of src/http/routes/tables.ts.
const tableNs = "grantsr2";
const tablesBase = `/api/ns/${tableNs}/tables`;
const keyAnalystWrite = "r2-analyst-write-only";
const keyUploaderRead = "r2-uploader-read-only";
const keyWriterWrite = "r2-writer-write-only";
const keyWriterRw = "r2-writer-rw";
const keyLegacyAnalyst = "r2-legacy-analyst";
/** Exactly 2 pinning rows; every arm starts from these bytes. */
const WIDGETS_ROWS =
  [
    JSON.stringify({ id: 1, name: "alpha", qty: 1.5 }),
    JSON.stringify({ id: 2, name: "beta", qty: 3.0 }),
  ].join("\n") + "\n";

const apiKeyHeader = (key: string): string => `-H "x-api-key: ${key}"`;
const jsonBody = (body: Record<string, unknown>): string =>
  `-H "Content-Type: application/json" -d '${JSON.stringify(body)}'`;

describe("HTTP Auth Integration: DB-SUPA-4-R2 per-table grants", () => {
  const grantsPort = getRandomPort();
  let grantsServer: ChildProcess;
  let grantsScratch: string;
  let grantsNsDir: string;

  const widgetsPath = (): string =>
    path.join(grantsNsDir, "tables", "widgets.jsonl");

  /** Rewrite the fixture bytes so no arm inherits another arm's mutation. */
  const resetWidgetsFixture = (): void => {
    fs.mkdirSync(path.join(grantsNsDir, "tables"), { recursive: true });
    fs.writeFileSync(widgetsPath(), WIDGETS_ROWS, "utf-8");
  };

  beforeAll(async () => {
    grantsScratch = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-tables-grants-int-"),
    );
    const home = path.join(grantsScratch, "home");
    const authDir = path.join(home, ".duckbrain");
    const namespacesPath = path.join(grantsScratch, "namespaces");
    grantsNsDir = path.join(namespacesPath, tableNs);
    fs.mkdirSync(path.join(grantsNsDir, "tables"), { recursive: true });
    fs.mkdirSync(authDir, { recursive: true });

    // Legacy `tables/<table>.table.json` declaration: the surface only serves
    // DECLARED tables (no auto-introspection fallback).
    fs.writeFileSync(
      path.join(grantsNsDir, "tables", "widgets.table.json"),
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
    resetWidgetsFixture();

    const grantsAuthFile = path.join(authDir, "auth.json");
    fs.writeFileSync(
      grantsAuthFile,
      JSON.stringify({
        users: [],
        apiKeys: [
          // write-only on widgets: no read, no role-level write (analyst).
          {
            key: keyAnalystWrite,
            name: keyAnalystWrite,
            namespaces: [tableNs],
            roles: ["analyst"],
            tableGrants: { widgets: "write" },
          },
          // read-only on widgets: the destructive-gap subject.
          {
            key: keyUploaderRead,
            name: keyUploaderRead,
            namespaces: [tableNs],
            roles: ["uploader"],
            tableGrants: { widgets: "read" },
          },
          // role-level tables.write, but NO table read grant.
          {
            key: keyWriterWrite,
            name: keyWriterWrite,
            namespaces: [tableNs],
            roles: ["writer"],
            tableGrants: { widgets: "write" },
          },
          // the happy path: role + per-table rw.
          {
            key: keyWriterRw,
            name: keyWriterRw,
            namespaces: [tableNs],
            roles: ["writer"],
            tableGrants: { widgets: "rw" },
          },
          // No tableGrants map at all: the middleware only restricts when the
          // map is DEFINED, so legacy principals must keep working.
          {
            key: keyLegacyAnalyst,
            name: keyLegacyAnalyst,
            namespaces: [tableNs],
            roles: ["analyst"],
          },
        ],
      }),
      "utf-8",
    );

    grantsServer = await startDuckbrainHttp({
      port: grantsPort,
      authType: "apikey",
      authFile: grantsAuthFile,
      env: {
        HOME: home,
        DUCKBRAIN_DATA_DIR: grantsScratch,
        DUCKBRAIN_NAMESPACES_PATH: namespacesPath,
      },
    });
    await waitForUrl(
      `http://127.0.0.1:${grantsPort}/health`,
      DAEMON_READY_TIMEOUT_MS,
      grantsServer,
    );
  }, 120000);

  afterAll(async () => {
    await stopProcess(grantsServer);
    await removeTempDirSafely(grantsScratch);
  });

  beforeEach(() => {
    resetWidgetsFixture();
  });

  it("write-only table grant: GET /:table is 403 and the row survives a denied DELETE", async () => {
    const read = await curl(
      `${apiKeyHeader(keyAnalystWrite)} http://127.0.0.1:${grantsPort}${tablesBase}/widgets`,
    );
    expect(read.status).toBe(403);
    expect(JSON.parse(read.body)).toMatchObject({ code: "FORBIDDEN" });

    // DELETE must not reach the handler either (analyst has no tables.write).
    const del = await curl(
      `${apiKeyHeader(keyAnalystWrite)} -X DELETE http://127.0.0.1:${grantsPort}${tablesBase}/widgets?pk=eq.1`,
    );
    expect(del.status).toBe(403);
    expect(JSON.parse(del.body)).toMatchObject({ code: "FORBIDDEN" });

    // Both rows are still on disk, byte for byte.
    expect(fs.readFileSync(widgetsPath(), "utf-8")).toBe(WIDGETS_ROWS);

    // Documented minimal design: the declared-table LIST is registry metadata,
    // namespace-scoped only — it answers 200 for a grant-bearing token.
    const list = await curl(
      `${apiKeyHeader(keyAnalystWrite)} http://127.0.0.1:${grantsPort}${tablesBase}`,
    );
    expect(list.status).toBe(200);
    expect(
      (JSON.parse(list.body) as { tables: { name: string }[] }).tables.map(
        (t) => t.name,
      ),
    ).toContain("widgets");
  });

  it("read-only table grant: PATCH and DELETE are 403 and the row is untouched", async () => {
    // The read grant itself works (no over-blocking)...
    const read = await curl(
      `${apiKeyHeader(keyUploaderRead)} http://127.0.0.1:${grantsPort}${tablesBase}/widgets`,
    );
    expect(read.status).toBe(200);
    expect((JSON.parse(read.body) as unknown[]).length).toBe(2);

    // ...but a read-only credential must not destroy data.
    const patch = await curl(
      `${apiKeyHeader(keyUploaderRead)} -X PATCH ${jsonBody({ name: "pwned" })} http://127.0.0.1:${grantsPort}${tablesBase}/widgets?pk=eq.1`,
    );
    expect(patch.status).toBe(403);
    expect(JSON.parse(patch.body)).toMatchObject({ code: "FORBIDDEN" });

    const del = await curl(
      `${apiKeyHeader(keyUploaderRead)} -X DELETE http://127.0.0.1:${grantsPort}${tablesBase}/widgets?pk=eq.1`,
    );
    expect(del.status).toBe(403);
    expect(JSON.parse(del.body)).toMatchObject({ code: "FORBIDDEN" });

    expect(fs.readFileSync(widgetsPath(), "utf-8")).toBe(WIDGETS_ROWS);
  });

  it("write grant: POST inserts while read stays denied; rw grant runs the full CRUD path", async () => {
    const insert = await curl(
      `${apiKeyHeader(keyWriterWrite)} -X POST ${jsonBody({ id: 3, name: "gamma", qty: 2.5 })} http://127.0.0.1:${grantsPort}${tablesBase}/widgets`,
    );
    expect(insert.status).toBe(201);

    // Write-only means no read, even with the writer ROLE (which holds
    // tables.read): the per-table map is what restricts the resource.
    const readDenied = await curl(
      `${apiKeyHeader(keyWriterWrite)} http://127.0.0.1:${grantsPort}${tablesBase}/widgets`,
    );
    expect(readDenied.status).toBe(403);
    expect(JSON.parse(readDenied.body)).toMatchObject({ code: "FORBIDDEN" });

    // rw: read the inserted row, update it by pk, delete it by pk.
    const read = await curl(
      `${apiKeyHeader(keyWriterRw)} http://127.0.0.1:${grantsPort}${tablesBase}/widgets`,
    );
    expect(read.status).toBe(200);
    expect(
      (JSON.parse(read.body) as { id: number }[]).map((row) => row.id).sort(),
    ).toEqual([1, 2, 3]);

    const patch = await curl(
      `${apiKeyHeader(keyWriterRw)} -X PATCH ${jsonBody({ qty: 9.5 })} http://127.0.0.1:${grantsPort}${tablesBase}/widgets?pk=eq.3`,
    );
    expect(patch.status).toBe(200);
    expect(JSON.parse(patch.body)).toEqual({ updated: 1 });

    const del = await curl(
      `${apiKeyHeader(keyWriterRw)} -X DELETE http://127.0.0.1:${grantsPort}${tablesBase}/widgets?pk=eq.3`,
    );
    expect(del.status).toBe(200);
    expect(JSON.parse(del.body)).toEqual({ deleted: 1 });

    const gone = await curl(
      `${apiKeyHeader(keyWriterRw)} http://127.0.0.1:${grantsPort}${tablesBase}/widgets?id=eq.3`,
    );
    expect(gone.status).toBe(200);
    expect(JSON.parse(gone.body)).toEqual([]);
  });

  it("a principal with no tableGrants map stays unrestricted (legacy tokens)", async () => {
    const read = await curl(
      `${apiKeyHeader(keyLegacyAnalyst)} http://127.0.0.1:${grantsPort}${tablesBase}/widgets`,
    );
    expect(read.status).toBe(200);

    // The ROLE layer still applies: analyst has no tables.write.
    const insert = await curl(
      `${apiKeyHeader(keyLegacyAnalyst)} -X POST ${jsonBody({ id: 4, name: "delta", qty: 1.0 })} http://127.0.0.1:${grantsPort}${tablesBase}/widgets`,
    );
    expect(insert.status).toBe(403);
    expect(JSON.parse(insert.body)).toMatchObject({ code: "FORBIDDEN" });
  });
});
