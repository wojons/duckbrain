/**
 * DB-SUPA-6 — persistent namespace schema loader.
 *
 * Loads `namespaces/<ns>/schema.json` on first namespace access, caches the
 * validated document by FILE IDENTITY (`dev:ino:mtimeMs:size`, so an atomic
 * replacement — a rename from a temp file — is always seen as a new
 * identity), and registers each declaration into the existing
 * `TableSchemaRegistry` only after the WHOLE document validates.
 *
 * Failure semantics (spec: "Corrupt or half-written schema"):
 *   - missing file  → legacy namespace: no declarations, `memories` and the
 *     legacy `.table.json` registry keep working, generic SUPA-3 routes 404.
 *   - unreadable/invalid file → the last successfully validated in-memory
 *     snapshot stays registered for already-open operations, the current
 *     error is reported, and `assertNamespaceSchemaUsable()` refuses new
 *     generic table requests with `500 SCHEMA_INVALID`. A parse failure is
 *     never treated as an empty schema.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { z } from "zod";
import { getConfig } from "../config/index.js";
import { ApiError } from "../http/middleware/errorHandler.js";
import {
  tableSchemaRegistry,
  type RegisteredTableDeclaration,
} from "./registry.js";
import {
  emptySchemaDocument,
  schemaDocumentProblems,
  viewExposedColumns,
  type SchemaDocument,
  type SchemaTable,
} from "./schemaJson.js";
import {
  columnHasDefault,
  normalizeDeclaredValue,
  type DeclaredColumn,
} from "./schemaTypes.js";

export const SCHEMA_FILE_NAME = "schema.json";

export interface NamespaceSchemaError {
  message: string;
  problems: string[];
}

export interface NamespaceSchema {
  ns: string;
  root: string;
  nsDir: string;
  /** Absolute path of schema.json for this namespace. */
  path: string;
  /** True when a validated document is available (fresh or last-known-good). */
  present: boolean;
  /** Last successfully validated document (empty when never valid). */
  document: SchemaDocument;
  /** sha256 of the validated file bytes; `""` when nothing valid was read. */
  hash: string;
  /** True when this load reflects the file currently on disk. */
  fresh: boolean;
  /** Current-file failure, when the file on disk is unreadable or invalid. */
  error: NamespaceSchemaError | null;
}

export interface SchemaLoadOptions {
  /** Namespaces root override (tests / embedders). */
  namespacesPath?: string;
  /** Bypass the identity cache and re-read the file. */
  force?: boolean;
}

interface CacheEntry {
  root: string;
  identity: string | null;
  schema: NamespaceSchema;
}

const cache = new Map<string, CacheEntry>();

export function resolveNamespacesRoot(override?: string): string {
  return path.resolve(override ?? getConfig(".").namespacesPath);
}

function cacheKey(root: string, ns: string): string {
  return `${root}\u0000${ns}`;
}

