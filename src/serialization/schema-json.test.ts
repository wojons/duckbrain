/**
 * DB-SUPA-6 AC-1 — `schema.json` v1 document contract.
 *
 * The schema file is a closed-world contract: unknown keys, unknown fields,
 * reserved names, invalid paths, bad key columns, noncanonical defaults and
 * restricted-query violations must all be rejected, and a rejected document
 * must never be silently interpreted as an empty schema.
 */

import { describe, expect, it } from "vitest";
import { ApiError } from "../http/middleware/errorHandler";
import {
  formatSchemaDocument,
  parseSchemaDocument,
  schemaDocumentProblems,
  viewExposedColumns,
  type SchemaDocument,
} from "./schemaJson";

/** A document exercising every declared v1 type, both row shapes and a view. */
function validDocument(): SchemaDocument {
  return {
    schemaVersion: 1,
    tables: {
      scores: {
        schemaVersion: 3,
        storage: { path: "tables/scores/current.jsonl" },
        rowShape: "object",
        keyColumns: ["id"],
        columns: [
          { name: "id", type: "string", nullable: false },
          { name: "score", type: "float64", nullable: false, default: 0 },
          { name: "big", type: "int64", nullable: false },
          { name: "active", type: "boolean", nullable: false },
          { name: "note", type: "string", nullable: true },
          { name: "at", type: "timestamp", nullable: true },
          { name: "blob", type: "bytes", nullable: true },
          { name: "meta", type: "json", nullable: true },
        ],
      },
      bench: {
        schemaVersion: 1,
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

function clone(): SchemaDocument {
  return JSON.parse(JSON.stringify(validDocument())) as SchemaDocument;
}

const problems = (document: unknown): string =>
  schemaDocumentProblems(document).join(" | ");

describe("SUPA-6 schema.json v1 document", () => {
  it("rejects unknown fields and invalid declarations", () => {
    // The reference document is valid, and formatting is deterministic.
    expect(schemaDocumentProblems(validDocument())).toEqual([]);
    expect(formatSchemaDocument(validDocument())).toBe(
      formatSchemaDocument(clone()),
    );
    expect(formatSchemaDocument(validDocument()).endsWith("\n")).toBe(true);

    // Unknown top-level key (closed world).
    expect(problems({ ...clone(), extraMetadata: 1 })).toMatch(
      /Unrecognized key|unrecognized/i,
    );
    // Unknown field inside a table declaration.
    const unknownTableField = clone() as unknown as Record<string, unknown>;
    (
      (unknownTableField.tables as Record<string, Record<string, unknown>>)
        .scores as Record<string, unknown>
    ).partitions = ["tables/scores/"];
    expect(problems(unknownTableField)).toMatch(
      /Unrecognized key|unrecognized/i,
    );
    // Unknown field inside a column.
    const unknownColumnField = clone();
    (
      unknownColumnField.tables.scores!.columns[0] as unknown as Record<
        string,
        unknown
      >
    ).sql = "DEFAULT 1";
    expect(problems(unknownColumnField)).toMatch(
      /Unrecognized key|unrecognized/i,
    );

    // Document version is a literal.
    expect(problems({ ...clone(), schemaVersion: 2 })).toMatch(/schemaVersion/);

    // Reserved and malformed resource names.
    const reserved = clone();
    reserved.tables.manifest = reserved.tables.scores!;
    expect(problems(reserved)).toMatch(/reserved/);
    const badName = clone();
    badName.tables["Scores_Two"] = badName.tables.scores!;
    expect(problems(badName)).toMatch(/must match/);

    // Storage path rules: absolute, escaping, wrong extension, shared path.
    for (const storagePath of [
      "/etc/passwd.jsonl",
      "../outside.jsonl",
      "tables/scores/current.ndjson",
      "tables/../scores/current.jsonl",
    ]) {
      const document = clone();
      document.tables.scores!.storage = { path: storagePath };
      expect(problems(document)).toMatch(/storage\.path/);
    }
    const shared = clone();
    shared.tables.bench!.storage = { path: "tables/scores/current.jsonl" };
    expect(problems(shared)).toMatch(/already declared by table 'scores'/);

    // Column rules: empty, duplicate, unsupported type, missing nullable.
    const noColumns = clone();
    noColumns.tables.scores!.columns = [];
    expect(problems(noColumns)).toMatch(/non-empty/);
    const duplicate = clone();
    duplicate.tables.scores!.columns.push({
      name: "id",
      type: "string",
      nullable: false,
    });
    expect(problems(duplicate)).toMatch(/duplicate column/);
    const badType = clone() as unknown as Record<string, unknown>;
    (
      (badType.tables as Record<string, { columns: Record<string, unknown>[] }>)
        .scores!.columns[0] as Record<string, unknown>
    ).type = "decimal(38,2)";
    expect(problems(badType)).toMatch(/unsupported type/);
    const noNullable = clone() as unknown as Record<string, unknown>;
    delete (
      (
        noNullable.tables as Record<
          string,
          { columns: Record<string, unknown>[] }
        >
      ).scores!.columns[0] as Record<string, unknown>
    ).nullable;
    expect(problems(noNullable)).toMatch(/nullable/);

    // Key column rules: undeclared, nullable, non-addressable type, empty.
    const undeclaredKey = clone();
    undeclaredKey.tables.scores!.keyColumns = ["ghost"];
    expect(problems(undeclaredKey)).toMatch(/not a declared column/);
    const nullableKey = clone();
    nullableKey.tables.scores!.keyColumns = ["note"];
    expect(problems(nullableKey)).toMatch(/non-nullable/);
    const jsonKey = clone();
    jsonKey.tables.scores!.columns[7]!.nullable = false;
    jsonKey.tables.scores!.keyColumns = ["meta"];
    expect(problems(jsonKey)).toMatch(/not addressable/);
    const noKey = clone();
    noKey.tables.scores!.keyColumns = [];
    expect(problems(noKey)).toMatch(/keyColumns must be a non-empty/);

    // Defaults must be canonical representations of the declared type.
    const numericInt64Default = clone();
    numericInt64Default.tables.scores!.columns[2]!.default = 1;
    expect(problems(numericInt64Default)).toMatch(/canonical base-10 int64/);
    const localTimestampDefault = clone();
    localTimestampDefault.tables.scores!.columns[5]!.default =
      "2026-01-01T00:00:00";
    expect(problems(localTimestampDefault)).toMatch(/default for column 'at'/);
    const unpaddedBytesDefault = clone();
    unpaddedBytesDefault.tables.scores!.columns[6]!.default = "AAEC";
    expect(problems(unpaddedBytesDefault)).toMatch(/default for column 'blob'/);
    const nullOnRequired = clone();
    nullOnRequired.tables.scores!.columns[2]!.default = null;
    expect(problems(nullOnRequired)).toMatch(/nullable/);

    // View rules: undeclared dependency, restriction violations, projections,
    // undeclared columns.
    const undeclaredDependency = clone();
    undeclaredDependency.views.top_scores!.query =
      "SELECT id, score FROM ghosts WHERE score >= 90";
    expect(problems(undeclaredDependency)).toMatch(
      /not a declared table or view/,
    );
    for (const query of [
      "SELECT id FROM scores; DROP TABLE scores",
      "SELECT id FROM scores WHERE score > (SELECT 1)",
      "SELECT id FROM read_json_auto('tables/scores/current.jsonl')",
      "SELECT id FROM scores JOIN bench ON bench.model = scores.id",
      "SELECT count(*) AS total FROM scores",
    ]) {
      const document = clone();
      document.views.top_scores!.query = query;
      expect(problems(document)).toMatch(/views\.top_scores\.query/);
    }
    const undeclaredProjection = clone();
    undeclaredProjection.views.top_scores!.query =
      "SELECT id, missing FROM scores";
    expect(problems(undeclaredProjection)).toMatch(/not declared on 'scores'/);

    // parseSchemaDocument surfaces every problem with the requested error.
    expect(() =>
      parseSchemaDocument({ schemaVersion: 1, extra: true }),
    ).toThrow(ApiError);
    try {
      parseSchemaDocument({ schemaVersion: 1, extra: true });
    } catch (error) {
      const api = error as ApiError;
      expect(api.code).toBe("SCHEMA_INVALID");
      expect(api.status).toBe(500);
      expect(api.message).toMatch(/Unrecognized key|unrecognized/i);
    }
    try {
      parseSchemaDocument(
        { schemaVersion: 1, tables: { Bad: {} } },
        { status: 400, code: "VALIDATION_ERROR" },
      );
      throw new Error("expected parseSchemaDocument to reject");
    } catch (error) {
      const api = error as ApiError;
      expect(api.status).toBe(400);
      expect(api.code).toBe("VALIDATION_ERROR");
    }
    expect(
      parseSchemaDocument(validDocument()).tables.scores?.schemaVersion,
    ).toBe(3);
  });

  it("exposes declared view columns as the dependency's declared types", () => {
    const document = validDocument();
    expect(viewExposedColumns(document, "top_scores")).toEqual([
      { name: "id", type: "string", nullable: true },
      { name: "score", type: "float64", nullable: true },
    ]);
    // A view over a view resolves through the graph.
    document.views.top_bench = {
      schemaVersion: 1,
      dependsOn: ["bench"],
      query: "SELECT model, score FROM bench",
    };
    expect(viewExposedColumns(document, "top_bench")).toEqual([
      { name: "model", type: "string", nullable: true },
      { name: "score", type: "float64", nullable: true },
    ]);
  });

  it("reports a view dependency cycle", () => {
    const document = clone();
    document.views.a = {
      schemaVersion: 1,
      dependsOn: ["scores", "b"],
      query: "SELECT id, score FROM scores WHERE score >= 1",
    };
    document.views.b = {
      schemaVersion: 1,
      dependsOn: ["a"],
      query: "SELECT id, score FROM a WHERE score >= 1",
    };
    expect(problems(document)).toMatch(/cycle/);
  });
});
