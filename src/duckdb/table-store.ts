/**
 * Generic table→REST query layer (DB-SUPA-3)
 *
 * Everything SQL-shaped for /api/ns/:ns/tables/:table lives here so the
 * route module stays request/response-shaped. Two ground rules:
 *
 * 1. DECLARED SCHEMA ONLY. Column names come from the registry
 *    declaration (src/schema/table-registry.ts) and are re-checked at
 *    every use; identifier positions in SQL are emitted via
 *    quoteIdentifier() (double-quote escaping). User VALUES never
 *    touch SQL text — they ride as `?` placeholders through DuckDB
 *    prepared statements.
 *
 * 2. NO BARE AUTO-INTROSPECTION. Table data is read with explicit
 *    read_json(..., columns={...}, auto_detect=false) built from the
 *    declaration — never read_json_auto over arbitrary file lists
 *    (the DOGFOOD-010/018/019 SIGABRT crash class).
 *
 * Storage reality (v1): the JSONL files behind a table are a small-file
 * append log. PATCH/DELETE rewrite whole matching files (update =
 * replace the row, delete = drop the row); inserts APPEND to the
 * newest file — rows are never mutated in place mid-file, so older
 * snapshot files stay untouched history. This is an append-log store,
 * not a WAL — a general query-rewrite engine is explicitly out of
 * scope.
 */

import fs from "fs";
import path from "path";
import { Database } from "duckdb";
import type {
  TableDeclaration,
  TableColumn,
} from "../schema/table-registry.js";
import { deepConvertBigInts } from "../utils/serialize.js";
import { ApiError } from "../http/middleware/errorHandler.js";
import {
  applyDeclaredReadCompat,
  declaredReadType,
  normalizeApiRow,
  type DeclaredColumn,
} from "../serialization/schemaTypes.js";

// ---------------------------------------------------------------------------
// SQL text helpers
// ---------------------------------------------------------------------------

/**
 * Escape an identifier for embedding at an identifier position in SQL.
 * ONLY called with names already validated against the registry
 * declaration — this is the second layer of the injection defense; the
 * first is validateFilterColumns()/declared-column checks.
 */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** DuckDB type name for a declared column (identity map over the allowlist). */
function duckType(type: TableColumn["type"]): string {
  return type;
}

/**
 * Read type for one column. A DB-SUPA-6 declared column reads as its canonical
 * representation (`int64` / `timestamp` / `bytes` read as VARCHAR so the exact
 * stored text survives the JavaScript boundary); a legacy column keeps its
 * DuckDB type unchanged.
 */
function readType(col: TableColumn): string {
  return col.declaredType
    ? declaredReadType({
        name: col.name,
        type: col.declaredType,
        nullable: col.nullable ?? true,
      })
    : duckType(col.type);
}

/**
 * The DB-SUPA-6 declared column contract of a declaration, or `null` for a
 * legacy `tables/<table>.table.json` declaration.
 */
export function declaredColumnsOf(
  declaration: TableDeclaration,
): DeclaredColumn[] | null {
  if (declaration.source !== "schema.json") return null;
  if (declaration.columns.some((column) => column.declaredType === undefined))
    return null;
  return declaration.columns.map((column) => ({
    name: column.name,
    type: column.declaredType!,
    nullable: column.nullable ?? true,
    ...(column.hasDefault ? { default: column.default } : {}),
  }));
}

/** The explicit read_json columns spec for a declared table. */
export function readJsonColumnsSpec(declaration: TableDeclaration): string {
  const parts = declaration.columns.map(
    (col) => `${quoteIdentifier(col.name)}:'${readType(col)}'`,
  );
  return `columns={${parts.join(",")}}, auto_detect=false`;
}

// ---------------------------------------------------------------------------
// File discovery + row IO (read path, insert append, rewrite path)
// ---------------------------------------------------------------------------

interface DiscoveredFile {
  absPath: string;
  /** Path as it appears in SQL single quotes (forward slashes). */
  sqlPath: string;
}