/** Identity of the schema file, or `null` when it does not exist. */
export function schemaFileIdentity(
  ns: string,
  options: SchemaLoadOptions = {},
): string | null {
  const root = resolveNamespacesRoot(options.namespacesPath);
  try {
    const stat = fs.statSync(path.join(root, ns, SCHEMA_FILE_NAME));
    return `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

/** Drop the cached schema for one namespace (or every namespace). */
export function invalidateNamespaceSchema(ns?: string): void {
  if (ns === undefined) {
    cache.clear();
    return;
  }
  for (const [key, entry] of [...cache]) {
    if (entry.schema.ns === ns) cache.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Declaration validators
// ---------------------------------------------------------------------------

/**
 * Canonical outcome for one declared column value. `undefined` is the
 * "property absent" marker: it resolves through the pinned compatibility
 * adapter (declared default, else null for a nullable column, else an error).
 */
function canonicalColumnValue(
  column: DeclaredColumn,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; message: string } {
  if (value === undefined) {
    if (columnHasDefault(column))
      return { ok: true, value: column.default ?? null };
    if (column.nullable) return { ok: true, value: null };
    return {
      ok: false,
      message: `required column '${column.name}' is missing`,
    };
  }
  if (value === null) {
    if (!column.nullable)
      return {
        ok: false,
        message: `column '${column.name}' does not allow null (nullable: false)`,
      };
    return { ok: true, value: null };
  }
  try {
    return { ok: true, value: normalizeDeclaredValue(column, value) };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * One Zod validator per declared column, built from the canonical type rules.
 * It rejects every noncanonical value (see `schemaTypes.ts`) and transforms
 * accepted values into their canonical stored form, so what lands in the
 * serializer queue is already the on-disk representation.
 */
function columnValidator(column: DeclaredColumn): z.ZodTypeAny {
  // `z.optional` first: an absent property is a legitimate input, not a
  // "nonoptional" type error, so the compatibility adapter decides its value.
  return z.optional(z.any()).transform((value, ctx) => {
    const result = canonicalColumnValue(column, value);
    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: result.message });
      return null;
    }
    return result.value;
  });
}

/**
 * The row validator for one declared table: a strict object for
 * `rowShape: "object"` (undeclared properties are rejected) and an exact-length
 * array for `rowShape: "positional"` (the declared column count is required).
 */
export function declaredRowValidator(table: SchemaTable): z.ZodType {
  const validators = table.columns.map((column) => columnValidator(column));
  if (table.rowShape === "positional") {
    const columns = table.columns;
    return z
      .array(z.any())
      .superRefine((values, ctx) => {
        if (values.length !== columns.length)
          ctx.addIssue({
            code: "custom",
            message: `positional row must have exactly ${columns.length} value(s), got ${values.length}`,
          });
      })
      .transform((values, ctx) => {
        return columns.map((column, index) => {
          const result = canonicalColumnValue(column, values[index]);
          if (!result.ok) {
            ctx.addIssue({
              code: "custom",
              path: [index],
              message: result.message,
            });
            return null;
          }
          return result.value;
        });
      });
  }
  return z
    .object(
      Object.fromEntries(
        table.columns.map((column, index) => [column.name, validators[index]!]),
      ),
    )
    .strict();
}

function registerDocument(
  ns: string,
  document: SchemaDocument,
  hash: string,
): void {
  // Rebuild this namespace's durable declarations from THIS document: a table
  // removed by a new schema revision must not stay registered.
  tableSchemaRegistry.clearDeclarations(ns);
  for (const [table, definition] of Object.entries(document.tables)) {
    const declaration: RegisteredTableDeclaration = {
      ns,
      table,
      schema: declaredRowValidator(definition),
      storagePath: definition.storage.path,
      rowShape: definition.rowShape,
      keyColumns: [...definition.keyColumns],
      columns: definition.columns.map((column) => ({ ...column })),
      schemaVersion: definition.schemaVersion,
      documentHash: hash,
    };
    tableSchemaRegistry.registerDeclaration(declaration);
  }
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

function failedSchema(
  ns: string,
  root: string,
  nsDir: string,
  file: string,
  message: string,
  problems: string[],
  fallback: NamespaceSchema | undefined,
): NamespaceSchema {
  if (fallback?.present) {
    // Keep the last successfully validated snapshot registered for
    // already-open operations; report the current file's failure.
    return {
      ...fallback,
      ns,
      root,
      nsDir,
      path: file,
      fresh: false,
      error: { message, problems },
    };
  }
  return {
    ns,
    root,
    nsDir,
    path: file,
    present: false,
    document: emptySchemaDocument(),
    hash: "",
    fresh: false,
    error: { message, problems },
  };
}

/**
 * Load (or return the cached) namespace schema. Never throws for a corrupt
 * file — the failure is reported on the returned value, and callers opening
 * NEW generic operations must use `assertNamespaceSchemaUsable`.
 */
export function loadNamespaceSchema(
  ns: string,
  options: SchemaLoadOptions = {},
): NamespaceSchema {
  const root = resolveNamespacesRoot(options.namespacesPath);
  const nsDir = path.join(root, ns);
  const file = path.join(nsDir, SCHEMA_FILE_NAME);
  const key = cacheKey(root, ns);
  const cached = cache.get(key);

  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(file);
  } catch {
    stat = null;
  }
  const identity = stat
    ? `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.size}`
    : null;
  if (!options.force && cached && cached.identity === identity)
    return cached.schema;

  const store = (schema: NamespaceSchema): NamespaceSchema => {
    cache.set(key, { root, identity, schema });
    return schema;
  };

  if (!stat) {
    // Missing file: legacy namespace. Declarations from a removed
    // schema.json are dropped, so a deleted schema cannot keep serving.
    tableSchemaRegistry.clearDeclarations(ns);
    return store({
      ns,
      root,
      nsDir,
      path: file,
      present: false,
      document: emptySchemaDocument(),
      hash: "",
      fresh: true,
      error: null,
    });
  }

  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (error) {
    return store(
      failedSchema(
        ns,
        root,
        nsDir,
        file,
        `schema.json could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
        [],
        cached?.schema,
      ),
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return store(
      failedSchema(
        ns,
        root,
        nsDir,
        file,
        `schema.json is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
        [],
        cached?.schema,
      ),
    );
  }

  const problems = schemaDocumentProblems(raw);
  if (problems.length > 0) {
    return store(
      failedSchema(
        ns,
        root,
        nsDir,
        file,
        `schema.json is not a valid schema document: ${problems.join("; ")}`,
        problems,
        cached?.schema,
      ),
    );
  }

  const document = raw as SchemaDocument;
  const hash = crypto.createHash("sha256").update(text).digest("hex");
  registerDocument(ns, document, hash);
  return store({
    ns,
    root,
    nsDir,
    path: file,
    present: true,
    document,
    hash,
    fresh: true,
    error: null,
  });
}

/**
 * Refuse a NEW generic table operation when the file on disk is invalid.
 * Throws `500 SCHEMA_INVALID` carrying every validation problem.
 */
export function assertNamespaceSchemaUsable(
  ns: string,
  options: SchemaLoadOptions = {},
): NamespaceSchema {
  const schema = loadNamespaceSchema(ns, options);
  if (schema.error !== null && !schema.fresh)
    throw new ApiError(
      `namespace '${ns}' schema.json is invalid: ${schema.error.message}`,
      500,
      "SCHEMA_INVALID",
    );
  return schema;
}

/** Declared table from the persistent schema, or undefined (legacy namespace). */
export function getDeclaredTable(
  ns: string,
  table: string,
  options: SchemaLoadOptions = {},
): RegisteredTableDeclaration | undefined {
  loadNamespaceSchema(ns, options);
  return tableSchemaRegistry.getDeclaration(ns, table);
}

/** Every declared table for a namespace, sorted by name. */
export function listDeclaredTables(
  ns: string,
  options: SchemaLoadOptions = {},
): RegisteredTableDeclaration[] {
  loadNamespaceSchema(ns, options);
  return tableSchemaRegistry
    .listDeclarations(ns)
    .sort((left, right) => left.table.localeCompare(right.table));
}

/** Declared view definition (raw), or undefined. */
export function getDeclaredView(
  ns: string,
  view: string,
  options: SchemaLoadOptions = {},
) {
  return loadNamespaceSchema(ns, options).document.views[view];
}

/** Exposed column shape of a declared view (names + declared types). */
export function declaredViewColumns(
  ns: string,
  view: string,
  options: SchemaLoadOptions = {},
): DeclaredColumn[] {
  const document = loadNamespaceSchema(ns, options).document;
  if (document.views[view] === undefined) return [];
  return viewExposedColumns(document, view);
}
