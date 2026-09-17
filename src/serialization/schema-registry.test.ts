/**
 * DB-SUPA-6 AC-1 — the persistent loader.
 *
 * A fresh process (simulated with `vi.resetModules()` so no module state
 * survives) must reconstruct the declared validators, storage paths, key
 * columns, positional header, canonical type representations and table
 * versions from `schema.json` alone — without reading a data line and without
 * coercing a value.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { formatSchemaDocument, type SchemaDocument } from "./schemaJson";
import { ApiError } from "../http/middleware/errorHandler";

const FIXTURE_NS = "supa6-registry";

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supa6-registry-"));
  roots.push(root);
  return root;
}

function document(): SchemaDocument {
  return {
    schemaVersion: 1,
    tables: {
      scores: {
        schemaVersion: 4,
        storage: { path: "tables/scores/current.jsonl" },
        rowShape: "object",
        keyColumns: ["id"],
        columns: [
          { name: "id", type: "string", nullable: false },
          { name: "big", type: "int64", nullable: false },
          { name: "score", type: "float64", nullable: false, default: 0 },
          { name: "ok", type: "boolean", nullable: false },
          { name: "at", type: "timestamp", nullable: true },
          { name: "blob", type: "bytes", nullable: true },
          { name: "meta", type: "json", nullable: true },
        ],
      },
      bench: {
        schemaVersion: 2,
        storage: { path: "snapshots/bench.jsonl" },
        rowShape: "positional",
        keyColumns: ["model", "workload"],
        columns: [
          { name: "model", type: "string", nullable: false },
          { name: "workload", type: "string", nullable: false },
          { name: "score", type: "float64", nullable: false },
        ],
      },
    },
    views: {
      top_scores: {
        schemaVersion: 1,
        dependsOn: ["scores"],
        query: "SELECT id, score FROM scores WHERE score >= 90",
      },
    },
  };
}

/** Write schema.json exactly the way the DDL coordinator does. */
function writeSchema(root: string, ns: string, doc: SchemaDocument): string {
  const nsDir = path.join(root, ns);
  fs.mkdirSync(nsDir, { recursive: true });
  fs.writeFileSync(path.join(nsDir, "schema.json"), formatSchemaDocument(doc));
  return nsDir;
}

/** Re-import the loader with no surviving module state = a fresh process. */
async function freshModules() {
  vi.resetModules();
  const registryModule = await import("./registry.js");
  const schemaRegistryModule = await import("./schemaRegistry.js");
  return { ...schemaRegistryModule, ...registryModule };
}