/**
 * Resolve a declared table's glob to the concrete JSONL files that exist
 * right now. A glob that matches nothing is valid (empty table) — SELECT
 * over zero files returns zero rows without touching DuckDB.
 *
 * Supports the two glob shapes declared tables use: an exact relative
 * path and a trailing `*` / `**` wildcard segment (a tiny, auditable
 * matcher — no third-party glob dependency).
 */
export function resolveTableFiles(
  nsDir: string,
  declaration: TableDeclaration,
): DiscoveredFile[] {
  const pattern = declaration.glob;
  const parts = pattern.split("/").filter((p) => p.length > 0);
  const files: DiscoveredFile[] = [];

  const hasWildcard = parts.some((p) => p.includes("*") || p.includes("?"));
  if (!hasWildcard) {
    const abs = path.resolve(nsDir, pattern);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      files.push({ absPath: abs, sqlPath: abs.replace(/\\/g, "/") });
    }
    return files;
  }

  const walk = (dir: string, idx: number): void => {
    if (idx === parts.length) return;
    const part = parts[idx]!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const last = idx === parts.length - 1;
    for (const ent of entries) {
      if (ent.name.startsWith(".")) continue;
      if (part === "**") {
        // `**` matches zero or more directories — recurse without consuming.
        walk(path.join(dir, ent.name), idx);
        if (!ent.isDirectory()) continue;
        walk(path.join(dir, ent.name), idx + 1);
        continue;
      }
      const regex = new RegExp(
        `^${part
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".")}$`,
      );
      if (!regex.test(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (last) {
        if (ent.isFile()) {
          const abs = path.resolve(full);
          files.push({ absPath: abs, sqlPath: abs.replace(/\\/g, "/") });
        }
      } else if (ent.isDirectory()) {
        walk(full, idx + 1);
      }
    }
  };
  walk(nsDir, 0);
  files.sort((a, b) => a.absPath.localeCompare(b.absPath));
  return files;
}

function appendJsonlRows(absPath: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.appendFileSync(absPath, lines.join("\n") + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// SELECT
// ---------------------------------------------------------------------------

/** The comparison operators a filter value may use (PostgREST conventions). */
export const FILTER_OPS = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "in",
] as const;

export type FilterOp = (typeof FILTER_OPS)[number];

function castPlaceholder(col: TableColumn): string {
  return `?::${duckType(col.type)}`;
}

/**
 * Parse one PostgREST-style filter value ("eq.5", "in.(a,b,c)") into an
 * op + operand string, with PostgREST parenthesized-value unescaping.
 */
function parseFilterValue(raw: string): { op: FilterOp; operand: string } {
  const dot = raw.indexOf(".");
  if (dot === -1) {
    // Bare value: PostgREST treats a value without an op prefix as eq.
    return { op: "eq", operand: raw };
  }
  const op = raw.slice(0, dot);
  const operand = raw.slice(dot + 1);
  if (!FILTER_OPS.includes(op as FilterOp)) {
    throw new ApiError(
      `Unknown filter operator '${op}' (allowed: ${FILTER_OPS.join(", ")})`,
      400,
      "VALIDATION_ERROR",
    );
  }
  return { op: op as FilterOp, operand };
}

function sqlComparison(col: TableColumn, op: FilterOp): string {
  const id = quoteIdentifier(col.name);
  const ph = castPlaceholder(col);
  switch (op) {
    case "eq":
      return `${id} = ${ph}`;
    case "ne":
      return `${id} != ${ph}`;
    case "gt":
      return `${id} > ${ph}`;
    case "gte":
      return `${id} >= ${ph}`;
    case "lt":
      return `${id} < ${ph}`;
    case "lte":
      return `${id} <= ${ph}`;
    case "like":
      return `${id} LIKE ${ph}`;
    case "in": {
      // in.(a,b,c) → one placeholder per element, NULL excluded from SQL IN
      // (DuckDB IN (…, NULL) would kill equality for the whole list; the
      // COALESCE-free form below drops NULLs, matching PostgREST).
      return `${id} IN (${ph})`;
    }
  }
}

export interface SelectPlan {
  sql: string;
  params: unknown[];
  limit: number;
  offset: number;
  wantCount: boolean;
}

export interface SelectOptions {
  filters?: Record<string, string | string[]>;
  order?: string | string[];
  limit?: unknown;
  offset?: unknown;
  wantCount?: boolean;
}

const DEFAULT_LIMIT = 100;
const HARD_LIMIT_CAP = 1000;

function parseLimitOffset(opts: SelectOptions): {
  limit: number;
  offset: number;
} {
  let limit = DEFAULT_LIMIT;
  if (opts.limit !== undefined) {
    const n = Number(opts.limit);
    if (!Number.isInteger(n) || n < 0) {
      throw new ApiError(
        "limit must be a non-negative integer",
        400,
        "VALIDATION_ERROR",
      );
    }
    // Above the hard cap CLAMPS (no error) — PostgREST cap semantics.
    limit = Math.min(n, HARD_LIMIT_CAP);
  }
  let offset = 0;
  if (opts.offset !== undefined) {
    const n = Number(opts.offset);
    if (!Number.isInteger(n) || n < 0) {
      throw new ApiError(
        "offset must be a non-negative integer",
        400,
        "VALIDATION_ERROR",
      );
    }
    offset = n;
  }
  return { limit, offset };
}

/**
 * Build the SELECT plan for a table GET: validated filters, validated
 * order, clamped limit/offset. Every value position is a `?`; every
 * identifier position is declared-schema-sourced.
 */
export function buildSelectPlan(
  declaration: TableDeclaration,
  opts: SelectOptions,
): SelectPlan {
  const { limit, offset } = parseLimitOffset(opts);
  const params: unknown[] = [];
  const whereParts: string[] = [];

  const filters = opts.filters ?? {};
  for (const [rawKey, rawValue] of Object.entries(filters)) {
    // Reserved params that are not column filters.
    if (
      rawKey === "order" ||
      rawKey === "limit" ||
      rawKey === "offset" ||
      rawKey === "count"
    ) {
      continue;
    }
    const col = declaration.columns.find((c) => c.name === rawKey);
    if (!col) {
      throw new ApiError(
        `Unknown filter column '${rawKey}' (table '${declaration.name}' declares: ${declaration.columns.map((c) => c.name).join(", ")})`,
        400,
        "VALIDATION_ERROR",
      );
    }
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      const { op, operand } = parseFilterValue(String(value));
      if (op === "in") {
        if (!operand.startsWith("(") || !operand.endsWith(")")) {
          throw new ApiError(
            `in. filter requires a parenthesized value list: in.(a,b,c)`,
            400,
            "VALIDATION_ERROR",
          );
        }
        const items = operand
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .map((s) => unquoteFilterItem(s));
        if (items.length === 0) {
          throw new ApiError(
            "in. filter requires at least one value",
            400,
            "VALIDATION_ERROR",
          );
        }
        // NULLs in an IN list would poison SQL equality semantics — drop them.
        const nonNull = items.filter((v) => v !== null);
        const placeholders = nonNull
          .map(() => `?::${duckType(col.type)}`)
          .join(", ");
        params.push(...nonNull);
        whereParts.push(
          `${quoteIdentifier(col.name)} IN (${placeholders.length > 0 ? placeholders : "NULL"})`,
        );
      } else {
        params.push(
          operand === "null" || operand === ""
            ? null
            : coercePrimitiveOperand(operand, col.type),
        );
        whereParts.push(sqlComparison(col, op));
      }
    }
  }

  // ORDER BY — validated identifiers + fixed ASC/DESC tokens only.
  const orderParts: string[] = [];
  const orderSpec = opts.order;
  if (orderSpec !== undefined) {
    const entries = Array.isArray(orderSpec) ? orderSpec : [orderSpec];
    for (const entry of entries) {
      for (const part of String(entry).split(",")) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const m = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\.(asc|desc)$/);
        if (!m) {
          throw new ApiError(
            `Invalid order clause '${trimmed}' (expected col.asc or col.desc)`,
            400,
            "VALIDATION_ERROR",
          );
        }
        const colName = m[1]!;
        const dir = m[2]!;
        if (!declaration.columns.some((c) => c.name === colName)) {
          throw new ApiError(
            `Unknown order column '${colName}' (table '${declaration.name}' declares: ${declaration.columns.map((c) => c.name).join(", ")})`,
            400,
            "VALIDATION_ERROR",
          );
        }
        orderParts.push(`${quoteIdentifier(colName)} ${dir.toUpperCase()}`);
      }
    }
  }

  const columnsSql = declaration.columns
    .map((c) => selectProjection(c))
    .join(", ");
  // The FROM clause is injected at EXECUTION time (executeSelectPlan) from
  // the files the glob resolves to in that request — plan construction stays
  // filesystem-free and safe for the list route's hot path.
  const fileSql = READ_SOURCE_SENTINEL;
  const whereSql =
    whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";
  const orderSql =
    orderParts.length > 0 ? `ORDER BY ${orderParts.join(", ")}` : "";
  const countSql = `SELECT count(*)::BIGINT AS __total_count FROM ${fileSql} ${whereSql}`;
  const rowsSql =
    `SELECT ${columnsSql} FROM ${fileSql} ${whereSql} ${orderSql} LIMIT ? OFFSET ?`
      .replace(/\s+/g, " ")
      .trim();

  return {
    sql: rowsSql,
    params: [...params, limit, offset],
    limit,
    offset,
    wantCount: opts.wantCount === true,
    countSql,
    countParams: [...params],
  } as SelectPlan & { countSql: string; countParams: unknown[] };
}

