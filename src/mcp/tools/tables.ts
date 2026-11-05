/**
 * Declared-table + query MCP tools (SURFACE-MCP-DATA-001)
 *
 * Before this module the MCP surface reached only memory primitives: an agent
 * could remember/recall/forget but could not declare a table, write a row,
 * read with a filter, update, delete, keyword-search or run one SELECT.
 * Everything below is a THIN adapter over the exact implementations the CLI
 * and REST routes call — no second code path:
 *
 *   tables_declare  → src/tables/declare.ts        (the `duckbrain tables declare` core)
 *   table_insert    → src/tables/operations.ts     (insertTableRows, POST /api/ns/:ns/tables/:table)
 *   table_select    → src/tables/operations.ts     (selectTableRows, GET  /api/ns/:ns/tables/:table)
 *   table_update    → src/tables/operations.ts     (updateTableRows, PATCH …?pk=eq.<v>)
 *   table_delete    → src/tables/operations.ts     (deleteTableRows, DELETE …?pk=eq.<v>)
 *   search          → src/mcp/tools/search.ts      (the `duckbrain search` keyword core)
 *   query           → src/duckdb/query-surface.ts  (the `duckbrain query` read-only core)
 *
 * Authorization sits where the REST routers put it: the namespace grant first
 * (enforceNamespaceScope), then the per-table grant on every DATA verb
 * (authorizeTableAccess — read for select, write for insert/update/delete/
 * declare), then the SQL policy for query (authorizeRawSql). A refusal returns
 * the same message text and machine-readable code the REST path returns and is
 * audited through the request-scoped denial sink with the same reason token
 * (`table_grant`, `role`, `namespace_scope`, `sql_flag`, `sql_cap`).
 */

import { z } from "zod";
import fs from "fs";
import { ApiError } from "../../http/middleware/errorHandler";
import { authorizeRawSql, authorizeTableAccess } from "../../auth/roles";
import {
  QUERY_MAX_ROWS,
  ReadOnlyQueryError,
  runReadOnlyQuery,
} from "../../duckdb/query-surface";
import {
  deleteTableRows,
  filterParams,
  insertTableRows,
  listNamespaceTables,
  resolveTableDeclaration,
  selectTableRows,
  updateTableRows,
} from "../../tables/operations";
import { declareTable, TableDeclareError } from "../../tables/declare";
import {
  auditRawSqlDenial,
  auditTableGrantDenial,
  enforceNamespaceScope,
  resolveNamespaceName,
  resolveNamespacePath,
  resolveToolPrincipal,
  type McpToolContext,
} from "./shared";

/** Machine-readable refusal — the shape every MCP tool returns on failure. */
interface ToolRefusal {
  success: false;
  code: string;
  reason?: string;
  error: string;
  /** Open payload: refusal shapes stay extensible without a type lie. */
  [key: string]: unknown;
}

/**
 * Map a thrown operation error onto the MCP refusal payload.
 *
 * ApiError carries the REST status + code; the MESSAGE is returned verbatim so
 * an agent sees the same text a REST caller would (the row's parity
 * requirement), and the CODE is the same token (NOT_FOUND, VALIDATION_ERROR,
 * SERIALIZER_LOCKED, AUDIT_APPEND_FAILED …).
 */