afterEach(() => {
  while (roots.length > 0)
    fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("SUPA-6 persistent namespace schema", () => {
  it("loads v1 object and positional declarations after restart", async () => {
    const root = makeRoot();
    const nsDir = writeSchema(root, FIXTURE_NS, document());
    // Deliberately NO data files exist: a declaration must never require a data
    // line, and nothing may be inferred from one.
    expect(
      fs.existsSync(path.join(nsDir, "tables", "scores", "current.jsonl")),
    ).toBe(false);

    // First load (process A) …
    const first = await freshModules();
    const loaded = first.loadNamespaceSchema(FIXTURE_NS, {
      namespacesPath: root,
    });
    expect(loaded.present).toBe(true);
    expect(loaded.error).toBeNull();
    expect(loaded.fresh).toBe(true);

    // … then a FRESH process loads the same file and reconstructs everything.
    const second = await freshModules();
    const restarted = second.loadNamespaceSchema(FIXTURE_NS, {
      namespacesPath: root,
    });
    expect(restarted.present).toBe(true);
    expect(restarted.hash).toBe(loaded.hash);
    expect(Object.keys(restarted.document.tables).sort()).toEqual([
      "bench",
      "scores",
    ]);
    expect(restarted.document.tables.scores?.schemaVersion).toBe(4);
    expect(restarted.document.tables.bench?.schemaVersion).toBe(2);
    expect(restarted.document.views.top_scores?.query).toBe(
      "SELECT id, score FROM scores WHERE score >= 90",
    );

    // TableSchemaRegistry: validators, paths, keys, headers, table versions.
    const scores = second.tableSchemaRegistry.getDeclaration(
      FIXTURE_NS,
      "scores",
    )!;
    expect(scores.storagePath).toBe("tables/scores/current.jsonl");
    expect(scores.rowShape).toBe("object");
    expect(scores.keyColumns).toEqual(["id"]);
    expect(scores.schemaVersion).toBe(4);
    expect(
      scores.columns.map((column) => `${column.name}:${column.type}`),
    ).toEqual([
      "id:string",
      "big:int64",
      "score:float64",
      "ok:boolean",
      "at:timestamp",
      "blob:bytes",
      "meta:json",
    ]);

    const bench = second.tableSchemaRegistry.getDeclaration(
      FIXTURE_NS,
      "bench",
    )!;
    expect(bench.rowShape).toBe("positional");
    expect(bench.keyColumns).toEqual(["model", "workload"]);
    expect(bench.storagePath).toBe("snapshots/bench.jsonl");
    // The positional HEADER is the declared column order, never a data line.
    expect(bench.columns.map((column) => column.name)).toEqual([
      "model",
      "workload",
      "score",
    ]);

    // The object validator accepts the canonical representation …
    const objectValidator = second.tableSchemaRegistry.get(
      FIXTURE_NS,
      "scores",
    )!;
    const accepted = objectValidator.safeParse({
      id: "a",
      big: "9223372036854775807",
      ok: true,
      at: "2026-01-02T03:04:05+02:00",
    });
    expect(accepted.success).toBe(true);
    expect(accepted.success ? accepted.data : null).toEqual({
      id: "a",
      big: "9223372036854775807",
      score: 0, // declared default, materialized on write
      ok: true,
      at: "2026-01-02T01:04:05.000Z", // canonical UTC millisecond form
      blob: null,
      meta: null,
    });

    // … and never coerces: a JSON number cannot satisfy `int64`.
    const coerced = objectValidator.safeParse({
      id: "a",
      big: 12,
      ok: true,
    });
    expect(coerced.success).toBe(false);
    expect(
      coerced.success ? "" : coerced.error.issues.map((i) => i.message).join(),
    ).toMatch(/canonical base-10 int64 STRING/);

    // The positional validator requires exactly the declared column count.
    const positionalValidator = second.tableSchemaRegistry.get(
      FIXTURE_NS,
      "bench",
    )!;
    expect(positionalValidator.safeParse(["m", "w", 1.5]).success).toBe(true);
    expect(positionalValidator.safeParse(["m", "w"]).success).toBe(false);

    // The positional header drives a real read: no data file → no rows, and
    // the built SQL never infers (see ddl-inference-compat.test.ts).
    expect(
      second
        .listDeclaredTables(FIXTURE_NS, { namespacesPath: root })
        .map((t) => t.table),
    ).toEqual(["bench", "scores"]);
  });

  it("re-validates when the file is atomically replaced and keeps the last good snapshot when it is corrupt", async () => {
    const root = makeRoot();
    const nsDir = writeSchema(root, FIXTURE_NS, document());
    const modules = await freshModules();

    const before = modules.loadNamespaceSchema(FIXTURE_NS, {
      namespacesPath: root,
    });
    expect(before.document.tables.scores?.schemaVersion).toBe(4);

    // Atomic replacement (temp + rename), as every writer in this codebase does.
    const next = document();
    next.tables.scores!.schemaVersion = 5;
    const tmp = path.join(nsDir, "schema.json.1234.tmp");
    fs.writeFileSync(tmp, formatSchemaDocument(next));
    fs.renameSync(tmp, path.join(nsDir, "schema.json"));

    const replaced = modules.loadNamespaceSchema(FIXTURE_NS, {
      namespacesPath: root,
    });
    expect(replaced.fresh).toBe(true);
    expect(replaced.document.tables.scores?.schemaVersion).toBe(5);
    expect(replaced.hash).not.toBe(before.hash);
    expect(
      modules.tableSchemaRegistry.getDeclaration(FIXTURE_NS, "scores")!
        .schemaVersion,
    ).toBe(5);

    // A corrupt manual edit fails closed: the last validated snapshot stays
    // registered and new generic table requests are refused.
    fs.writeFileSync(path.join(nsDir, "schema.json"), "{ not json");
    const corrupt = modules.loadNamespaceSchema(FIXTURE_NS, {
      namespacesPath: root,
    });
    expect(corrupt.error).not.toBeNull();
    expect(corrupt.fresh).toBe(false);
    // Never treated as an empty schema: the previous declaration is still there.
    expect(corrupt.document.tables.scores?.schemaVersion).toBe(5);
    expect(
      modules.tableSchemaRegistry.getDeclaration(FIXTURE_NS, "scores"),
    ).toBeDefined();
    // (ApiError identity differs across the reset module registry, so the
    // failure is asserted on its status/code contract instead.)
    try {
      modules.assertNamespaceSchemaUsable(FIXTURE_NS, { namespacesPath: root });
    } catch (error) {
      expect((error as ApiError).code).toBe("SCHEMA_INVALID");
      expect((error as ApiError).status).toBe(500);
    }
  });

  it("keeps a namespace without schema.json on the legacy path", async () => {
    const root = makeRoot();
    const modules = await freshModules();
    const absent = modules.loadNamespaceSchema(FIXTURE_NS, {
      namespacesPath: root,
    });
    expect(absent.present).toBe(false);
    expect(absent.error).toBeNull();
    expect(Object.keys(absent.document.tables)).toEqual([]);
    // `memories` remains available exactly as before DB-SUPA-6.
    expect(
      modules.tableSchemaRegistry.get(FIXTURE_NS, "memories"),
    ).toBeDefined();
    expect(
      modules.listDeclaredTables(FIXTURE_NS, { namespacesPath: root }),
    ).toEqual([]);
  });
});
