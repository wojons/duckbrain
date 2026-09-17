/**
 * DB-SUPA-6 — declared v1 type representation (`docs/specs/SUPA-6-ddl.md`).
 *
 * One module owns the exact meaning of every declared type so DDL validation,
 * the serializer's Zod seam, the generic table store and the REST layer can
 * never disagree:
 *
 *   declared type | JSONL + API representation            | read column type
 *   string        | JSON string                           | VARCHAR
 *   int64         | canonical base-10 JSON STRING         | VARCHAR (exact text)
 *   float64       | JSON number (finite)                  | DOUBLE
 *   boolean       | JSON true/false                       | BOOLEAN
 *   timestamp     | canonical UTC `YYYY-MM-DDTHH:mm:ss.sssZ` | VARCHAR (exact text)
 *   json          | any RFC 8259 value                    | JSON
 *   bytes         | `base64url:<unpadded-url-safe-base64>`| VARCHAR (exact text)
 *
 * `int64`, `timestamp` and `bytes` are stored and read as their canonical
 * STRING form: nothing is ever coerced through a JavaScript `number`, so a
 * value at the edge of the signed 64-bit range round-trips exactly. There is
 * no implicit coercion in this module — every wrong-typed or noncanonical
 * input is rejected, never repaired (except the two documented canonical
 * normalizations: `-0` → `0` for float64 and int64 `-0` → `0`).
 */

import { ApiError } from "../http/middleware/errorHandler.js";

/** Every declared v1 column type, in the spec's order. */
export const DECLARED_TYPES = [
  "string",
  "int64",
  "float64",
  "boolean",
  "timestamp",
  "json",
  "bytes",
] as const;

export type DeclaredColumnType = (typeof DECLARED_TYPES)[number];

/** Physical row shapes a declared table may use. */
export const ROW_SHAPES = ["object", "positional"] as const;
export type RowShape = (typeof ROW_SHAPES)[number];

/** Names that can never be declared as a table or view. */
export const RESERVED_RESOURCE_NAMES = [
  "_audit",
  "schema",
  "manifest",
  "memories",
] as const;

/** `^[a-z][a-z0-9_]{0,62}$` — case-sensitive, URL-safe, ≤63 chars. */
export const RESOURCE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

/** Column identifiers share SUPA-3's identifier rule. */
export const COLUMN_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Canonical base-10 int64 text: no leading `+`, no leading zeroes, no exponent. */
export const INT64_PATTERN = /^-?(0|[1-9][0-9]*)$/;

export const INT64_MIN = -9223372036854775808n;
export const INT64_MAX = 9223372036854775807n;

/** An instant string WITH an offset — never date-only, never local-time. */
export const TIMESTAMP_INPUT_PATTERN =
  /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|z|[+-]\d{2}:?\d{2})$/;

/** Canonical UTC millisecond form. */
export const TIMESTAMP_CANONICAL_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const BYTES_PREFIX = "base64url:";

export interface DeclaredColumn {
  name: string;
  type: DeclaredColumnType;
  nullable: boolean;
  /**
   * JSON-literal default. `undefined` means "no default declared" — JSON
   * cannot carry `undefined`, so an explicit `null` default stays distinct.
   */
  default?: unknown;
}

export function isDeclaredColumnType(
  value: unknown,
): value is DeclaredColumnType {
  return (
    typeof value === "string" &&
    (DECLARED_TYPES as readonly string[]).includes(value)
  );
}

export function isRowShape(value: unknown): value is RowShape {
  return (
    typeof value === "string" &&
    (ROW_SHAPES as readonly string[]).includes(value)
  );
}

export function columnHasDefault(column: DeclaredColumn): boolean {
  return column.default !== undefined;
}

export function isReservedResourceName(name: string): boolean {
  return (RESERVED_RESOURCE_NAMES as readonly string[]).includes(name);
}

/** Key columns may not be nullable, `json`, or `bytes` (spec: key semantics). */
export function keyColumnProblem(column: DeclaredColumn): string | null {
  if (column.nullable) return "key column must be non-nullable";
  if (column.type === "json" || column.type === "bytes")
    return `key column type '${column.type}' is not addressable`;
  return null;
}

