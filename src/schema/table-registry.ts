/**
 * Declared Table Registry (DB-SUPA-3)
 *
 * A generic table→REST resource layer needs to know each table's columns
 * WITHOUT introspecting data at request time. Bare auto-introspection of
 * multi-file JSONL lists is the exact read_json_auto pattern that has
 * SIGABRT'd the process before (DOGFOOD-010/018/019 crash class: a
 * heterogeneous/ambiguous schema makes read_json_auto infer MAP/STRUCT
 * types whose conversion throws from native code, killing the whole
 * process). So every table exposed through /api/ns/:ns/tables must be
 * DECLARED on disk:
 *
 *   namespaces/<ns>/tables/<table>.table.json
 *
 *     {
 *       "name": "widgets",
 *       "format": "jsonl-objects" | "jsonl-positional",
 *       "columns": [{ "name": "id", "type": "integer" }, ...],
 *       "primary": "id" | null,
 *       "glob": "<glob relative to the namespace dir>"
 *     }
 *
 * The registry reads and validates those declarations, caches them
 * in-process, and exposes listTables/getTable. Unknown or missing
 * declarations are a plain 404 condition — there is deliberately NO
 * auto-introspection fallback.
 *
 * Supported column types map 1:1 onto DuckDB types: varchar, integer,
 * bigint, double, boolean, timestamp, json.
 */

import fs from "fs";
import path from "path";
import { getConfig } from "../config/index.js";
import { ApiError } from "../http/middleware/errorHandler.js";
import {
  duckColumnTypeForDeclared,
  singleKeyColumn,
  type DeclaredColumnType,
} from "../serialization/schemaTypes.js";
import type { RegisteredTableDeclaration } from "../serialization/registry.js";
import {
  invalidateNamespaceSchema,
  listDeclaredTables,
} from "../serialization/schemaRegistry.js";

/** The declared column types (exact DuckDB type names). */
export const TABLE_COLUMN_TYPES = [
  "varchar",
  "integer",
  "bigint",
  "double",
  "boolean",
  "timestamp",
  "json",
] as const;

export type TableColumnTypeName = (typeof TABLE_COLUMN_TYPES)[number];

/** The storage formats a declared table can use. */
export const TABLE_FORMATS = ["jsonl-objects", "jsonl-positional"] as const;

export type TableFormat = (typeof TABLE_FORMATS)[number];

export interface TableColumn {
  name: string;
  type: TableColumnTypeName;
  /**
   * DB-SUPA-6 declared type, present only for tables declared in a namespace
   * `schema.json`. It carries the canonical representation rules (int64 as a
   * canonical decimal STRING, `base64url:` bytes, canonical UTC timestamps)
   * that the DuckDB type alone cannot express.
   */
  declaredType?: DeclaredColumnType;
  /** DB-SUPA-6 nullability flag (from the persistent declaration). */
  nullable?: boolean;
  /** DB-SUPA-6 pinned default value (canonical representation). */
  default?: unknown;
  /** True when a `default` was declared (an explicit `null` default counts). */
  hasDefault?: boolean;
}

export interface TableDeclaration {
  /** Table name — must match /^[a-z0-9_-]+$/ (URL-segment safe). */
  name: string;
  format: TableFormat;
  /** Declared columns, in order. Positional tables map columns[i] to the JSON array element i. */
  columns: TableColumn[];
  /** Declared primary key column name, or null when the table has none. */
  primary: string | null;
  /** Glob of JSONL file(s) relative to the namespace directory. */
  glob: string;
  /** DB-SUPA-6 declared key columns (may be composite); absent for legacy declarations. */
  declaredKeyColumns?: string[];
  /** DB-SUPA-6 table version from the persistent declaration. */
  schemaVersion?: number;
  /**
   * Provenance: `"schema.json"` for a persistent DB-SUPA-6 declaration,
   * `"legacy"` for `tables/<table>.table.json`. Legacy declarations are
   * unchanged by DB-SUPA-6 and always win on a name conflict.
   */
  source?: "schema.json" | "legacy";
}