function refusalFromError(error: unknown, fallbackCode = "ERROR"): ToolRefusal {
  if (error instanceof ApiError) {
    return {
      success: false,
      code: error.code ?? fallbackCode,
      error: error.message,
    };
  }
  if (error instanceof TableDeclareError) {
    return {
      success: false,
      code: error.kind === "usage" ? "VALIDATION_ERROR" : "DECLARE_REFUSED",
      error: error.message,
    };
  }
  return {
    success: false,
    code: fallbackCode,
    error: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Apply the namespace grant, then the per-table grant, exactly as the REST
 * route stack does (requireNamespaceGrant → requireTableGrant).
 */
function authorizeTableVerb(
  context: McpToolContext | undefined,
  namespace: string,
  table: string,
  operation: "read" | "write",
): ToolRefusal | undefined {
  const scoped = enforceNamespaceScope(context, namespace);
  if (scoped) return { ...scoped };
  const principal = resolveToolPrincipal(context);
  const decision = authorizeTableAccess(principal, namespace, table, operation);
  if (decision.allowed) return undefined;
  auditTableGrantDenial(
    context,
    namespace,
    table,
    operation,
    principal,
    decision.reason,
  );
  return {
    success: false,
    code: "FORBIDDEN",
    reason: decision.reason,
    error: decision.message,
  };
}

const NamespaceArg = z
  .string()
  .optional()
  .describe("Namespace (defaults to the active namespace)");

// ---------------------------------------------------------------------------
// tables_declare
// ---------------------------------------------------------------------------

const TableDeclareInputSchema = z.object({
  namespace: NamespaceArg,
  table: z
    .string()
    .describe("Table name (lowercase letters, digits, '-', '_'; schema.json rules apply)"),
  columns: z
    .array(
      z.object({
        name: z.string().describe("Column name"),
        type: z
          .string()
          .describe("Column type: varchar|integer|bigint|double|boolean|timestamp|json"),
      }),
    )
    .min(1)
    .describe("Declared columns; the first is the primary key unless `primary` is given"),
  primary: z
    .string()
    .optional()
    .describe("Primary key column (must be one of `columns`)"),
  format: z
    .enum(["jsonl-objects", "jsonl-positional"])
    .optional()
    .describe("Row shape (default jsonl-objects)"),
  legacy: z
    .boolean()
    .optional()
    .describe("Write tables/<table>.table.json instead of the SUPA-6 schema.json"),
  force: z
    .boolean()
    .optional()
    .describe("Replace an existing declaration of the same table with a different contract"),
});

export interface TableDeclareOutput {
  success: boolean;
  namespace?: string;
  table?: string;
  path?: string;
  format?: "schema.json" | "legacy";
  replacedExisting?: boolean;
  code?: string;
  error?: string;
}

/**
 * Declare a table — the MCP twin of `duckbrain tables declare`.
 *
 * Forwards to declareTable() (src/tables/declare.ts), the CLI's own core: the
 * schema.json path merges under the DDL fence, validates with the production
 * validator, journals the switch and re-loads through the real loader, and
 * rolls back on failure.
 */
export async function tablesDeclareTool(
  input: unknown,
  context?: McpToolContext,
): Promise<TableDeclareOutput> {
  const parsed = TableDeclareInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      code: "VALIDATION_ERROR",
      error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    };
  }
  const args = parsed.data;
  const namespace = resolveNamespaceName(args.namespace);
  const denied = authorizeTableVerb(context, namespace, args.table, "write");
  if (denied) return denied;
  try {
    const result = await declareTable({
      ns: namespace,
      table: args.table,
      columns: args.columns,
      ...(args.primary !== undefined ? { primary: args.primary } : {}),
      ...(args.format !== undefined ? { format: args.format } : {}),
      ...(args.legacy !== undefined ? { legacy: args.legacy } : {}),
      ...(args.force !== undefined ? { force: args.force } : {}),
    });
    return {
      success: true,
      namespace: result.ns,
      table: result.table,
      path: result.path,
      format: result.format,
      replacedExisting: result.replacedExisting,
    };
  } catch (error) {
    return refusalFromError(error);
  }
}

// ---------------------------------------------------------------------------
// table_insert
// ---------------------------------------------------------------------------

const TableInsertInputSchema = z.object({
  namespace: NamespaceArg,
  table: z.string().describe("Declared table name"),
  rows: z
    .array(z.record(z.string(), z.unknown()))
    .min(1)
    .describe("Rows to insert (each a column→value object)"),
});

/**
 * Insert rows into a declared table — the SAME insertTableRows() the REST POST
 * route calls. Every row is validated (coerced + primary key present) before
 * any write, so a bad batch inserts nothing.
 */
export async function tableInsertTool(
  input: unknown,
  context?: McpToolContext,
): Promise<Record<string, unknown>> {
  const parsed = TableInsertInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      code: "VALIDATION_ERROR",
      error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    };
  }
  const args = parsed.data;
  const namespace = resolveNamespaceName(args.namespace);
  const denied = authorizeTableVerb(context, namespace, args.table, "write");
  if (denied) return denied;
  try {
    const { inserted, durability } = await insertTableRows(
      namespace,
      args.table,
      args.rows,
      resolveToolPrincipal(context),
    );
    return {
      success: true,
      namespace,
      table: args.table,
      inserted,
      durability,
    };
  } catch (error) {
    return refusalFromError(error);
  }
}

// ---------------------------------------------------------------------------
// table_select
// ---------------------------------------------------------------------------

const TableSelectInputSchema = z.object({
  namespace: NamespaceArg,
  table: z.string().describe("Declared table name"),
  filters: z
    .record(z.string(), z.union([z.string(), z.array(z.string())]))
    .optional()
    .describe(
      "PostgREST filters: {column: 'op.value'} with op ∈ eq|ne|gt|gte|lt|lte|like|in (in takes 'in.(a,b)')",
    ),
  order: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe("Order: 'col.asc' or 'col.desc' (repeatable)"),
  limit: z.number().int().positive().optional().describe("Max rows (hard cap 1000)"),
  offset: z.number().int().nonnegative().optional().describe("Rows to skip"),
  count: z
    .enum(["exact"])
    .optional()
    .describe("count=exact → return totalCount for the filter"),
});

