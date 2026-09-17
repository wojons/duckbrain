/**
 * DB-SUPA-6 AC-1 (canonical representations) and AC-9 (strict value
 * semantics) — the declared type contract, proven through the generic table
 * read/write path (not just unit-level helpers).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  applyDeclaredReadCompat,
  declaredReadType,
  jsonlLineForApiRow,
  normalizeApiRow,
  normalizeDeclaredValue,
  storedRowFromApiRow,
  type DeclaredColumn,
} from "./schemaTypes";
import {
  buildSelectPlan,
  coerceRowAgainstDeclaration,
  executeSelectPlan,
} from "../duckdb/table-store";
import {
  getTable,
  invalidateTableRegistry,
  namespaceDir,
} from "../schema/table-registry";
import { formatSchemaDocument, type SchemaDocument } from "./schemaJson";
import { invalidateNamespaceSchema } from "./schemaRegistry";
import { ApiError } from "../http/middleware/errorHandler";

const NS = "supa6-types";
let root = "";

const NUMBER_COLUMNS: DeclaredColumn[] = [
  { name: "id", type: "string", nullable: false },
  { name: "big", type: "int64", nullable: false },
  { name: "score", type: "float64", nullable: true },
  { name: "ok", type: "boolean", nullable: true },
  { name: "at", type: "timestamp", nullable: true },
  { name: "blob", type: "bytes", nullable: true },
  { name: "meta", type: "json", nullable: true },
];

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "supa6-types-"));
  process.env.DUCKBRAIN_NAMESPACES_PATH = root;
  const nsDir = path.join(root, NS);
  fs.mkdirSync(path.join(nsDir, "tables", "numbers"), { recursive: true });
  const document: SchemaDocument = {
    schemaVersion: 1,
    tables: {
      numbers: {
        schemaVersion: 1,
        storage: { path: "tables/numbers/current.jsonl" },
        rowShape: "object",
        keyColumns: ["id"],
        columns: NUMBER_COLUMNS,
      },
    },
    views: {},
  };
  fs.writeFileSync(
    path.join(nsDir, "schema.json"),
    formatSchemaDocument(document),
  );
  fs.writeFileSync(
    path.join(nsDir, "tables", "numbers", "current.jsonl"),
    `${JSON.stringify({
      id: "max",
      big: "9223372036854775807",
      score: 1.25,
      ok: true,
      at: "2026-01-02T03:04:05.678Z",
      blob: "base64url:AAEC",
      meta: { nested: [1, 2, 3] },
    })}\n${JSON.stringify({ id: "min", big: "-9223372036854775808", score: -0 })}\n`,
  );
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.DUCKBRAIN_NAMESPACES_PATH;
});

afterEach(() => {
  invalidateTableRegistry(NS);
  invalidateNamespaceSchema(NS);
});

/** Read every row of a declared table through the generic table path. */
async function readDeclared(table: string) {
  const declaration = getTable(NS, table);
  const plan = buildSelectPlan(declaration, { limit: 50 });
  return executeSelectPlan(namespaceDir(NS), declaration, plan);
}

