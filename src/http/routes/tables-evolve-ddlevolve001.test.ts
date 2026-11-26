/**
 * DDL-EVOLVE-001 — the safe evolution path is reachable, and the unsafe one
 * is fenced.
 *
 * Four arms, mirroring the row's acceptance criteria:
 *
 *   AC-1  `declare --force` on a POPULATED table whose contract differs is
 *         refused 409 EVOLUTION_REQUIRED (naming addColumn / retypeColumn) on
 *         every surface — the DDL core (declareTable, which the CLI calls),
 *         the HTTP declare route, the MCP tables_declare tool and the real
 *         argv parser — and the table stays fully readable and patchable
 *         afterwards. An EMPTY table may still be force-declared.
 *   AC-2  addColumn / retypeColumn are reachable over HTTP (alter route), MCP
 *         (tables_alter) and CLI (`tables alter`), implemented ONLY through
 *         the ddl.ts coordinator; drop/rename/key-change ops are refused 400.
 *   AC-3  (b) logical addColumn leaves the JSONL bytes untouched and old rows
 *         read the pinned null/default; (c) a materialize addColumn publishes
 *         exactly one immutable generation; (d) declareView is rejected as
 *         unsupported at the surfaces (no route serves views yet).
 *
 * Hermetic: DUCKBRAIN_NAMESPACES_PATH points at a temp root.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import express, { NextFunction, Request, Response } from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { createTable, type DdlCallOptions } from "../../serialization/ddl";
import type { AuthPrincipal } from "../../auth/middleware";
import {
  invalidateTableRegistry,
} from "../../schema/table-registry";
import { createTableRoutes } from "./tables";
import { declareTable, TableDeclareError } from "../../tables/declare";
import { runTablesCli, TablesCliError } from "../../cli/tables";
import { tablesAlterTool, tablesDeclareTool } from "../../mcp/tools/tables";

const NS = "supa6-evolve-surface";
const ADMIN: AuthPrincipal = {
  name: "admin-token",
  authenticated: true,
  roles: ["admin"],
};

let root = "";
let nsDir = "";

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

function lines(file: string): string[] {
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

function scoresFile(): string {
  return path.join(nsDir, "tables", "scores", "current.jsonl");
}

interface HttpResult {
  status: number;
  body: any;
}

function httpRequest(
  app: express.Express,
  method: string,
  reqPath: string,
  body?: unknown,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const { createServer } = require("http") as typeof import("http");
    const server = createServer(app);
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

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(`/api/ns/:ns/tables`, createTableRoutes());
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.status || 500).json({ error: err.message, code: err.code });
  });
  return app;
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "supa6-evolve-surface-"));
  process.env.DUCKBRAIN_NAMESPACES_PATH = root;
  nsDir = path.join(root, NS);
  fs.mkdirSync(nsDir, { recursive: true });

  // `scores`: two live rows under the declared path.
  fs.mkdirSync(path.dirname(scoresFile()), { recursive: true });
  fs.writeFileSync(
    scoresFile(),
    `${JSON.stringify({ id: "a", score: 1.5 })}\n${JSON.stringify({ id: "b", score: 2.5 })}\n`,
  );
  const scores = await createTable(
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
  expect(scores.ok).toBe(true);

  // `logs`: a string column whose values are JSON-in-string, so a
  // string -> json retype can be exercised end to end.
  const logsFile = path.join(nsDir, "tables", "logs", "current.jsonl");
  fs.mkdirSync(path.dirname(logsFile), { recursive: true });
  fs.writeFileSync(
    logsFile,
    `${JSON.stringify({ id: "r1", note: '"hello"' })}\n${JSON.stringify({ id: "r2", note: '"bye"' })}\n`,
  );
  const logs = await createTable(
    NS,
    {
      table: "logs",
      rowShape: "object",
      keyColumns: ["id"],
      storagePath: "tables/logs/current.jsonl",
      columns: [
        { name: "id", type: "string", nullable: false },
        { name: "note", type: "string", nullable: true },
      ],
    },
    options(),
  );
  expect(logs.ok).toBe(true);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.DUCKBRAIN_NAMESPACES_PATH;
});

afterEach(() => {
  invalidateTableRegistry(NS);
});

// ---------------------------------------------------------------------------
// AC-1: force on a populated table is refused, everywhere, and the table
// stays healthy
// ---------------------------------------------------------------------------

describe("DDL-EVOLVE-001 AC-1: force is refused on populated tables", () => {
  it("declareTable (the CLI core) refuses with EVOLUTION_REQUIRED and writes nothing", async () => {
    const before = sha(path.join(nsDir, "schema.json"));
    let caught: unknown;
    try {
      await declareTable({
        ns: NS,
        table: "scores",
        columns: [{ name: "id", type: "varchar" }],
        force: true,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TableDeclareError);
    const refusal = caught as TableDeclareError;
    expect(refusal.kind).toBe("refusal");
    expect(refusal.code).toBe("EVOLUTION_REQUIRED");
    expect(refusal.message).toContain("addColumn");
    expect(refusal.message).toContain("retypeColumn");
    // Nothing was written: the schema document is byte-identical.
    expect(sha(path.join(nsDir, "schema.json"))).toBe(before);
  });

  it("the HTTP declare route answers 409 EVOLUTION_REQUIRED; the table still GETs and PATCHes", async () => {
    const app = makeApp();
    const refused = await httpRequest(
      app,
      "POST",
      `/api/ns/${NS}/tables/scores/declare`,
      { columns: [{ name: "id", type: "varchar" }], force: true },
    );
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("EVOLUTION_REQUIRED");
    expect(refused.body.error).toContain("addColumn");

    // The table is untouched and fully usable through the generic paths.
    const read = await httpRequest(app, "GET", `/api/ns/${NS}/tables/scores`);
    expect(read.status).toBe(200);
    const rows = read.body as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.id).sort()).toEqual(["a", "b"]);
    expect(rows.every((row) => row.score === 1.5 || row.score === 2.5)).toBe(
      true,
    );

    const patched = await httpRequest(
      app,
      "PATCH",
      `/api/ns/${NS}/tables/scores?pk=eq.a`,
      { score: 9.5 },
    );
    expect(patched.status).toBe(200);
    const after = await httpRequest(app, "GET", `/api/ns/${NS}/tables/scores`);
    const rowA = (after.body as Array<Record<string, unknown>>).find(
      (row) => row.id === "a",
    );
    expect(rowA?.score).toBe(9.5);
  });

  it("the MCP tables_declare tool refuses with the same code", async () => {
    const refused = await tablesDeclareTool({
      namespace: NS,
      table: "scores",
      columns: [{ name: "id", type: "varchar" }],
      force: true,
    });
    expect(refused.success).toBe(false);
    expect(refused.code).toBe("EVOLUTION_REQUIRED");
    expect(refused.error).toContain("retypeColumn");
  });

  it("the CLI argv surface refuses with exit 1 and the same message", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      const code = await runTablesCli([
        "declare",
        NS,
        "scores",
        "--column",
        "id=varchar",
        "--force",
      ]);
      expect(code).toBe(1);
      expect(errors.join("\n")).toContain("EVOLUTION_REQUIRED");
      expect(errors.join("\n")).toContain("addColumn");
    } finally {
      spy.mockRestore();
    }
  });

  it("force on an EMPTY table still works (no rows to strand)", async () => {
    const declared = await declareTable({
      ns: NS,
      table: "empty",
      columns: [{ name: "id", type: "varchar" }],
    });
    expect(declared.format).toBe("schema.json");
    const replaced = await declareTable({
      ns: NS,
      table: "empty",
      columns: [
        { name: "id", type: "integer" },
        { name: "x", type: "varchar" },
      ],
      force: true,
    });
    expect(replaced.replacedExisting).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-2 / AC-3b/3c: the alter surfaces drive the ddl.ts coordinator only
// ---------------------------------------------------------------------------

describe("DDL-EVOLVE-001 AC-2/AC-3: addColumn / retypeColumn over the surfaces", () => {
  it("HTTP alter addColumn (logical) leaves the JSONL bytes untouched and old rows read the pinned null", async () => {
    const app = makeApp();
    const before = sha(scoresFile());
    const beforeLines = lines(scoresFile());

    const added = await httpRequest(
      app,
      "POST",
      `/api/ns/${NS}/tables/scores/alter`,
      {
        op: "addColumn",
        column: { name: "note", type: "string", nullable: true },
      },
    );
    expect(added.status).toBe(200);
    expect(added.body.ok).toBe(true);
    expect(added.body.operation).toBe("addColumn");
    expect(added.body.schemaVersion).toBe(2);
    expect(added.body.generation).toBeUndefined(); // logical: no rewrite

    expect(sha(scoresFile())).toBe(before);
    expect(lines(scoresFile())).toEqual(beforeLines);

    const read = await httpRequest(app, "GET", `/api/ns/${NS}/tables/scores`);
    for (const row of read.body as Array<Record<string, unknown>>)
      expect(row.note).toBeNull();
  });

  it("HTTP alter addColumn (default) pins the declared default onto old rows", async () => {
    const app = makeApp();
    const before = sha(scoresFile());
    const added = await httpRequest(
      app,
      "POST",
      `/api/ns/${NS}/tables/scores/alter`,
      {
        op: "addColumn",
        column: {
          name: "tag",
          type: "string",
          nullable: false,
          default: "promoted",
        },
      },
    );
    expect(added.status).toBe(200);
    expect(added.body.generation).toBeUndefined();
    expect(sha(scoresFile())).toBe(before);

    const read = await httpRequest(app, "GET", `/api/ns/${NS}/tables/scores`);
    for (const row of read.body as Array<Record<string, unknown>>)
      expect(row.tag).toBe("promoted");
  });

  it("HTTP alter addColumn (materialize) publishes exactly ONE generation and GET serves it", async () => {
    const app = makeApp();
    const added = await httpRequest(
      app,
      "POST",
      `/api/ns/${NS}/tables/scores/alter`,
      {
        op: "addColumn",
        column: {
          name: "level",
          type: "float64",
          nullable: false,
          default: 1,
        },
        policy: "materialize",
      },
    );
    expect(added.status).toBe(200);
    const generation = added.body.generation as {
      path: string;
      previousPath: string;
      sha256: string;
      rows: number;
    };
    expect(generation.rows).toBe(2);
    expect(generation.previousPath).toBe("tables/scores/current.jsonl");

    // Exactly one generation file exists for the table, at the published path,
    // with the digested bytes.
    const generationsDir = path.join(
      nsDir,
      "tables",
      "scores",
      "generations",
    );
    const entries = fs
      .readdirSync(generationsDir)
      .filter((entry) => entry.endsWith(".jsonl"));
    expect(entries).toEqual([generation.path.split("/").pop()]);
    const generationAbs = path.join(nsDir, generation.path);
    expect(fs.existsSync(generationAbs)).toBe(true);
    expect(sha(generationAbs)).toBe(generation.sha256);

    // The OLD generation (the live file before the switch) is untouched —
    // never renamed over or deleted.
    expect(fs.existsSync(scoresFile())).toBe(true);

    // The schema switch points the declared path at the generation.
    const document = JSON.parse(
      fs.readFileSync(path.join(nsDir, "schema.json"), "utf-8"),
    );
    expect(document.tables.scores.storage.path).toBe(generation.path);

    // The generic read serves the materialized rows.
    const read = await httpRequest(app, "GET", `/api/ns/${NS}/tables/scores`);
    const rows = read.body as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.level).toBe(1);
      expect(row.note).toBeNull();
      expect(row.tag).toBe("promoted");
    }
  });

  it("HTTP alter refuses unsupported ops: drop / rename / key change / declareView", async () => {
    const app = makeApp();
    for (const op of ["dropColumn", "renameColumn", "changeKey"]) {
      const refused = await httpRequest(
        app,
        "POST",
        `/api/ns/${NS}/tables/scores/alter`,
        { op },
      );
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe("OP_UNSUPPORTED");
      expect(refused.body.error).toContain(op);
    }
    const viewRefused = await httpRequest(
      app,
      "POST",
      `/api/ns/${NS}/tables/scores/alter`,
      { op: "declareView" },
    );
    expect(viewRefused.status).toBe(400);
    expect(viewRefused.body.code).toBe("VIEW_UNSUPPORTED");
  });

  it("MCP tables_alter addColumn and retypeColumn run the coordinator and materialize the retype", async () => {
    const added = await tablesAlterTool({
      namespace: NS,
      table: "logs",
      op: "addColumn",
      column: { name: "extra", type: "json", nullable: true },
    });
    expect(added.success).toBe(true);
    expect(added.operation).toBe("addColumn");
    expect(added.schemaVersion).toBe(2);
    expect(added.generation).toBeUndefined();

    const retyped = await tablesAlterTool({
      namespace: NS,
      table: "logs",
      op: "retypeColumn",
      column: "note",
      type: "json",
    });
    expect(retyped.success).toBe(true);
    expect(retyped.operation).toBe("retypeColumn");
    expect(retyped.schemaVersion).toBe(3);
    const generation = retyped.generation as {
      path: string;
      sha256: string;
      rows: number;
    };
    expect(generation.rows).toBe(2);
    const generationAbs = path.join(nsDir, generation.path);
    expect(fs.existsSync(generationAbs)).toBe(true);
    expect(sha(generationAbs)).toBe(generation.sha256);

    // The converted generation carries the PARSED json values.
    const converted = lines(generationAbs).map((line) => JSON.parse(line));
    expect(converted.map((row) => row.note)).toEqual(["hello", "bye"]);

    const document = JSON.parse(
      fs.readFileSync(path.join(nsDir, "schema.json"), "utf-8"),
    );
    expect(document.tables.logs.storage.path).toBe(generation.path);
  });

  it("MCP tables_alter refuses unsupported ops with the same vocabulary", async () => {
    const dropped = await tablesAlterTool({
      namespace: NS,
      table: "scores",
      op: "dropColumn",
    });
    expect(dropped.success).toBe(false);
    expect(dropped.code).toBe("OP_UNSUPPORTED");

    const viewed = await tablesAlterTool({
      namespace: NS,
      table: "scores",
      op: "declareView",
    });
    expect(viewed.success).toBe(false);
    expect(viewed.code).toBe("VIEW_UNSUPPORTED");
  });

  it("the CLI `tables alter` adds a column with a default and retypes over the coordinator", async () => {
    const logs1: string[] = [];
    const outSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs1.push(args.map(String).join(" "));
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // add-column with a JSON default → policy 'default' → old rows pin it.
      const added = await runTablesCli([
        "alter",
        NS,
        "scores",
        "add-column",
        "rank=string",
        "--default",
        '"unranked"',
      ]);
      expect(added).toBe(0);
      expect(logs1.join("\n")).toContain("rank");

      const app = makeApp();
      const read = await httpRequest(app, "GET", `/api/ns/${NS}/tables/scores`);
      for (const row of read.body as Array<Record<string, unknown>>)
        expect(row.rank).toBe("unranked");

      // retype-column: scores.note string -> json (values are all null).
      const retyped = await runTablesCli([
        "alter",
        NS,
        "scores",
        "retype-column",
        "note",
        "json",
      ]);
      expect(retyped).toBe(0);
      expect(logs1.join("\n")).toContain("Materialized generation:");
      const document = JSON.parse(
        fs.readFileSync(path.join(nsDir, "schema.json"), "utf-8"),
      );
      expect(document.tables.scores.columns.find((c: { name: string }) => c.name === "note").type).toBe("json");
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("the CLI alter refuses a non-declared type at the argv layer", async () => {
    const errors: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      // `varchar` is the DuckDB-facing name, NOT a declared v1 type — a usage
      // error, so runTablesCli throws it for the bin to print (exit 1) and
      // the message names the declared types.
      let caught: unknown;
      try {
        await runTablesCli([
          "alter",
          NS,
          "scores",
          "add-column",
          "x=varchar",
        ]);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(TablesCliError);
      expect((caught as Error).message).toContain("declared type");
      expect(errors.join("\n")).not.toContain("EVOLUTION_REQUIRED");
    } finally {
      errSpy.mockRestore();
    }
  });
});