/** Unquote a PostgREST in.(...) item (double-quoted values may contain commas). */
function unquoteFilterItem(item: string): string | null {
  if (item.length >= 2 && item.startsWith('"') && item.endsWith('"')) {
    return item.slice(1, -1);
  }
  return item;
}

/** Boolean/text coercion for bare (untyped-by-URL) filter operands. */
function coercePrimitiveOperand(
  operand: string,
  type: TableColumn["type"],
): unknown {
  if (type === "boolean") {
    if (operand === "true") return true;
    if (operand === "false") return false;
  }
  return operand;
}

/** Projection for one declared column (JSON columns come back as text). */
function selectProjection(col: TableColumn): string {
  const id = quoteIdentifier(col.name);
  if (col.type === "json") {
    // The column is already JSON — plain VARCHAR cast yields the exact
    // stored text (to_json would re-encode it as a JSON string).
    return `CASE WHEN ${id} IS NULL THEN NULL ELSE CAST(${id} AS VARCHAR) END AS ${id}`;
  }
  return id;
}

/** The FROM placeholder replaced with the real read_json(...) at execution. */
const READ_SOURCE_SENTINEL = "__TABLE_SOURCE__";

// ---------------------------------------------------------------------------
// DuckDB execution
// ---------------------------------------------------------------------------

