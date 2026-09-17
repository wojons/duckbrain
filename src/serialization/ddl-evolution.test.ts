/**
 * DB-SUPA-6 AC-4 — add-column compatibility.
 *
 * `null` and `default` are LOGICAL read policies: the source JSONL is never
 * rewritten, absent historical fields resolve to the pinned null/default, and
 * a new non-nullable write must supply the column. The proof drives the real
 * generic paths: the schema.json declaration is read through the SUPA-3
 * generic table read, and writes go through the SUPA-2 serializer exactly as
 * the REST route does.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import crypto from "crypto";
import express, { NextFunction, Request, Response } from "express";
import fs from "fs";
import { createServer, type Server } from "http";
import os from "os";
import path from "path";
import { addColumn, createTable, type DdlCallOptions } from "./ddl";
import type { AuthPrincipal } from "../auth/middleware";
import { getNamespaceWriter } from "./namespaceWriter";
import {
  getTable,
  invalidateTableRegistry,
  namespaceDir,
} from "../schema/table-registry";
import { buildSelectPlan, executeSelectPlan } from "../duckdb/table-store";
import { createTableRoutes } from "../http/routes/tables";
import { ApiError } from "../http/middleware/errorHandler";

const NS = "supa6-evolution";
const ADMIN: AuthPrincipal = {
  name: "admin-token",
  authenticated: true,
  roles: ["admin"],
};

let root = "";
let nsDir = "";
let storage = "";

function options(): DdlCallOptions {
  return {
    namespacesPath: root,
    principal: ADMIN,
    scheduleCommit: () => undefined,
  };
}

function sha(file: string): string {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

async function readRows(table: string): Promise<Record<string, unknown>[]> {
  invalidateTableRegistry(NS);
  const declaration = getTable(NS, table);
  const plan = buildSelectPlan(declaration, { limit: 100 });
  const result = await executeSelectPlan(namespaceDir(NS), declaration, plan);
  return result.rows;
}

/** The real generic write path for a declared table (same call the route makes). */
async function writeRow(row: Record<string, unknown>) {
  const declaration = getTable(NS, "scores");
  const { storedRowFromApiRow } = await import("./schemaTypes.js");
  const { coerceRowAgainstDeclaration } =
    await import("../duckdb/table-store.js");
  let canonical: Record<string, unknown>;
  try {
    // Exactly what POST /tables/:table does first: declared validation +
    // pinned compatibility adapter.
    canonical = coerceRowAgainstDeclaration(declaration, row);
  } catch (error) {
    const api = error as ApiError;
    return { ok: false as const, code: api.code ?? "VALIDATION_ERROR" };
  }
  const writer = getNamespaceWriter(NS, {
    namespacesPath: root,
    scheduleCommit: () => undefined,
  });
  const record = storedRowFromApiRow(
    declaration.columns.map((column) => ({
      name: column.name,
      type: column.declaredType!,
      nullable: column.nullable ?? true,
      ...(column.hasDefault ? { default: column.default } : {}),
    })),
    "object",
    canonical,
  );
  return writer.enqueue({
    ns: NS,
    table: "scores",
    op: "insert",
    record,
    principal: ADMIN,
    targetPath: declaration.glob,
    ...(declaration.glob.startsWith("events/")
      ? { partitionPath: "events/2026-09/" }
      : {}),
  });
}

function lines(file: string): string[] {
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

interface HttpResult {
  status: number;
  body: unknown;
}

function httpRequest(
  app: express.Express,
  method: string,
  reqPath: string,
  body?: unknown,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : 0;
      const http = require("http") as typeof import("http");
      const request = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: reqPath,
          method,
          headers: {
            Host: "localhost",
            ...(body !== undefined
              ? { "Content-Type": "application/json" }
              : {}),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => {
            data += chunk.toString();
          });
          res.on("end", () => {
            server.close();
            let parsed: unknown = data;
            try {
              parsed = JSON.parse(data);
            } catch {
              // non-JSON response stays raw
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      request.on("error", (error: Error) => {
        server.close();
        reject(error);
      });
      if (body !== undefined) request.write(JSON.stringify(body));
      request.end();
    });
  });
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "supa6-evolution-"));
  process.env.DUCKBRAIN_NAMESPACES_PATH = root;
  nsDir = path.join(root, NS);
  storage = path.join(nsDir, "tables", "scores", "current.jsonl");
  fs.mkdirSync(path.dirname(storage), { recursive: true });
  fs.writeFileSync(
    storage,
    `${JSON.stringify({ id: "a", score: 1.5 })}\n${JSON.stringify({ id: "b", score: 2.5 })}\n`,
  );
  const created = await createTable(
    NS,
    {
      table: "scores",
      rowShape: "object",
      keyColumns: ["id"],
      storagePath: "tables/scores/current.jsonl",
      columns: [
        { name: "id", type: "string", nullable: false },
        { name: "score", type: "float64", nullable: false },
      ],
    },
    options(),
  );
  expect(created.ok).toBe(true);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.DUCKBRAIN_NAMESPACES_PATH;
});

