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
 *   tables_alter    → src/serialization/ddl.ts     (addColumn / retypeColumn — DDL-EVOLVE-001)
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
  addColumn,
  retypeColumn,
  type DdlResult,
} from "../../serialization/ddl";
import { DECLARED_TYPES, type DeclaredColumnType } from "../../serialization/schemaTypes";
import {
  auditRawSqlDenial,
  auditTableGrantDenial,
  enforceNamespaceScope,
  resolveNamespaceName,
  resolveNamespacePath,
  resolveToolPrincipal,
  resolveToolDenialAuditor,
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
      // DDL-EVOLVE-001: a refusal that names a specific protocol condition
      // (EVOLUTION_REQUIRED) keeps its own code; the generic refusal stays
      // DECLARE_REFUSED.
      code:
        error.code ??
        (error.kind === "usage" ? "VALIDATION_ERROR" : "DECLARE_REFUSED"),
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
    .describe(
      "Table name (lowercase letters, digits, '-', '_'; schema.json rules apply)",
    ),
  columns: z
    .array(
      z.object({
        name: z.string().describe("Column name"),
        type: z
          .string()
          .describe(
            "Column type: varchar|integer|bigint|double|boolean|timestamp|json",
          ),
      }),
    )
    .min(1)
    .describe(
      "Declared columns; the first is the primary key unless `primary` is given",
    ),
  primary: z
    .string()
    .optional()
    .describe("Primary key column (must be one of `columns`)"),
  format: z
    .enum(["jsonl-objects", "jsonl-positional"])
    .optional()
    .describe("Row shape (default jsonl-objects)"),
  policy: z
    .object({
      read: z
        .object({ column: z.string(), equals: z.string() })
        .optional()
        .describe(
          "Row-level READ policy: { column, equals } — equals is a literal or .id/.name",
        ),
      write: z
        .object({ column: z.string(), equals: z.string() })
        .optional()
        .describe(
          "Row-level WRITE policy: { column, equals } — equals is a literal or .id/.name",
        ),
    })
    .optional()
    .describe(
      "RLS-001 row policy declared with the columns: which ROWS a read/write may touch, after the table grant",
    ),
  legacy: z
    .boolean()
    .optional()
    .describe(
      "Write tables/<table>.table.json instead of the SUPA-6 schema.json",
    ),
  force: z
    .boolean()
    .optional()
    .describe(
      "Replace an existing declaration of the same table with a different contract. Refused 409 EVOLUTION_REQUIRED when the table holds rows (use tables_alter to evolve it); allowed when the table is empty.",
    ),
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
      ...(args.policy !== undefined ? { policy: args.policy } : {}),
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
// tables_alter (DDL-EVOLVE-001)
// ---------------------------------------------------------------------------

const DECLARED_TYPE_ENUM = [...DECLARED_TYPES] as [string, ...string[]];

const TableAlterInputSchema = z.object({
  namespace: NamespaceArg,
  table: z.string().describe("Declared table name"),
  op: z
    .string()
    .min(1)
    .describe("Evolution operation: addColumn | retypeColumn"),
  column: z
    .union([z.string(), z.record(z.string(), z.unknown())])
    .optional()
    .describe(
      "addColumn: the new column object {name, type, nullable, default?}. retypeColumn: the existing column NAME.",
    ),
  type: z
    .enum(DECLARED_TYPE_ENUM)
    .optional()
    .describe(
      "Target declared type (addColumn: the column's type; retypeColumn: the type to retype to).",
    ),
  nullable: z.boolean().optional().describe("addColumn: explicit nullable flag"),
  default: z
    .unknown()
    .optional()
    .describe("addColumn: optional declared default value"),
  policy: z
    .enum(["null", "default", "materialize"])
    .optional()
    .describe(
      "addColumn backfill policy (default is derived when omitted). retypeColumn always materializes.",
    ),
});

/** The alter tool's success payload: the DDL result's public fields. */
function alterOutput(result: DdlResult): Record<string, unknown> {
  return {
    success: true,
    operation: result.operation,
    namespace: result.ns,
    ...(result.table !== undefined ? { table: result.table } : {}),
    schemaVersion: result.schemaVersion,
    documentHash: result.documentHash,
    ...(result.generation ? { generation: result.generation } : {}),
    ...(result.idempotentReplay ? { idempotentReplay: true } : {}),
  };
}

/**
 * Evolve a declared table — the MCP twin of `duckbrain tables alter` and the
 * HTTP alter route (DDL-EVOLVE-001). Both ops run through the ONE production
 * DDL coordinator (src/serialization/ddl.ts addColumn / retypeColumn): fence,
 * journal, generation materialization and the atomic schema switch are all
 * the coordinator's, never duplicated here.
 *
 * Refusals keep the same vocabulary on every surface: an op the coordinator
 * does not implement (drop / rename / key change / view declaration) answers
 * 400-equivalent OP_UNSUPPORTED, and a view declaration specifically answers
 * VIEW_UNSUPPORTED because no route serves declared views yet.
 */
export async function tablesAlterTool(
  input: unknown,
  context?: McpToolContext,
): Promise<Record<string, unknown>> {
  const parsed = TableAlterInputSchema.safeParse(input);
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

  const unsupported = (code: string, message: string): Record<string, unknown> => ({
    success: false,
    code,
    error: message,
  });
  if (args.op !== "addColumn" && args.op !== "retypeColumn") {
    if (args.op === "declareView")
      return unsupported(
        "VIEW_UNSUPPORTED",
        "declareView is not reachable on the alter surface: declared views are not served by any route yet (DDL-EVOLVE-001 keeps them coordinator-internal).",
      );
    return unsupported(
      "OP_UNSUPPORTED",
      `table evolution op '${args.op}' is not supported in v1 (allowed: addColumn, retypeColumn; drop/rename/key changes are refused — every other change needs a new table name)`,
    );
  }
  if (args.op === "addColumn") {
    if (typeof args.column !== "object" || args.column === null || Array.isArray(args.column))
      return unsupported(
        "VALIDATION_ERROR",
        "addColumn requires `column` as an object {name, type, nullable, default?}",
      );
    const raw = args.column as Record<string, unknown>;
    const name = raw.name;
    const type = raw.type ?? args.type;
    const nullable = raw.nullable ?? args.nullable;
    if (typeof name !== "string" || name.length === 0)
      return unsupported(
        "VALIDATION_ERROR",
        "addColumn requires the new column's name",
      );
    if (typeof type !== "string" || !isDeclaredTypeValue(type))
      return unsupported(
        "VALIDATION_ERROR",
        `addColumn requires a declared type for the new column (one of ${DECLARED_TYPES.join("|")})`,
      );
    if (typeof nullable !== "boolean")
      return unsupported(
        "VALIDATION_ERROR",
        `addColumn requires an explicit nullable flag for column '${name}'`,
      );
    const column: {
      name: string;
      type: DeclaredColumnType;
      nullable: boolean;
      default?: unknown;
    } = { name, type: type as DeclaredColumnType, nullable };
    if (raw.default !== undefined) column.default = raw.default;
    else if (args.default !== undefined) column.default = args.default;
    try {
      const result = await addColumn(
        namespace,
        {
          table: args.table,
          column,
          ...(args.policy !== undefined ? { policy: args.policy } : {}),
        },
        { principal: resolveToolPrincipal(context) },
      );
      return alterOutput(result);
    } catch (error) {
      return refusalFromError(error);
    }
  }
  // retypeColumn
  if (typeof args.column !== "string")
    return unsupported(
      "VALIDATION_ERROR",
      "retypeColumn requires `column` to be the NAME of an existing column",
    );
  if (args.type === undefined)
    return unsupported(
      "VALIDATION_ERROR",
      "retypeColumn requires `type` (the target declared type)",
    );
  try {
    const result = await retypeColumn(
      namespace,
      {
        table: args.table,
        column: args.column,
        type: args.type as DeclaredColumnType,
        policy: "materialize",
      },
      { principal: resolveToolPrincipal(context) },
    );
    return alterOutput(result);
  } catch (error) {
    return refusalFromError(error);
  }
}

function isDeclaredTypeValue(value: string): boolean {
  return (DECLARED_TYPES as readonly string[]).includes(value);
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
      // RLS-001: a row-policy refusal is audited to the SAME sink a REST 403
      // uses, so the MCP transport cannot refuse silently.
      resolveToolDenialAuditor(context),
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
      "PostgREST filters: {column: 'op.value'} with op ∈ eq|ne|neq|gt|gte|lt|lte|like|ilike|in|is|isdistinct|fts|plfts, each optionally prefixed not. (in takes 'in.(a,b)'; fts/plfts take literal terms)",
    ),
  order: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe("Order: 'col.asc' or 'col.desc' (repeatable)"),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max rows (hard cap 1000)"),
  offset: z.number().int().nonnegative().optional().describe("Rows to skip"),
  count: z
    .enum(["exact"])
    .optional()
    .describe("count=exact → return totalCount for the filter"),
  select: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe(
      "Projection: '*' or comma-separated declared columns; use relation(*) for a declared embed",
    ),
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
    const filters = filterParams({ ...(args.filters ?? {}) }, declaration);
    const { rows, totalCount } = await selectTableRows(namespace, args.table, {
      filters,
      order: args.order,
      limit: args.limit,
      offset: args.offset,
      wantCount: args.count === "exact",
      select: args.select,
      // RLS-001: the declared row policy applies to this transport too.
      principal: resolveToolPrincipal(context),
      auditPolicyDenial: resolveToolDenialAuditor(context),
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
      resolveToolDenialAuditor(context),
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
      resolveToolDenialAuditor(context),
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

export const tablesAlterToolDef = {
  name: "tables_alter",
  title: "Alter Declared Table",
  description:
    "Evolve a declared table through the production DDL coordinator: addColumn (new column with a pinned backfill policy) or retypeColumn (permitted type change, materialized). Refuses drop/rename/key changes and view declarations.",
  inputSchema: TableAlterInputSchema,
  handler: tablesAlterTool,
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
    "Read rows from a declared table with PostgREST-style filters, select projection (including declared relation embeds), order, limit/offset and an optional exact count.",
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

export {
  TableDeclareInputSchema,
  TableAlterInputSchema,
  TableInsertInputSchema,
  TableSelectInputSchema,
  TableUpdateInputSchema,
  TableDeleteInputSchema,
  QueryInputSchema,
};

/** Every data-plane tool, in registration order. */
export const tableToolDefs = [
  tableListToolDef,
  tablesDeclareToolDef,
  tablesAlterToolDef,
  tableInsertToolDef,
  tableSelectToolDef,
  tableUpdateToolDef,
  tableDeleteToolDef,
  queryToolDef,
];