function allAsync(
  db: Database,
  sql: string,
  params: unknown[],
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare(sql);
    stmt.all(...params, (err: Error | null, result: unknown) => {
      if (err) reject(err);
      else resolve((result as Record<string, unknown>[]) ?? []);
    });
  });
}

/** Fresh in-memory DuckDB per request-read (singleton-connection crash history). */
async function withTemporaryDb<T>(
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  const db = new Database(":memory:");
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

export interface SelectResult {
  rows: Record<string, unknown>[];
  totalCount: number | null;
}

/**
 * Execute a SELECT plan on a fresh in-memory DuckDB.
 * `nsDir` locates the table's files for the read_sql's FROM clause.
 */
export async function executeSelectPlan(
  nsDir: string,
  declaration: TableDeclaration,
  plan: SelectPlan,
): Promise<SelectResult> {
  const files = resolveTableFiles(nsDir, declaration);
  const declared = declaredColumnsOf(declaration);
  const { countSql, countParams } = plan as SelectPlan & {
    countSql: string;
    countParams: unknown[];
  };

  return withTemporaryDb(async (db) => {
    let totalCount: number | null = null;
    if (plan.wantCount) {
      if (files.length === 0) {
        totalCount = 0;
      } else {
        const countRead = buildReadSqlForFiles(files, declaration);
        const sql = countSql.replace(READ_SOURCE_SENTINEL, () => countRead);
        const rows = await allAsync(db, sql, countParams);
        totalCount = Number(rows[0]?.__total_count ?? 0);
      }
    }

    if (files.length === 0) return { rows: [], totalCount };
    const readSql = buildReadSqlForFiles(files, declaration);
    const rows = await allAsync(
      db,
      plan.sql.replace(READ_SOURCE_SENTINEL, () => readSql),
      plan.params,
    );
    return {
      rows: rows.map((r) => {
        const row = deepConvertBigInts(r) as Record<string, unknown>;
        // DB-SUPA-6 compatibility adapter: an absent historical field on a
        // defaulted column reads as its pinned default (never a coercion).
        return declared ? applyDeclaredReadCompat(declared, row) : row;
      }),
      totalCount,
    };
  });
}

/**
 * FROM-clause read_sql for an explicit file list.
 *
 * jsonl-objects → read_json with the DECLARED columns spec, built from the
 * declared types (`auto_detect=false`; the DOGFOOD-010/018/019 SIGABRT class
 * comes from bare auto-inference, so heterogeneous data is handled by declared
 * types + ignore_errors instead).
 *
 * jsonl-positional → each line is a JSON ARRAY. The single column is read as
 * JSON (`columns={'json':'JSON'}, auto_detect=false`) — no auto-detection —
 * and every declared column is projected from its declared ordinal, so the
 * positional HEADER comes from the declaration and never from a data line.
 * Casts are explicit (`try_cast`) per declared type.
 */
export function buildReadSqlForFiles(
  files: DiscoveredFile[],
  declaration: TableDeclaration,
): string {
  const fileList = files.map((f) => `'${f.sqlPath}'`).join(", ");
  if (declaration.format === "jsonl-positional") {
    const projections = declaration.columns
      .map((col, idx) => {
        const id = quoteIdentifier(col.name);
        const element =
          col.declaredType === "json" ||
          (col.declaredType === undefined && col.type === "json")
            ? `json_extract_string(json[${idx}], '$')`
            : `try_cast(json_extract_string(json[${idx}], '$') AS ${readType(col)})`;
        return `${element} AS ${id}`;
      })
      .join(", ");
    return `(SELECT ${projections} FROM read_json([${fileList}], format='newline_delimited', ignore_errors=true, columns={'json':'JSON'}, auto_detect=false))`;
  }
  return `read_json([${fileList}], format='newline_delimited', ignore_errors=true, ${readJsonColumnsSpec(declaration)})`;
}

// ---------------------------------------------------------------------------
// INSERT
// ---------------------------------------------------------------------------

/**
 * Coerce + validate one incoming row against the declaration.
 *
 * For a DB-SUPA-6 `schema.json` declaration the declared types govern and
 * nothing is coerced: `int64` must arrive as a canonical decimal string,
 * timestamps in ISO-8601 with an offset (normalized to canonical UTC),
 * `bytes` with the `base64url:` envelope, `float64` as a finite JSON number,
 * `json` verbatim. Absent values resolve through the pinned null/default
 * compatibility adapter. Legacy declarations keep their historical coercion
 * rules unchanged.
 */
export function coerceRowAgainstDeclaration(
  declaration: TableDeclaration,
  row: unknown,
): Record<string, unknown> {
  const declared = declaredColumnsOf(declaration);
  if (declared) {
    const result = normalizeApiRow(declared, row);
    if (!result.ok)
      throw new ApiError(
        `${result.issues.message} (table '${declaration.name}')`,
        result.issues.status,
        result.issues.code,
      );
    return result.value;
  }
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new ApiError(
      "Each row must be a JSON object",
      422,
      "UNPROCESSABLE_ENTITY",
    );
  }
  const raw = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const col of declaration.columns) {
    const value = raw[col.name];
    if (value === undefined) {
      out[col.name] = null;
      continue;
    }
    out[col.name] = coerceCell(col, value, declaration);
  }
  const unknownKeys = Object.keys(raw).filter(
    (k) => !declaration.columns.some((c) => c.name === k),
  );
  if (unknownKeys.length > 0) {
    throw new ApiError(
      `Unknown column(s) in insert: ${unknownKeys.join(", ")} (table '${declaration.name}' declares: ${declaration.columns.map((c) => c.name).join(", ")})`,
      400,
      "VALIDATION_ERROR",
    );
  }
  return out;
}