// ---------------------------------------------------------------------------
// Canonical value validation / normalization
// ---------------------------------------------------------------------------

/** A value rejection carries the exact canonical rule that was violated. */
export function valueError(column: DeclaredColumn, message: string): ApiError {
  return new ApiError(
    `Column '${column.name}' (${column.type}): ${message}`,
    422,
    "UNPROCESSABLE_ENTITY",
  );
}

function int64TextProblem(value: string): string | null {
  if (!INT64_PATTERN.test(value))
    return `expected a canonical base-10 int64 string (no '+', no leading zeroes, no exponent), got ${JSON.stringify(value)}`;
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    return `value ${JSON.stringify(value)} is not a base-10 integer`;
  }
  if (parsed < INT64_MIN || parsed > INT64_MAX)
    return `value ${value} is outside the signed 64-bit range`;
  return null;
}

function bytesProblem(value: string): string | null {
  if (!value.startsWith(BYTES_PREFIX))
    return `expected the '${BYTES_PREFIX}' envelope, got ${JSON.stringify(value)}`;
  const body = value.slice(BYTES_PREFIX.length);
  if (body.length === 0) return "empty base64url payload";
  if (!/^[A-Za-z0-9_-]+$/.test(body))
    return `expected unpadded URL-safe base64 (no '+', '/', '=' or whitespace), got ${JSON.stringify(body)}`;
  const decoded = Buffer.from(body, "base64url");
  if (decoded.toString("base64url") !== body)
    return `payload ${JSON.stringify(body)} does not decode as unpadded base64url`;
  return null;
}

function timestampProblem(value: string): string | null {
  if (!TIMESTAMP_INPUT_PATTERN.test(value))
    return `expected an ISO-8601/RFC 3339 instant WITH a UTC offset (no date-only, no local time), got ${JSON.stringify(value)}`;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || Number.isNaN(ms))
    return `value ${JSON.stringify(value)} is not a real instant`;
  return null;
}

/**
 * Validate one value against a declared type. Returns the canonical value on
 * success and throws an `ApiError(422 UNPROCESSABLE_ENTITY)` naming the rule
 * that was violated. Never coerces across JSON kinds.
 */