/** Validate the declaration object (shape + name/identifier hygiene). */
function validateTableDeclaration(
  ns: string,
  fileName: string,
  raw: unknown,
): TableDeclaration {
  if (typeof raw !== "object" || raw === null) {
    throw new ApiError(
      `Invalid table declaration ${fileName} in namespace '${ns}': not a JSON object`,
      500,
      "TABLE_REGISTRY_ERROR",
    );
  }
  const raw_ = raw as Record<string, unknown>;

  const name = raw_.name;
  if (typeof name !== "string" || !/^[a-z0-9_-]+$/.test(name)) {
    throw new ApiError(
      `Invalid table declaration ${fileName}: 'name' must match ^[a-z0-9_-]+$`,
      500,
      "TABLE_REGISTRY_ERROR",
    );
  }
  const base = fileName.replace(/\.table\.json$/, "");
  if (name !== base) {
    throw new ApiError(
      `Invalid table declaration ${fileName}: 'name' (${name}) must equal the file base name (${base})`,
      500,
      "TABLE_REGISTRY_ERROR",
    );
  }

  const format = raw_.format;
  if (
    typeof format !== "string" ||
    !TABLE_FORMATS.includes(format as TableFormat)
  ) {
    throw new ApiError(
      `Invalid table declaration ${fileName}: 'format' must be one of ${TABLE_FORMATS.join("|")}`,
      500,
      "TABLE_REGISTRY_ERROR",
    );
  }

  if (!Array.isArray(raw_.columns) || raw_.columns.length === 0) {
    throw new ApiError(
      `Invalid table declaration ${fileName}: 'columns' must be a non-empty array`,
      500,
      "TABLE_REGISTRY_ERROR",
    );
  }
  const columns: TableColumn[] = [];
  const seen = new Set<string>();
  for (const col of raw_.columns) {
    if (typeof col !== "object" || col === null) {
      throw new ApiError(
        `Invalid table declaration ${fileName}: every column must be an object`,
        500,
        "TABLE_REGISTRY_ERROR",
      );
    }
    const col_ = col as Record<string, unknown>;
    const colName = col_.name;
    if (
      typeof colName !== "string" ||
      !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(colName)
    ) {
      throw new ApiError(
        `Invalid table declaration ${fileName}: column name ${JSON.stringify(colName)} is not a valid identifier`,
        500,
        "TABLE_REGISTRY_ERROR",
      );
    }
    if (seen.has(colName)) {
      throw new ApiError(
        `Invalid table declaration ${fileName}: duplicate column '${colName}'`,
        500,
        "TABLE_REGISTRY_ERROR",
      );
    }
    seen.add(colName);
    const colType = col_.type;
    if (
      typeof colType !== "string" ||
      !TABLE_COLUMN_TYPES.includes(colType as TableColumnTypeName)
    ) {
      throw new ApiError(
        `Invalid table declaration ${fileName}: column '${colName}' has unsupported type ${JSON.stringify(colType)} (expected one of ${TABLE_COLUMN_TYPES.join("|")})`,
        500,
        "TABLE_REGISTRY_ERROR",
      );
    }
    columns.push({ name: colName, type: colType as TableColumnTypeName });
  }

  const primary = raw_.primary ?? null;
  if (primary !== null) {
    if (
      typeof primary !== "string" ||
      !columns.some((c) => c.name === primary)
    ) {
      throw new ApiError(
        `Invalid table declaration ${fileName}: 'primary' must name one of the declared columns`,
        500,
        "TABLE_REGISTRY_ERROR",
      );
    }
  }

  if (typeof raw_.glob !== "string" || raw_.glob.length === 0) {
    throw new ApiError(
      `Invalid table declaration ${fileName}: 'glob' is required`,
      500,
      "TABLE_REGISTRY_ERROR",
    );
  }
  if (path.isAbsolute(raw_.glob) || raw_.glob.includes("..")) {
    throw new ApiError(
      `Invalid table declaration ${fileName}: 'glob' must be relative to the namespace directory (no absolute paths, no '..')`,
      500,
      "TABLE_REGISTRY_ERROR",
    );
  }

  return {
    name,
    format: format as TableFormat,
    columns,
    primary: primary as string | null,
    glob: raw_.glob,
    source: "legacy",
  };
}