describe("SUPA-6 declared type representations", () => {
  it("declared types use canonical JSONL and API representations", () => {
    // On-disk / API representation per declared type.
    const row = {
      id: "a",
      big: "9223372036854775807",
      score: 1.5,
      ok: true,
      at: "2026-01-02T03:04:05.678Z",
      blob: "base64url:AAEC",
      meta: { k: [1, "two"] },
    };
    const normalized = normalizeApiRow(NUMBER_COLUMNS, row);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.value).toEqual(row);
    // int64/timestamp/bytes stay STRINGS in both directions; only json keeps
    // structural nesting.
    expect(typeof normalized.value.big).toBe("string");
    expect(typeof normalized.value.at).toBe("string");
    expect(typeof normalized.value.blob).toBe("string");
    expect(normalized.value.meta).toEqual({ k: [1, "two"] });

    // Canonical JSONL line + positional mapping.
    expect(jsonlLineForApiRow(NUMBER_COLUMNS, "object", normalized.value)).toBe(
      JSON.stringify(row),
    );
    expect(
      storedRowFromApiRow(NUMBER_COLUMNS, "positional", normalized.value),
    ).toEqual([
      "a",
      "9223372036854775807",
      1.5,
      true,
      "2026-01-02T03:04:05.678Z",
      "base64url:AAEC",
      { k: [1, "two"] },
    ]);

    // Read types: exact text for the string-carried types, native for the
    // rest.
    expect(declaredReadType(NUMBER_COLUMNS[1]!)).toBe("VARCHAR");
    expect(declaredReadType(NUMBER_COLUMNS[4]!)).toBe("VARCHAR");
    expect(declaredReadType(NUMBER_COLUMNS[5]!)).toBe("VARCHAR");
    expect(declaredReadType(NUMBER_COLUMNS[2]!)).toBe("DOUBLE");
    expect(declaredReadType(NUMBER_COLUMNS[3]!)).toBe("BOOLEAN");
  });

  it("int64 precision survives JavaScript boundary", async () => {
    const result = await readDeclared("numbers");
    expect(result.rows).toHaveLength(2);
    const [first, second] = result.rows;
    // Exact canonical text — never a rounded JavaScript number.
    expect(first!.big).toBe("9223372036854775807");
    expect(second!.big).toBe("-9223372036854775808");
    expect(typeof first!.big).toBe("string");
    // A JSON number input is refused BEFORE enqueue: a JSON number cannot carry
    // 64 bits through the JavaScript boundary.
    const declaration = getTable(NS, "numbers");
    expect(() =>
      coerceRowAgainstDeclaration(declaration, {
        id: "x",
        big: 9223372036854775807,
      }),
    ).toThrow(/canonical base-10 int64 STRING/);
    // Noncanonical text is refused too (leading zero / '+' / exponent).
    for (const bad of ["0123", "+42", "1e3", "1.0", " 42 ", "-0x10"]) {
      expect(() =>
        coerceRowAgainstDeclaration(declaration, { id: "x", big: bad }),
      ).toThrow(ApiError);
    }
    expect(() =>
      coerceRowAgainstDeclaration(declaration, {
        id: "x",
        big: "9223372036854775808",
      }),
    ).toThrow(/signed 64-bit range/);
    // -0 normalizes to 0 for the canonical stored form.
    expect(
      normalizeDeclaredValue(
        { name: "score", type: "float64", nullable: true },
        -0,
      ),
    ).toBe(0);
  });

  it("timestamp and bytes normalize canonically", async () => {
    const result = await readDeclared("numbers");
    // Stored canonical UTC text survives the read exactly.
    expect(result.rows[0]!.at).toBe("2026-01-02T03:04:05.678Z");
    expect(result.rows[0]!.blob).toBe("base64url:AAEC");

    const at: DeclaredColumn = {
      name: "at",
      type: "timestamp",
      nullable: true,
    };
    const blob: DeclaredColumn = {
      name: "blob",
      type: "bytes",
      nullable: true,
    };
    // Offsets are parsed and normalized to millisecond UTC.
    expect(normalizeDeclaredValue(at, "2026-01-02T03:04:05+02:00")).toBe(
      "2026-01-02T01:04:05.000Z",
    );
    expect(normalizeDeclaredValue(at, "2026-01-02T03:04:05.5Z")).toBe(
      "2026-01-02T03:04:05.500Z",
    );
    // Date-only, local time without offset, and numeric epochs are rejected.
    for (const bad of ["2026-01-02", "2026-01-02T03:04:05", 1767323045]) {
      expect(() => normalizeDeclaredValue(at, bad)).toThrow(ApiError);
    }
    // bytes: the envelope is required, the payload must be unpadded base64url.
    expect(normalizeDeclaredValue(blob, "base64url:AAEC")).toBe(
      "base64url:AAEC",
    );
    for (const bad of [
      "AAEC",
      "base64url:AAEC==",
      "base64url:AA+E/C",
      "base64url:",
      "plain text",
    ]) {
      expect(() => normalizeDeclaredValue(blob, bad)).toThrow(ApiError);
    }

    // Round-trip through the generic write path: canonical in → canonical out.
    const declaration = getTable(NS, "numbers");
    const coerced = coerceRowAgainstDeclaration(declaration, {
      id: "canon",
      big: "1",
      at: "2026-01-02T03:04:05+02:00",
      blob: "base64url:AAEC",
    });
    expect(coerced.at).toBe("2026-01-02T01:04:05.000Z");
    expect(coerced.blob).toBe("base64url:AAEC");
  });

  it("json null and nullable rule are explicit", () => {
    const nullable = NUMBER_COLUMNS.find((column) => column.name === "meta")!;
    // A JSON null is allowed only for a nullable column.
    expect(normalizeApiRow([nullable], { meta: null }).ok).toBe(true);
    expect(
      normalizeApiRow([{ ...nullable, nullable: false }], { meta: null }).ok,
    ).toBe(false);
    // A JSON column accepts any RFC 8259 value verbatim, including `false` and
    // `0` — no string parsing, no coercion.
    for (const value of [{ a: 1 }, [1, 2], "text", 3, true, false, 0]) {
      const parsed = normalizeApiRow([nullable], { meta: value });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.meta).toEqual(value);
    }
    // Absent required column → rejected; absent nullable → null; absent
    // defaulted → the pinned default.
    const required: DeclaredColumn = {
      name: "big",
      type: "int64",
      nullable: false,
    };
    const withDefault: DeclaredColumn = {
      name: "score",
      type: "float64",
      nullable: false,
      default: 0,
    };
    const optNullable: DeclaredColumn = {
      name: "note",
      type: "string",
      nullable: true,
    };
    expect(normalizeApiRow([required], {}).ok).toBe(false);
    const filled = normalizeApiRow([required, withDefault, optNullable], {
      big: "1",
    });
    expect(filled.ok).toBe(true);
    if (filled.ok)
      expect(filled.value).toEqual({ big: "1", score: 0, note: null });

    // The read adapter injects the pinned default for an absent historical
    // field (a projection returns NULL) and leaves nullable columns NULL.
    expect(
      applyDeclaredReadCompat([withDefault, optNullable], {
        score: null,
        note: null,
      }),
    ).toEqual({ score: 0, note: null });
  });

  it("no implicit primitive coercion", () => {
    const stringCol: DeclaredColumn = {
      name: "s",
      type: "string",
      nullable: false,
    };
    const intCol: DeclaredColumn = {
      name: "i",
      type: "int64",
      nullable: false,
    };
    const floatCol: DeclaredColumn = {
      name: "f",
      type: "float64",
      nullable: false,
    };
    const boolCol: DeclaredColumn = {
      name: "b",
      type: "boolean",
      nullable: false,
    };
    const tsCol: DeclaredColumn = {
      name: "t",
      type: "timestamp",
      nullable: false,
    };
    const bytesCol: DeclaredColumn = {
      name: "y",
      type: "bytes",
      nullable: false,
    };
    const reject = (column: DeclaredColumn, value: unknown) =>
      expect(() => normalizeDeclaredValue(column, value)).toThrow(ApiError);

    reject(stringCol, 1); // number → string
    reject(stringCol, true);
    reject(stringCol, { a: 1 });
    reject(intCol, 1); // number → int64 (precision)
    reject(intCol, true);
    reject(intCol, "1.0");
    reject(floatCol, "1.5"); // string numeral → float64
    reject(floatCol, Number.NaN);
    reject(floatCol, Number.POSITIVE_INFINITY);
    reject(boolCol, "true"); // string → boolean
    reject(boolCol, 1);
    reject(boolCol, 0);
    reject(tsCol, 1767323045); // numeric epoch → timestamp
    reject(bytesCol, Buffer.from([0, 1, 2]));
    reject(bytesCol, "AAEC");
    // Undeclared properties never pass through.
    expect(normalizeApiRow([intCol], { i: "1", extra: true }).ok).toBe(false);
  });
});