afterEach(() => {
  invalidateTableRegistry(NS);
});

describe("SUPA-6 add-column compatibility", () => {
  it("null backfill is logical", async () => {
    const before = sha(storage);
    const beforeLines = lines(storage);

    const added = await addColumn(
      NS,
      {
        table: "scores",
        column: { name: "note", type: "string", nullable: true },
      },
      options(),
    );
    expect(added.ok).toBe(true);
    expect(added.schemaVersion).toBe(2);
    expect(added.generation).toBeUndefined(); // logical policy: no rewrite

    // The source JSONL is byte-identical and every historical row reads null.
    expect(sha(storage)).toBe(before);
    expect(lines(storage)).toEqual(beforeLines);
    const rows = await readRows("scores");
    expect(rows).toEqual([
      { id: "a", score: 1.5, note: null },
      { id: "b", score: 2.5, note: null },
    ]);

    // A new write may omit the nullable column (it reads back as null) …
    const omitted = await writeRow({ id: "c", score: 3.5 });
    expect(omitted.ok).toBe(true);
    const withValue = await writeRow({ id: "d", score: 4.5, note: "hello" });
    expect(withValue.ok).toBe(true);
    const afterWrite = await readRows("scores");
    expect(afterWrite).toHaveLength(4);
    expect(afterWrite[2]).toEqual({ id: "c", score: 3.5, note: null });
    expect(afterWrite[3]).toEqual({ id: "d", score: 4.5, note: "hello" });
    // Old rows are still untouched on disk.
    expect(lines(storage).slice(0, 2)).toEqual(beforeLines);

    // A new non-nullable write requires the column: `score` has no default.
    const missingRequired = await writeRow({ id: "e" });
    expect(missingRequired).toMatchObject({
      ok: false,
      code: "VALIDATION_ERROR",
    });
    expect(lines(storage)).toHaveLength(4);
  });

  it("default backfill is logical and new writes materialize", async () => {
    const before = sha(storage);
    const beforeLines = lines(storage);

    const added = await addColumn(
      NS,
      {
        table: "scores",
        column: {
          name: "tag",
          type: "string",
          nullable: false,
          default: "promoted",
        },
      },
      options(),
    );
    expect(added.ok).toBe(true);
    expect(added.generation).toBeUndefined();
    expect(added.schemaVersion).toBe(3);
    // Logical policy: the historical file is untouched.
    expect(sha(storage)).toBe(before);

    const rows = await readRows("scores");
    for (const row of rows) expect(row.tag).toBe("promoted");

    // A new write that omits the column materializes the declared default …
    const materialized = await writeRow({ id: "f", score: 6.5 });
    expect(materialized.ok).toBe(true);
    // … and a supplied value wins.
    const supplied = await writeRow({ id: "g", score: 7.5, tag: "custom" });
    expect(supplied.ok).toBe(true);

    const stored = lines(storage);
    expect(JSON.parse(stored[stored.length - 2]!)).toEqual({
      id: "f",
      score: 6.5,
      note: null,
      tag: "promoted",
    });
    expect(JSON.parse(stored[stored.length - 1]!)).toEqual({
      id: "g",
      score: 7.5,
      note: null,
      tag: "custom",
    });
    // Every historical line is exactly what it was before the DDL.
    expect(stored.slice(0, beforeLines.length)).toEqual(beforeLines);

    // The generic REST route uses the same serializer path for a declared
    // table: it appends at the DECLARED storage path and validates against the
    // declared contract.
    const app = express();
    app.use(express.json());
    app.use(`/api/ns/:ns/tables`, createTableRoutes());
    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
      res
        .status(err.status || 500)
        .json({ error: err.message, code: err.code });
    });
    const posted = await httpRequest(
      app,
      "POST",
      `/api/ns/${NS}/tables/scores`,
      { id: "h", score: 8.5 },
    );
    expect(posted.status).toBe(201);
    expect(posted.body).toEqual({ inserted: 1 });
    const afterHttp = lines(storage);
    expect(JSON.parse(afterHttp[afterHttp.length - 1]!)).toEqual({
      id: "h",
      score: 8.5,
      note: null,
      tag: "promoted",
    });
    // The declared type contract is enforced on the HTTP path too.
    const rejected = await httpRequest(
      app,
      "POST",
      `/api/ns/${NS}/tables/scores`,
      { id: "i", score: "not-a-number" },
    );
    expect(rejected.status).toBe(422);
    expect(lines(storage)).toHaveLength(afterHttp.length);
  });
});