/**
 * SELECT a declared table — the SAME selectTableRows() the REST GET route
 * calls, including the documented filter/order/limit vocabulary and the
 * json-column round-trip.
 */
export async function tableSelectTool(
  input: unknown,
  context?: McpToolContext,
): Promise<Record<string, unknown>> {
  const parsed = TableSelectInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      code: "VALIDATION_ERROR",
      error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    };
  }
  const args = parsed.data;
  const namespace = resolveNamespaceName(args.namespace);
  const denied = authorizeTableVerb(context, namespace, args.table, "read");
  if (denied) return denied;
  try {
    // Resolve first so the unknown-column rule (and its message) is applied by
    // the shared filterParams, exactly like the REST querystring path.
    const declaration = resolveTableDeclaration(namespace, args.table);
    const filters = filterParams(
      { ...(args.filters ?? {}) },
      declaration,
    );
    const { rows, totalCount } = await selectTableRows(namespace, args.table, {
      filters,
      order: args.order,
      limit: args.limit,
      offset: args.offset,
      wantCount: args.count === "exact",
    });
    return {
      success: true,
      namespace,
      table: args.table,
      rows,
      count: rows.length,
      ...(totalCount !== null ? { totalCount } : {}),
    };
  } catch (error) {
    return refusalFromError(error);
  }
}

// ---------------------------------------------------------------------------
// table_update / table_delete
// ---------------------------------------------------------------------------

const TableUpdateInputSchema = z.object({
  namespace: NamespaceArg,
  table: z.string().describe("Declared table name"),
  pk: z
    .union([z.string(), z.number()])
    .describe("Primary-key value to match (the ?pk=eq.<value> filter)"),
  values: z
    .record(z.string(), z.unknown())
    .describe("Column values to set (a partial patch is allowed)"),
});

/**
 * UPDATE rows by primary key — the SAME updateTableRows() the REST PATCH route
 * calls (read-merge-rewrite under the namespace write lock + the DB-SUPA-5
 * change record before the acknowledgement).
 */
export async function tableUpdateTool(
  input: unknown,
  context?: McpToolContext,
): Promise<Record<string, unknown>> {
  const parsed = TableUpdateInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      code: "VALIDATION_ERROR",
      error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    };
  }
  const args = parsed.data;
  const namespace = resolveNamespaceName(args.namespace);
  const denied = authorizeTableVerb(context, namespace, args.table, "write");
  if (denied) return denied;
  try {
    const { updated, durability } = await updateTableRows(
      namespace,
      args.table,
      `eq.${String(args.pk)}`,
      args.values,
      resolveToolPrincipal(context),
    );
    return { success: true, namespace, table: args.table, updated, durability };
  } catch (error) {
    return refusalFromError(error);
  }
}

const TableDeleteInputSchema = z.object({
  namespace: NamespaceArg,
  table: z.string().describe("Declared table name"),
  pk: z
    .union([z.string(), z.number()])
    .describe("Primary-key value to match (the ?pk=eq.<value> filter)"),
});

/**
 * DELETE rows by primary key — the SAME deleteTableRows() the REST DELETE
 * route calls (tombstone change record before the acknowledgement).
 */
export async function tableDeleteTool(
  input: unknown,
  context?: McpToolContext,
): Promise<Record<string, unknown>> {
  const parsed = TableDeleteInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      code: "VALIDATION_ERROR",
      error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    };
  }
  const args = parsed.data;
  const namespace = resolveNamespaceName(args.namespace);
  const denied = authorizeTableVerb(context, namespace, args.table, "write");
  if (denied) return denied;
  try {
    const { deleted, durability } = await deleteTableRows(
      namespace,
      args.table,
      `eq.${String(args.pk)}`,
      resolveToolPrincipal(context),
    );
    return { success: true, namespace, table: args.table, deleted, durability };
  } catch (error) {
    return refusalFromError(error);
  }
}

// ---------------------------------------------------------------------------
// table_list (the registry read the agents need to discover a table at all)
// ---------------------------------------------------------------------------

const TableListInputSchema = z.object({
  namespace: NamespaceArg,
});

/** List declared tables — the REST GET /api/ns/:ns/tables list, grant-scoped. */
export async function tableListTool(
  input: unknown,
  context?: McpToolContext,
): Promise<Record<string, unknown>> {
  const parsed = TableListInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      code: "VALIDATION_ERROR",
      error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    };
  }
  const namespace = resolveNamespaceName(parsed.data.namespace);
  const scoped = enforceNamespaceScope(context, namespace);
  if (scoped) return { ...scoped };
  try {
    return {
      success: true,
      namespace,
      tables: listNamespaceTables(namespace),
    };
  } catch (error) {
    return refusalFromError(error);
  }
}

// ---------------------------------------------------------------------------
// query (read-only SQL)
// ---------------------------------------------------------------------------