function coerceCell(
  col: TableColumn,
  value: unknown,
  declaration: TableDeclaration,
): unknown {
  switch (col.type) {
    case "varchar":
      if (typeof value !== "string") {
        throw typeMismatch(col, value, declaration, "a string");
      }
      return value;
    case "integer":
    case "bigint": {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw typeMismatch(col, value, declaration, "an integer number");
      }
      return value;
    }
    case "double": {
      if (typeof value !== "number" || Number.isNaN(value)) {
        throw typeMismatch(col, value, declaration, "a number");
      }
      return value;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        throw typeMismatch(col, value, declaration, "a boolean");
      }
      return value;
    }
    case "timestamp": {
      if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
        throw typeMismatch(
          col,
          value,
          declaration,
          "an ISO-8601 timestamp string",
        );
      }
      return value;
    }
    case "json": {
      // Keep the raw JSON VALUE (object/array/primitive) — the row is
      // serialized once at append time, so the file holds a proper nested
      // JSON literal, not a double-encoded string.
      return value;
    }
  }
}

function typeMismatch(
  col: TableColumn,
  value: unknown,
  declaration: TableDeclaration,
  expected: string,
): ApiError {
  return new ApiError(
    `Column '${col.name}' (${col.type}) requires ${expected}, got ${JSON.stringify(value)} in table '${declaration.name}'`,
    422,
    "UNPROCESSABLE_ENTITY",
  );
}

