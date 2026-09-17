/**
 * DB-SUPA-6 — `namespaces/<ns>/schema.json` v1 document contract.
 *
 * The schema file is a CLOSED-WORLD contract: unknown top-level keys and
 * unknown object fields are rejected, because a typo in a declaration must
 * fail loudly instead of silently degrading into a permissive schema. This
 * module owns parsing, the semantic rules (names, keys, paths, defaults) and
 * deterministic formatting; `schemaRegistry.ts` owns loading/caching and
 * `ddl.ts` owns mutation.
 *
 * Separation from `manifest.json` is absolute: this document carries only
 * logical declarations (tables, columns, keys, row shape, storage path,
 * views, versions). Partitions stay in the manifest, written by
 * `src/storage/manifest.ts`.
 */

import { z } from "zod";
import { ApiError } from "../http/middleware/errorHandler.js";
import {
  COLUMN_NAME_PATTERN,
  RESOURCE_NAME_PATTERN,
  ROW_SHAPES,
  assertCanonicalDefault,
  isDeclaredColumnType,
  isReservedResourceName,
  keyColumnProblem,
  type DeclaredColumn,
  type DeclaredColumnType,
  type RowShape,
} from "./schemaTypes.js";

export const SCHEMA_DOCUMENT_VERSION = 1;

export interface SchemaTable {
  /** Table version, incremented by every accepted evolution operation. */
  schemaVersion: number;
  storage: { path: string };
  rowShape: RowShape;
  keyColumns: string[];
  columns: DeclaredColumn[];
}

export interface SchemaView {
  schemaVersion: number;
  dependsOn: string[];
  query: string;
}

export interface SchemaDocument {
  schemaVersion: typeof SCHEMA_DOCUMENT_VERSION;
  tables: Record<string, SchemaTable>;
  views: Record<string, SchemaView>;
}

// ---------------------------------------------------------------------------
// Structural schema (closed world)
// ---------------------------------------------------------------------------

const ColumnSchema = z
  .object({
    name: z.string(),
    type: z.string(),
    nullable: z.boolean(),
    default: z.any().optional(),
  })
  .strict();

const TableSchema = z
  .object({
    schemaVersion: z.number(),
    storage: z.object({ path: z.string() }).strict(),
    rowShape: z.string(),
    keyColumns: z.array(z.string()),
    columns: z.array(ColumnSchema),
  })
  .strict();

const ViewSchema = z
  .object({
    schemaVersion: z.number(),
    dependsOn: z.array(z.string()),
    query: z.string(),
  })
  .strict();

const DocumentSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_DOCUMENT_VERSION),
    tables: z.record(z.string(), TableSchema).optional().default({}),
    views: z.record(z.string(), ViewSchema).optional().default({}),
  })
  .strict();

// ---------------------------------------------------------------------------
// Semantic validation
// ---------------------------------------------------------------------------

function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const at =
      issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
    return `${at}: ${issue.message}`;
  });
}

function storagePathProblem(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0)
    return "storage.path must be a non-empty string";
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value))
    return "storage.path must be relative to the namespace root";
  if (value.includes("\\")) return "storage.path must use '/' separators";
  if (!value.endsWith(".jsonl")) return "storage.path must end in '.jsonl'";
  const segments = value.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  )
    return "storage.path must not contain empty, '.', or '..' segments";
  return null;
}

function resourceNameProblem(kind: string, name: string): string | null {
  if (!RESOURCE_NAME_PATTERN.test(name))
    return `${kind} name '${name}' must match ${RESOURCE_NAME_PATTERN.source}`;
  if (isReservedResourceName(name)) return `${kind} name '${name}' is reserved`;
  return null;
}