/** Absolute path of a namespace directory (honors DUCKBRAIN_NAMESPACES_PATH). */
export function namespaceDir(ns: string): string {
  return path.resolve(getConfig(".").namespacesPath, ns);
}

/** Absolute path of a table's data file(s) resolved from its declared glob. */
export function tableDataGlobPath(
  nsDir: string,
  declaration: TableDeclaration,
): string {
  return path.resolve(nsDir, declaration.glob);
}

/**
 * Read and validate every declaration in `namespaces/<ns>/tables/`.
 * Returns an empty list when the namespace has no tables directory
 * (a namespace without declared tables is valid — it just exposes none).
 */
function readNamespaceDeclarations(ns: string): TableDeclaration[] {
  const tablesDir = path.join(namespaceDir(ns), "tables");
  let entries: string[];
  try {
    entries = fs.readdirSync(tablesDir);
  } catch {
    return [];
  }
  const declarations: TableDeclaration[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".table.json")) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(tablesDir, entry), "utf-8"));
    } catch (e) {
      throw new ApiError(
        `Unparseable table declaration ${entry} in namespace '${ns}': ${e instanceof Error ? e.message : String(e)}`,
        500,
        "TABLE_REGISTRY_ERROR",
      );
    }
    declarations.push(validateTableDeclaration(ns, entry, raw));
  }
  return declarations;
}

/**
 * In-process registry cache: ns → declarations plus a staleness snapshot of
 * the namespace's tables dir (filename → mtimeMs/size), or `null` for
 * namespaces scanned-and-found-empty. A scan failure is NOT cached — the next
 * request retries, so a transient fs error or a since-fixed declaration heals
 * itself. The snapshot lets legacyDeclarations() re-read when an OUT-OF-BAND
 * writer (an external process, e.g. a foreman rewriting the declaration set)
 * adds/removes/rewrites a declaration file without any in-process invalidation.
 */
interface RegistryCacheEntry {
  declarations: TableDeclaration[];
  snapshot: Map<string, { mtimeMs: number; size: number }>;
}

const registryCache = new Map<string, RegistryCacheEntry | null>();

/**
 * Snapshot the namespace's tables dir (filename → mtimeMs/size) for
 * staleness detection. Returns `null` when the dir cannot be listed —
 * the caller treats that as a failed scan and caches nothing.
 */