const QueryInputSchema = z.object({
  namespace: NamespaceArg,
  sql: z
    .string()
    .min(1)
    .describe(
      "Read-only SQL over the namespace's `memories` view (latest record per id, tombstones excluded, validity-filtered). Mutating statements are rejected.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Row cap (default and maximum ${QUERY_MAX_ROWS})`),
});

/**
 * Run one read-only SELECT — the SAME runReadOnlyQuery() `duckbrain query`
 * calls (statement allow-listing, numeric LIMIT enforcement, row cap).
 */
export async function queryTool(
  input: unknown,
  context?: McpToolContext,
): Promise<Record<string, unknown>> {
  const parsed = QueryInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      code: "VALIDATION_ERROR",
      error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    };
  }
  const args = parsed.data;
  const namespace = resolveNamespaceName(args.namespace);
  const scoped = enforceNamespaceScope(context, namespace);
  if (scoped) return { ...scoped };

  const principal = resolveToolPrincipal(context);
  const decision = authorizeRawSql(principal, namespace, "read");
  if (!decision.allowed) {
    auditRawSqlDenial(context, namespace, "read", principal, decision.reason);
    return {
      success: false,
      code: "FORBIDDEN",
      reason: decision.reason,
      error: decision.message,
    };
  }

  const namespacePath = resolveNamespacePath(namespace);
  if (!fs.existsSync(namespacePath)) {
    return {
      success: false,
      code: "NOT_FOUND",
      error: `Namespace '${namespace}' does not exist`,
    };
  }
  const cap = Math.min(args.limit ?? QUERY_MAX_ROWS, QUERY_MAX_ROWS);
  try {
    const result = await runReadOnlyQuery(namespacePath, args.sql, cap);
    return {
      success: true,
      namespace,
      columns: result.columns,
      rows: result.rows,
      count: result.count,
      truncated: result.truncated,
    };
  } catch (error) {
    if (error instanceof ReadOnlyQueryError) {
      return { success: false, code: "READ_ONLY_QUERY", error: error.message };
    }
    return refusalFromError(error);
  }
}

// ---------------------------------------------------------------------------
// Tool metadata (registered in src/mcp/server.ts)
// ---------------------------------------------------------------------------

export const tablesDeclareToolDef = {
  name: "tables_declare",
  title: "Declare Table",
  description:
    "Declare a table on the store so table_insert/table_select/table_update/table_delete can serve it (SUPA-6 schema.json, or --legacy .table.json). Same core as `duckbrain tables declare`.",
  inputSchema: TableDeclareInputSchema,
  handler: tablesDeclareTool,
};

export const tableListToolDef = {
  name: "table_list",
  title: "List Declared Tables",
  description:
    "List the tables declared in a namespace (name, format, columns, primary key, storage glob).",
  inputSchema: TableListInputSchema,
  handler: tableListTool,
};

export const tableInsertToolDef = {
  name: "table_insert",
  title: "Insert Table Rows",
  description:
    "Insert one or more rows into a declared table. Validates every row (including the primary key) before writing anything.",
  inputSchema: TableInsertInputSchema,
  handler: tableInsertTool,
};

export const tableSelectToolDef = {
  name: "table_select",
  title: "Select Table Rows",
  description:
    "Read rows from a declared table with PostgREST-style filters (eq/ne/gt/gte/lt/lte/like/in), order, limit/offset and an optional exact count.",
  inputSchema: TableSelectInputSchema,
  handler: tableSelectTool,
};

export const tableUpdateToolDef = {
  name: "table_update",
  title: "Update Table Rows",
  description:
    "Update the row matched by a primary-key value. A partial patch is allowed; the merged row is validated.",
  inputSchema: TableUpdateInputSchema,
  handler: tableUpdateTool,
};

export const tableDeleteToolDef = {
  name: "table_delete",
  title: "Delete Table Rows",
  description: "Delete the row matched by a primary-key value.",
  inputSchema: TableDeleteInputSchema,
  handler: tableDeleteTool,
};

export const queryToolDef = {
  name: "query",
  title: "Read-Only SQL Query",
  description:
    "Run one read-only SELECT over a namespace's memories view. Mutating statements are rejected and results are capped.",
  inputSchema: QueryInputSchema,
  handler: queryTool,
};

export { TableDeclareInputSchema, TableInsertInputSchema, TableSelectInputSchema, TableUpdateInputSchema, TableDeleteInputSchema, QueryInputSchema };

/** Every data-plane tool, in registration order. */
export const tableToolDefs = [
  tableListToolDef,
  tablesDeclareToolDef,
  tableInsertToolDef,
  tableSelectToolDef,
  tableUpdateToolDef,
  tableDeleteToolDef,
  queryToolDef,
];