/**
 * Append one or more validated rows to the table's NEWEST matching file
 * (created when none exists — `glob`'s directory + basename pattern are
 * derived by replacing the wildcard segments with the table name).
 * jsonl-positional rows are stored as JSON arrays in declared column
 * order (the routing-namespace storage shape).
 */
export function appendRowsToTable(
  nsDir: string,
  declaration: TableDeclaration,
  rows: Record<string, unknown>[],
): number {
  const files = resolveTableFiles(nsDir, declaration);
  const target =
    files.length > 0
      ? files[files.length - 1]!.absPath
      : deriveSyntheticFilePath(nsDir, declaration);
  const lines = rows.map((row) =>
    declaration.format === "jsonl-positional"
      ? JSON.stringify(declaration.columns.map((c) => row[c.name] ?? null))
      : JSON.stringify(row),
  );
  appendJsonlRows(target, lines);
  return rows.length;
}

/** Newest file = append target: the LAST file in the resolved (sorted) list. */
function deriveSyntheticFilePath(
  nsDir: string,
  declaration: TableDeclaration,
): string {
  const parts = declaration.glob.split("/").filter((p) => p.length > 0);
  const resolved = parts.map((part) =>
    part.includes("*") || part.includes("?")
      ? `${declaration.name}.jsonl`
      : part,
  );
  return path.resolve(nsDir, ...resolved);
}

// ---------------------------------------------------------------------------
// PATCH / DELETE (read-modify-write over the append-log files)
// ---------------------------------------------------------------------------

export interface MutationOutcome {
  /** Rows updated or deleted across all matching files. */
  mutated: number;
  /** Inserted rows (PATCH with no matching row on a pk table upserts). */
  inserted: number;
}

/**
 * Shared read-modify-write core for PATCH/DELETE. `op` decides the
 * predicate semantics: "delete" keeps non-matching rows; "patch" replaces
 * matching rows with the merged object (or drops them when the merge is
 * null — an upsert-avoiding no-op only when `upsert` is false and nothing
 * matched, in which case `inserted` counts the appended row).
 */