export function normalizeDeclaredValue(
  column: DeclaredColumn,
  value: unknown,
): unknown {
  switch (column.type) {
    case "string":
      if (typeof value !== "string")
        throw valueError(
          column,
          `expected a JSON string, got ${describe(value)}`,
        );
      return value;
    case "int64": {
      if (typeof value !== "string")
        throw valueError(
          column,
          `expected a canonical base-10 int64 STRING (JavaScript numbers are rejected so precision never crosses the safe-integer boundary), got ${describe(value)}`,
        );
      const problem = int64TextProblem(value);
      if (problem) throw valueError(column, problem);
      const parsed = BigInt(value);
      return parsed === 0n ? "0" : value;
    }
    case "float64": {
      if (typeof value !== "number")
        throw valueError(
          column,
          `expected a finite JSON number, got ${describe(value)}`,
        );
      if (!Number.isFinite(value))
        throw valueError(
          column,
          `expected a finite JSON number, got ${JSON.stringify(value)}`,
        );
      return value === 0 ? 0 : value; // -0 normalizes to 0 on write
    }
    case "boolean":
      if (typeof value !== "boolean")
        throw valueError(
          column,
          `expected JSON true or false, got ${describe(value)}`,
        );
      return value;
    case "timestamp": {
      if (typeof value !== "string")
        throw valueError(
          column,
          `expected an ISO-8601 instant string with an offset, got ${describe(value)}`,
        );
      const problem = timestampProblem(value);
      if (problem) throw valueError(column, problem);
      const ms = Date.parse(value);
      const iso = new Date(ms).toISOString();
      if (!TIMESTAMP_CANONICAL_PATTERN.test(iso))
        throw valueError(
          column,
          `value ${JSON.stringify(value)} is outside the representable range`,
        );
      return iso;
    }
    case "json": {
      if (value === undefined)
        throw valueError(column, "expected a JSON value, got undefined");
      if (typeof value === "number" && !Number.isFinite(value))
        throw valueError(
          column,
          `JSON cannot represent ${JSON.stringify(value)}`,
        );
      if (typeof value === "bigint" || typeof value === "function")
        throw valueError(
          column,
          `expected a JSON value, got ${describe(value)}`,
        );
      return value;
    }
    case "bytes": {
      if (typeof value !== "string")
        throw valueError(
          column,
          `expected a '${BYTES_PREFIX}<unpadded-base64url>' string, got ${describe(value)}`,
        );
      const problem = bytesProblem(value);
      if (problem) throw valueError(column, problem);
      return value;
    }
    default:
      throw valueError(column, `unsupported declared type`);
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

/**
 * A declared default must already BE the canonical representation (spec:
 * "Defaults use the identical representation"). `null` is allowed only for a
 * nullable column. Throws `ApiError(400 VALIDATION_ERROR)` — a bad default is
 * a malformed declaration, not a bad row.
 */
export function assertCanonicalDefault(column: DeclaredColumn): void {
  if (!columnHasDefault(column)) return;
  const bad = (message: string): never => {
    throw new ApiError(
      `Declared default for column '${column.name}' (${column.type}) ${message}`,
      400,
      "VALIDATION_ERROR",
    );
  };
  if (column.default === null) {
    if (!column.nullable)
      bad("is null, which is allowed only for nullable columns");
    return;
  }
  let normalized: unknown;
  try {
    normalized = normalizeDeclaredValue(column, column.default);
  } catch (error) {
    bad(
      `is not a valid ${column.type} literal: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!sameCanonicalValue(normalized, column.default))
    bad(
      `is not the canonical ${column.type} representation (canonical form: ${JSON.stringify(normalized)})`,
    );
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  if (typeof left === "number" && typeof right === "number")
    return Object.is(left, right);
  return JSON.stringify(left) === JSON.stringify(right);
}

// ---------------------------------------------------------------------------
// Row assembly (API row ↔ canonical JSONL line)
// ---------------------------------------------------------------------------

export interface RowIssues {
  /** Field → message, for the API error body. */
  fields: Record<string, string>;
  code: "VALIDATION_ERROR" | "UNPROCESSABLE_ENTITY";
  status: number;
  message: string;
}

export type RowResult<T> =
  { ok: true; value: T } | { ok: false; issues: RowIssues };

function rowError(
  fields: Record<string, string>,
  code: RowIssues["code"],
  message: string,
  status: number,
): RowResult<never> {
  return { ok: false, issues: { fields, code, status, message } };
}

/**
 * Validate a caller-supplied API row (always an object) against the declared
 * columns and return the canonical API row.
 *
 * Absent values resolve through the pinned compatibility adapter:
 *   - declared default → the default (materialized on write)
 *   - nullable without default → `null`
 *   - neither → rejected (a new non-nullable write requires the column)
 */
export function normalizeApiRow(
  columns: readonly DeclaredColumn[],
  row: unknown,
): RowResult<Record<string, unknown>> {
  if (typeof row !== "object" || row === null || Array.isArray(row))
    return rowError(
      { general: "each row must be a JSON object" },
      "VALIDATION_ERROR",
      "Each row must be a JSON object",
      400,
    );
  const raw = row as Record<string, unknown>;
  const declaredNames = new Set(columns.map((column) => column.name));
  const unknown = Object.keys(raw).filter((key) => !declaredNames.has(key));
  if (unknown.length > 0)
    return rowError(
      Object.fromEntries(unknown.map((key) => [key, "undeclared property"])),
      "VALIDATION_ERROR",
      `Unknown column(s): ${unknown.join(", ")} (declared: ${columns
        .map((column) => column.name)
        .join(", ")})`,
      400,
    );

  const out: Record<string, unknown> = {};
  const fields: Record<string, string> = {};
  let code: RowIssues["code"] = "VALIDATION_ERROR";
  let status = 400;
  for (const column of columns) {
    const present = Object.prototype.hasOwnProperty.call(raw, column.name);
    const value = raw[column.name];
    if (!present || value === undefined) {
      if (columnHasDefault(column)) {
        out[column.name] = column.default ?? null;
        continue;
      }
      if (column.nullable) {
        out[column.name] = null;
        continue;
      }
      fields[column.name] = "required column is missing";
      continue;
    }
    if (value === null) {
      if (!column.nullable) {
        fields[column.name] = "null is not allowed (nullable: false)";
        code = "UNPROCESSABLE_ENTITY";
        status = 422;
        continue;
      }
      out[column.name] = null;
      continue;
    }
    try {
      out[column.name] = normalizeDeclaredValue(column, value);
    } catch (error) {
      const api = error as ApiError;
      fields[column.name] = api.message ?? String(error);
      code = "UNPROCESSABLE_ENTITY";
      status = 422;
    }
  }
  if (Object.keys(fields).length > 0) {
    const first = Object.values(fields)[0]!;
    return rowError(fields, code, first, status);
  }
  return { ok: true, value: out };
}

/**
 * The compatibility read adapter: a value the projection returned as NULL
 * takes the declared default exactly when the column carries one, so an
 * absent historical field reads as its pinned default. A column without a
 * declared default keeps NULL, which is exactly the nullable column rule
 * ("absent → null"). Because a typed projection cannot tell "property absent"
 * from "property present as an explicit null", a defaulted column's stored
 * `null` also reads as the default: that is why DDL pins exactly one
 * compatibility policy per added column and why a defaulted column is
 * normally declared `nullable: false`.
 */
export function applyDeclaredReadCompat(
  columns: readonly DeclaredColumn[],
  row: Record<string, unknown>,
): Record<string, unknown> {
  for (const column of columns) {
    if (!columnHasDefault(column)) continue;
    if (row[column.name] === null) row[column.name] = column.default;
  }
  return row;
}

/** Convert a validated API row into the physical JSONL shape. */
export function storedRowFromApiRow(
  columns: readonly DeclaredColumn[],
  rowShape: RowShape,
  row: Record<string, unknown>,
): Record<string, unknown> | unknown[] {
  if (rowShape === "positional")
    return columns.map((column) => row[column.name] ?? null);
  const out: Record<string, unknown> = {};
  for (const column of columns) out[column.name] = row[column.name] ?? null;
  return out;
}

/** Convert a positional line into the object shape the API returns. */
export function apiRowFromStoredRow(
  columns: readonly DeclaredColumn[],
  stored: unknown,
): Record<string, unknown> {
  if (Array.isArray(stored)) {
    const out: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      out[column.name] = index < stored.length ? stored[index] : null;
    });
    return out;
  }
  const record =
    typeof stored === "object" && stored !== null
      ? (stored as Record<string, unknown>)
      : {};
  const out: Record<string, unknown> = {};
  for (const column of columns)
    out[column.name] = Object.prototype.hasOwnProperty.call(record, column.name)
      ? record[column.name]
      : null;
  return out;
}

/** Canonical JSONL line for a validated API row. */
export function jsonlLineForApiRow(
  columns: readonly DeclaredColumn[],
  rowShape: RowShape,
  row: Record<string, unknown>,
): string {
  return JSON.stringify(storedRowFromApiRow(columns, rowShape, row));
}

/** DuckDB type used when READING a declared column (exact canonical text). */
export function declaredReadType(column: DeclaredColumn): string {
  switch (column.type) {
    case "int64":
    case "timestamp":
    case "bytes":
    case "string":
      return "VARCHAR";
    case "float64":
      return "DOUBLE";
    case "boolean":
      return "BOOLEAN";
    case "json":
      return "JSON";
  }
}

/** SUPA-3 DuckDB column type for a declared v1 type (legacy declarations map 1:1). */
export function duckColumnTypeForDeclared(
  type: DeclaredColumnType,
): "varchar" | "bigint" | "double" | "boolean" | "timestamp" | "json" {
  switch (type) {
    case "string":
    case "bytes":
      return "varchar";
    case "int64":
      return "bigint";
    case "float64":
      return "double";
    case "boolean":
      return "boolean";
    case "timestamp":
      return "timestamp";
    case "json":
      return "json";
  }
}

/** Primary-key-shaped column when a table declares exactly one key column. */
export function singleKeyColumn(keyColumns: readonly string[]): string | null {
  return keyColumns.length === 1 ? keyColumns[0]! : null;
}