function tablesDirSnapshot(
  ns: string,
): Map<string, { mtimeMs: number; size: number }> | null {
  const tablesDir = path.join(namespaceDir(ns), "tables");
  let entries: string[];
  try {
    entries = fs.readdirSync(tablesDir);
  } catch {
    return null;
  }
  const snapshot = new Map<string, { mtimeMs: number; size: number }>();
  for (const entry of entries) {
    if (!entry.endsWith(".table.json")) continue;
    try {
      const stat = fs.statSync(path.join(tablesDir, entry));
      snapshot.set(entry, { mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      // A file that vanished between readdir and stat simply contributes
      // no snapshot entry; the listing itself decides its fate.
    }
  }
  return snapshot;
}

/** True when two snapshots differ (files added/removed/renamed or rewritten). */
function snapshotsDiffer(
  left: Map<string, { mtimeMs: number; size: number }>,
  right: Map<string, { mtimeMs: number; size: number }>,
): boolean {
  if (left.size !== right.size) return true;
  for (const [file, stat] of left) {
    const other = right.get(file);
    if (!other) return true;
    if (other.mtimeMs !== stat.mtimeMs || other.size !== stat.size) return true;
  }
  return false;
}

/**
 * DB-SUPA-6: adapt a persistent `schema.json` declaration to the SUPA-3
 * declaration shape. The canonical type travels with the column
 * (`declaredType`) so the read/write layer keeps the exact representation the
 * schema promised instead of the DuckDB type alone.
 */
export function tableDeclarationFromSchema(
  declaration: RegisteredTableDeclaration,
): TableDeclaration {
  return {
    name: declaration.table,
    format:
      declaration.rowShape === "positional"
        ? "jsonl-positional"
        : "jsonl-objects",
    columns: declaration.columns.map((column) => ({
      name: column.name,
      type: duckColumnTypeForDeclared(column.type),
      declaredType: column.type,
      nullable: column.nullable,
      ...(column.default !== undefined ? { default: column.default } : {}),
      hasDefault: column.default !== undefined,
    })),
    primary: singleKeyColumn(declaration.keyColumns),
    glob: declaration.storagePath,
    declaredKeyColumns: [...declaration.keyColumns],
    schemaVersion: declaration.schemaVersion,
    source: "schema.json",
  };
}

/**
 * Legacy `tables/<table>.table.json` declarations for a namespace (cached
 * behind an mtime/size staleness check). The cached snapshot is compared
 * against the CURRENT listing of the tables dir on every read, so an
 * out-of-band rewrite (external writer, no in-process invalidation) is
 * picked up on the next request. `listDeclaredTables` walks the persistent
 * `schema.json` separately.
 *
 * A scan failure (unreadable dir) is never cached: the cache entry is dropped
 * and the next request retries from scratch.
 */
function legacyDeclarations(ns: string): TableDeclaration[] {
  const freshSnapshot = tablesDirSnapshot(ns);
  if (freshSnapshot === null) {
    // The listing itself failed: drop any cached entry and retry the read —
    // a failure must never be cached.
    registryCache.delete(ns);
    return readNamespaceDeclarations(ns);
  }
  const cached = registryCache.get(ns);
  if (cached) {
    // A directory-less empty cache means "dir absent at fill time"; re-read
    // only when the dir now exists but no snapshot was stored (or differs).
    if (
      cached.snapshot.size > 0 ||
      fs.existsSync(path.join(namespaceDir(ns), "tables"))
    ) {
      if (!snapshotsDiffer(cached.snapshot, freshSnapshot)) {
        return cached.declarations;
      }
    }
  }
  const declarations = readNamespaceDeclarations(ns);
  registryCache.set(ns, { declarations, snapshot: freshSnapshot });
  return declarations;
}

/** Drop the cached declarations for one namespace (or all when omitted). */
export function invalidateTableRegistry(ns?: string): void {
  if (ns === undefined) registryCache.clear();
  else registryCache.delete(ns);
  invalidateNamespaceSchema(ns);
}

/**
 * List every declared table in a namespace: the persistent DB-SUPA-6
 * `schema.json` declarations plus the legacy `tables/<table>.table.json`
 * declarations. Legacy wins on a name conflict (working legacy declarations
 * are never silently replaced); an invalid `schema.json` never contributes
 * declarations and never turns into an empty schema.
 * Throws ApiError 500 on a bad legacy declaration file.
 */
export function listTables(ns: string): TableDeclaration[] {
  const legacy = legacyDeclarations(ns);
  const fromSchema = listDeclaredTables(ns).map(tableDeclarationFromSchema);
  const legacyNames = new Set(legacy.map((declaration) => declaration.name));
  return [
    ...legacy,
    ...fromSchema.filter((declaration) => !legacyNames.has(declaration.name)),
  ];
}

/**
 * Get one declared table by name. 404 (NOT_FOUND) when the namespace has no
 * such declaration — unknown/missing declarations are a plain not-found, not
 * an auto-introspection trigger.
 */
export function getTable(ns: string, table: string): TableDeclaration {
  const found = listTables(ns).find((t) => t.name === table);
  if (!found) {
    throw new ApiError(
      `Table '${table}' not found in namespace '${ns}'`,
      404,
      "NOT_FOUND",
    );
  }
  return found;
}