function rewriteWithPredicate(
  nsDir: string,
  declaration: TableDeclaration,
  matches: (row: Record<string, unknown>) => boolean,
  op: "patch" | "delete",
  patchMerge?: (row: Record<string, unknown>) => Record<string, unknown> | null,
  upsert?: boolean,
): MutationOutcome {
  const files = resolveTableFiles(nsDir, declaration);
  let mutated = 0;
  for (const file of files) {
    const lines = fs.readFileSync(file.absPath, "utf-8").split("\n");
    const out: string[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        out.push(line);
        continue;
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        out.push(line);
        continue;
      }
      const obj = parsed as Record<string, unknown>;
      if (!matches(obj)) {
        out.push(line);
        continue;
      }
      if (op === "delete") {
        mutated += 1; // row dropped — write nothing
        continue;
      }
      const merged = patchMerge!(obj);
      if (merged === null) {
        mutated += 1; // merge declined — row dropped (unreachable for current callers)
        continue;
      }
      out.push(
        declaration.format === "jsonl-positional"
          ? JSON.stringify(
              declaration.columns.map((c) => merged[c.name] ?? null),
            )
          : JSON.stringify(merged),
      );
      mutated += 1;
    }
    const tmp = file.absPath + ".tmp-rewrite";
    fs.writeFileSync(tmp, out.length > 0 ? out.join("\n") + "\n" : "", "utf-8");
    fs.renameSync(tmp, file.absPath);
  }
  let inserted = 0;
  if (op === "patch" && mutated === 0 && upsert === true) {
    // No row matched: append the patch as a new row (PostgREST upsert
    // semantics are NOT used by default — routes decide).
    const body = patchMerge?.({}) ?? {};
    appendRowsToTable(nsDir, declaration, [body]);
    inserted = 1;
  }
  return { mutated, inserted };
}

/**
 * PATCH by declared primary key. `pkValue` is the raw operand string from
 * the `pk=eq.<v>` filter. Updates rewrite every matching row in every
 * matching file; when nothing matched and the caller passes `upsertBody`,
 * the body is appended as a new row instead.
 */
export function patchRowsByPk(
  nsDir: string,
  declaration: TableDeclaration,
  pkCol: TableColumn,
  pkValue: string,
  body: Record<string, unknown>,
  opts: { upsertBody?: Record<string, unknown> } = {},
): MutationOutcome {
  const cmp = pkCompareValue(pkCol, pkValue);
  const outcome = rewriteWithPredicate(
    nsDir,
    declaration,
    (row) => cmp(row[pkCol.name]),
    "patch",
    (row) => {
      const merged: Record<string, unknown> = { ...row, ...body };
      return merged;
    },
    opts.upsertBody !== undefined,
  );
  if (outcome.mutated === 0 && opts.upsertBody !== undefined) {
    appendRowsToTable(nsDir, declaration, [
      coerceRowAgainstDeclaration(declaration, opts.upsertBody),
    ]);
    outcome.inserted = 1;
  }
  return outcome;
}

/**
 * DELETE by declared primary key. Returns the number of rows removed.
 */
export function deleteRowsByPk(
  nsDir: string,
  declaration: TableDeclaration,
  pkCol: TableColumn,
  pkValue: string,
): number {
  const cmp = pkCompareValue(pkCol, pkValue);
  const outcome = rewriteWithPredicate(
    nsDir,
    declaration,
    (row) => cmp(row[pkCol.name]),
    "delete",
  );
  return outcome.mutated;
}

/** Build an in-memory row-value comparator for a pk operand string. */
function pkCompareValue(
  col: TableColumn,
  operand: string,
): (cell: unknown) => boolean {
  const decoded =
    operand === "null" || operand === ""
      ? null
      : coercePrimitiveOperand(operand, col.type);
  return (cell: unknown) => {
    if (cell === null || cell === undefined) return decoded === null;
    return String(cell) === String(decoded);
  };
}