function validateColumns(
  where: string,
  columns: readonly DeclaredColumn[],
  problems: string[],
): void {
  if (columns.length === 0) {
    problems.push(`${where}: columns must be a non-empty array`);
    return;
  }
  const seen = new Set<string>();
  for (const column of columns) {
    if (!COLUMN_NAME_PATTERN.test(column.name)) {
      problems.push(
        `${where}: column name ${JSON.stringify(column.name)} is not a valid identifier`,
      );
      continue;
    }
    if (seen.has(column.name)) {
      problems.push(`${where}: duplicate column '${column.name}'`);
      continue;
    }
    seen.add(column.name);
    if (!isDeclaredColumnType(column.type)) {
      problems.push(
        `${where}.${column.name}: unsupported type ${JSON.stringify(column.type)}`,
      );
      continue;
    }
    try {
      assertCanonicalDefault(column);
    } catch (error) {
      problems.push(
        `${where}.${column.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function validateTable(
  name: string,
  table: SchemaTable,
  problems: string[],
): void {
  const namedProblem = resourceNameProblem("table", name);
  if (namedProblem) problems.push(namedProblem);

  if (!Number.isInteger(table.schemaVersion) || table.schemaVersion < 1)
    problems.push(`tables.${name}: schemaVersion must be a positive integer`);

  const pathProblem = storagePathProblem(table.storage?.path);
  if (pathProblem) problems.push(`tables.${name}: ${pathProblem}`);

  if (!(ROW_SHAPES as readonly string[]).includes(table.rowShape))
    problems.push(
      `tables.${name}: rowShape must be one of ${ROW_SHAPES.join("|")}`,
    );

  validateColumns(`tables.${name}`, table.columns, problems);

  if (table.keyColumns.length === 0) {
    problems.push(`tables.${name}: keyColumns must be a non-empty array`);
  }
  const keySeen = new Set<string>();
  for (const key of table.keyColumns) {
    if (keySeen.has(key)) {
      problems.push(`tables.${name}: duplicate key column '${key}'`);
      continue;
    }
    keySeen.add(key);
    const column = table.columns.find((candidate) => candidate.name === key);
    if (!column) {
      problems.push(
        `tables.${name}: key column '${key}' is not a declared column`,
      );
      continue;
    }
    const problem = keyColumnProblem(column);
    if (problem) problems.push(`tables.${name}.${key}: ${problem}`);
  }
}

// ---------------------------------------------------------------------------
// Restricted view query validation
// ---------------------------------------------------------------------------

const FORBIDDEN_VIEW_TOKENS =
  /(;|--|\/\*|\$[0-9]|\?)|\b(insert|update|delete|create|drop|alter|copy|attach|detach|install|load|pragma|export|import|call|set|begin|commit|rollback|vacuum|analyze|truncate|replace|use|describe|summarize|union|intersect|except|join|values|table|read_json|read_json_auto|read_csv|read_csv_auto|read_parquet|read_text|read_blob|read_ndjson|glob|sqlite_scan|postgres_scan|mysql_scan|parquet_scan|csv_scan|json_scan|iceberg_scan|delta_scan|duckdb_scan)\b/i;

function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (const char of value) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === separator && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** Index of the first top-level occurrence of `token` (case-insensitive). */
function topLevelIndex(value: string, token: string): number {
  const lower = value.toLowerCase();
  let depth = 0;
  let quote: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth !== 0) continue;
    if (lower.startsWith(token, index)) {
      const before = index === 0 ? " " : value[index - 1]!;
      const after = value[index + token.length] ?? " ";
      if (/[\s,()]/.test(before) && /[\s,(]/.test(after)) return index;
    }
  }
  return -1;
}

const IDENTIFIER_TOKEN = /[A-Za-z_][A-Za-z0-9_]*/g;

export interface ViewProjection {
  /** Exposed column name (alias, or the source column name). */
  name: string;
  /** Source dependency name. */
  dependency: string;
  /** Source column name on the dependency. */
  column: string;
}

export interface ParsedViewQuery {
  dependency: string;
  projections: ViewProjection[];
}

/**
 * Parse+validate one restricted view query.
 *
 * v1 view grammar (deliberately narrow): `SELECT <projection>[, ...] FROM
 * <declared dependency> [WHERE ...] [ORDER BY ...] [LIMIT n]`, where each
 * projection is a bare declared column (`col` or `dep.col`) with an optional
 * `AS alias`. Expressions, joins, sub-queries, set operations, parameters,
 * file-reading table functions and multi-statement text are rejected.
 */
export function parseViewQuery(
  view: string,
  query: string,
  problems: string[],
): ParsedViewQuery | null {
  const problemCount = problems.length;
  const where = `views.${view}.query`;
  const text = query.trim();
  if (text.length === 0) {
    problems.push(`${where}: query must be a non-empty SELECT statement`);
    return null;
  }
  if (FORBIDDEN_VIEW_TOKENS.test(text)) {
    problems.push(
      `${where}: only a single restricted SELECT over declared dependencies is permitted (no DDL/DML, joins, set operations, parameters, semicolons, or file-reading functions)`,
    );
    return null;
  }
  if (!/^select\b/i.test(text)) {
    problems.push(`${where}: query must start with SELECT`);
    return null;
  }
  if (/\bselect\b/i.test(text.slice(6))) {
    problems.push(`${where}: sub-queries are not permitted`);
    return null;
  }
  const fromIndex = topLevelIndex(text, "from");
  if (fromIndex === -1) {
    problems.push(`${where}: query must read exactly one declared dependency`);
    return null;
  }
  const projectionText = text.slice("select".length, fromIndex).trim();
  if (projectionText.length === 0) {
    problems.push(`${where}: query must project at least one declared column`);
    return null;
  }
  const rest = text.slice(fromIndex + "from".length);
  const endIndex = ["where", "order", "limit", "group", "having", "offset"]
    .map((token) => topLevelIndex(rest, token))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  const fromText = (
    endIndex === undefined ? rest : rest.slice(0, endIndex)
  ).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(fromText)) {
    problems.push(
      `${where}: FROM must name exactly one declared dependency without an alias`,
    );
    return null;
  }

  const projections: ViewProjection[] = [];
  const seen = new Set<string>();
  for (const rawProjection of splitTopLevel(projectionText, ",")) {
    const projection = rawProjection.trim();
    if (projection.length === 0) continue;
    const aliasMatch = /^(.+?)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/i.exec(
      projection,
    );
    const expression = (aliasMatch ? aliasMatch[1]! : projection).trim();
    const alias = aliasMatch?.[2];
    const reference =
      /^(?:([A-Za-z_][A-Za-z0-9_]*)\.)?([A-Za-z_][A-Za-z0-9_]*)$/.exec(
        expression,
      );
    if (!reference) {
      problems.push(
        `${where}: projection ${JSON.stringify(projection)} must be a bare declared column (optionally 'dep.col' with an AS alias); computed expressions are not permitted in v1`,
      );
      continue;
    }
    const dependency = reference[1] ?? fromText;
    const column = reference[2]!;
    const name = alias ?? column;
    if (seen.has(name)) {
      problems.push(`${where}: duplicate exposed column '${name}'`);
      continue;
    }
    seen.add(name);
    projections.push({ name, dependency, column });
  }
  if (projections.length === 0) return null;
  // A partially parsed projection list must never look like a valid exposed
  // shape: any recorded projection problem makes the whole query unresolvable.
  if (problems.length !== problemCount) return null;

  for (const projection of projections) {
    if (projection.dependency !== fromText) {
      problems.push(
        `${where}: projection references '${projection.dependency}', which is not the declared dependency '${fromText}'`,
      );
    }
  }
  return { dependency: fromText, projections };
}

/** Identifier references appearing anywhere in the query text. */
function referencedIdentifiers(query: string): string[] {
  const stripped = query.replace(/'[^']*'/g, "''");
  const keywords = new Set([
    "select",
    "from",
    "where",
    "order",
    "by",
    "asc",
    "desc",
    "limit",
    "offset",
    "and",
    "or",
    "not",
    "null",
    "is",
    "true",
    "false",
    "as",
    "in",
    "between",
    "like",
    "group",
    "having",
    "case",
    "when",
    "then",
    "else",
    "end",
    "cast",
    "integer",
    "varchar",
  ]);
  const out: string[] = [];
  for (const match of stripped.matchAll(IDENTIFIER_TOKEN)) {
    const token = match[0];
    if (keywords.has(token.toLowerCase())) continue;
    out.push(token);
  }
  return out;
}

function exposedTypesForDependency(
  document: SchemaDocument,
  dependency: string,
  seen: Set<string>,
): Map<string, DeclaredColumnType> | null {
  const table = document.tables[dependency];
  if (table)
    return new Map(table.columns.map((column) => [column.name, column.type]));
  if (document.views[dependency] !== undefined)
    return new Map(
      viewExposedColumns(document, dependency, seen).map((column) => [
        column.name,
        column.type,
      ]),
    );
  return null;
}

/**
 * Exposed columns of a declared view (names + declared types), resolved
 * through its dependencies. Returns `[]` for an unresolvable view — including
 * a view that takes part in a dependency cycle, which is unresolvable by
 * definition and must never recurse forever.
 */
export function viewExposedColumns(
  document: SchemaDocument,
  view: string,
  seen: Set<string> = new Set(),
): DeclaredColumn[] {
  if (seen.has(view)) return [];
  seen.add(view);
  const definition = document.views[view];
  if (!definition) return [];
  const problems: string[] = [];
  const parsed = parseViewQuery(view, definition.query, problems);
  if (!parsed) return [];
  const types = exposedTypesForDependency(document, parsed.dependency, seen);
  if (!types) return [];
  const columns: DeclaredColumn[] = [];
  for (const projection of parsed.projections) {
    const sourceType = types.get(projection.column);
    if (!sourceType) return [];
    columns.push({ name: projection.name, type: sourceType, nullable: true });
  }
  return columns;
}

function validateView(
  name: string,
  view: SchemaView,
  document: SchemaDocument,
  problems: string[],
): void {
  const namedProblem = resourceNameProblem("view", name);
  if (namedProblem) problems.push(namedProblem);

  if (!Number.isInteger(view.schemaVersion) || view.schemaVersion < 1)
    problems.push(`views.${name}: schemaVersion must be a positive integer`);
  if (view.dependsOn.length === 0)
    problems.push(`views.${name}: dependsOn must be a non-empty array`);

  const seenDeps = new Set<string>();
  for (const dependency of view.dependsOn) {
    if (seenDeps.has(dependency)) {
      problems.push(`views.${name}: duplicate dependency '${dependency}'`);
      continue;
    }
    seenDeps.add(dependency);
    if (dependency === name) {
      problems.push(`views.${name}: a view may not depend on itself`);
      continue;
    }
    if (
      document.tables[dependency] === undefined &&
      document.views[dependency] === undefined
    )
      problems.push(
        `views.${name}: dependency '${dependency}' is not a declared table or view`,
      );
  }

  const parsed = parseViewQuery(name, view.query, problems);
  if (!parsed) return;

  if (!seenDeps.has(parsed.dependency))
    problems.push(
      `views.${name}: query reads '${parsed.dependency}', which is not listed in dependsOn`,
    );

  const types = exposedTypesForDependency(
    document,
    parsed.dependency,
    new Set([name]),
  );
  if (!types) {
    problems.push(
      `views.${name}: dependency '${parsed.dependency}' is not a declared table or view`,
    );
    return;
  }
  for (const projection of parsed.projections) {
    if (!types.has(projection.column))
      problems.push(
        `views.${name}: column '${projection.column}' is not declared on '${projection.dependency}'`,
      );
  }

  const referenced = new Set(referencedIdentifiers(view.query));
  referenced.delete(parsed.dependency);
  for (const projection of parsed.projections)
    referenced.delete(projection.name);
  for (const token of referenced) {
    if (!types.has(token))
      problems.push(
        `views.${name}: identifier '${token}' is not a declared column of '${parsed.dependency}'`,
      );
  }
}

/** Depth-first cycle detection over the view dependency graph. */
function validateViewCycles(
  document: SchemaDocument,
  problems: string[],
): void {
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string, path: string[]): void => {
    const current = state.get(name);
    if (current === "done") return;
    if (current === "visiting") {
      const cycle = [...path.slice(path.indexOf(name)), name].join(" -> ");
      problems.push(`views: dependency cycle detected (${cycle})`);
      return;
    }
    state.set(name, "visiting");
    for (const dependency of document.views[name]?.dependsOn ?? []) {
      if (document.views[dependency] !== undefined)
        visit(dependency, [...path, name]);
    }
    state.set(name, "done");
  };
  for (const name of Object.keys(document.views)) visit(name, []);
}

/**
 * Every semantic problem with a raw document, or `[]` when it is a valid v1
 * document. Pure: no filesystem access, no caching.
 */
export function schemaDocumentProblems(raw: unknown): string[] {
  const parsed = DocumentSchema.safeParse(raw);
  if (!parsed.success) return describeIssues(parsed.error);
  const document = parsed.data as unknown as SchemaDocument;
  const problems: string[] = [];

  const paths = new Map<string, string>();
  for (const [name, table] of Object.entries(document.tables)) {
    const table_ = table as unknown as SchemaTable;
    validateTable(name, table_, problems);
    const path = table_.storage?.path;
    if (typeof path === "string" && pathProblemFree(path)) {
      const owner = paths.get(path);
      if (owner) {
        problems.push(
          `tables.${name}: storage.path '${path}' is already declared by table '${owner}'`,
        );
      } else {
        paths.set(path, name);
      }
    }
  }
  for (const [name, view] of Object.entries(document.views)) {
    validateView(name, view as unknown as SchemaView, document, problems);
  }
  validateViewCycles(document, problems);
  return problems;
}

function pathProblemFree(path: string): boolean {
  return storagePathProblem(path) === null;
}

/** Parse a raw document, throwing `ApiError` with every problem listed. */
export function parseSchemaDocument(
  raw: unknown,
  options: { status?: number; code?: string; where?: string } = {},
): SchemaDocument {
  const problems = schemaDocumentProblems(raw);
  if (problems.length > 0) {
    throw new ApiError(
      `${options.where ?? "schema.json"} is not a valid v${SCHEMA_DOCUMENT_VERSION} schema: ${problems.join("; ")}`,
      options.status ?? 500,
      options.code ?? "SCHEMA_INVALID",
    );
  }
  return raw as SchemaDocument;
}

// ---------------------------------------------------------------------------
// Deterministic formatting
// ---------------------------------------------------------------------------

function canonicalColumn(column: DeclaredColumn): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: column.name,
    type: column.type,
    nullable: column.nullable,
  };
  if (column.default !== undefined) out.default = column.default;
  return out;
}

/**
 * Canonical JSON text for a document: fixed key order, tables/views sorted by
 * name, 2-space indent, trailing newline. A logical no-op therefore produces
 * byte-identical text, which is what makes create-table idempotency provable.
 */
export function formatSchemaDocument(document: SchemaDocument): string {
  const tables: Record<string, unknown> = {};
  for (const name of Object.keys(document.tables).sort()) {
    const table = document.tables[name]!;
    tables[name] = {
      schemaVersion: table.schemaVersion,
      storage: { path: table.storage.path },
      rowShape: table.rowShape,
      keyColumns: [...table.keyColumns],
      columns: table.columns.map(canonicalColumn),
    };
  }
  const views: Record<string, unknown> = {};
  for (const name of Object.keys(document.views).sort()) {
    const view = document.views[name]!;
    views[name] = {
      schemaVersion: view.schemaVersion,
      dependsOn: [...view.dependsOn],
      query: view.query,
    };
  }
  const ordered = {
    schemaVersion: SCHEMA_DOCUMENT_VERSION,
    tables,
    views,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** A fresh empty document. */
export function emptySchemaDocument(): SchemaDocument {
  return { schemaVersion: SCHEMA_DOCUMENT_VERSION, tables: {}, views: {} };
}

/**
 * Byte-equivalent-after-canonicalization comparison for create-table
 * idempotency: the caller's canonical rendering must equal the stored one.
 */
export function sameCanonicalTable(
  left: SchemaTable,
  right: SchemaTable,
): boolean {
  const render = (table: SchemaTable): string =>
    formatSchemaDocument({
      schemaVersion: SCHEMA_DOCUMENT_VERSION,
      tables: { t: table },
      views: {},
    });
  return render(left) === render(right);
}

/** Canonical rendering of one table declaration (idempotency hashing input). */
export function canonicalTableText(table: SchemaTable): string {
  return formatSchemaDocument({
    schemaVersion: SCHEMA_DOCUMENT_VERSION,
    tables: { t: table },
    views: {},
  });
}
