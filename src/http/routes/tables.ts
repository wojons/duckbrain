/**
 * Generic table→REST resource layer (DB-SUPA-3)
 *
 * Exposes DECLARED tables (src/schema/table-registry.ts) under
 * /api/ns/:ns/tables with PostgREST conventions:
 *
 *   GET    /api/ns/:ns/tables                 — list declared tables
 *
 *   ADOPT-DECLARED-001: declaration itself has a network surface now —
 *   POST /api/ns/:ns/tables/:table/declare writes through the SAME core the
 *   CLI (`duckbrain tables declare`) and MCP (`tables_declare`) call —
 *   src/tables/declare.ts declareTable() — so an agent with an API key can
 *   create a table instead of needing a shell on the box. It is a SUB-RESOURCE
 *   of the table rather than the row-insert verb (POST /:table) because that
 *   verb is the data contract: overloading it would make an insert whose
 *   columns happened to look like a declaration write schema instead of rows.
 *   GET    /api/ns/:ns/tables/:table          — SELECT with col=op.value
 *                                              filters (eq/ne/neq/gt/gte/lt/
 *                                              lte/like/ilike/in/is/
 *                                              isdistinct/fts/plfts, each
 *                                              optionally not.-prefixed),
 *                                              order=col.asc|
 *                                              col.desc, limit/offset
 *                                              (hard cap 1000, clamped),
 *                                              Prefer: count=exact →
 *                                              X-Total-Count,
 *                                              Accept: text/csv → CSV
 *   POST   /api/ns/:ns/tables/:table          — insert (JSON object /
 *                                              array / NDJSON)
 *   PATCH  /api/ns/:ns/tables/:table?pk=eq.v  — update rows by primary key
 *   DELETE /api/ns/:ns/tables/:table?pk=eq.v  — delete rows by primary key
 *   PUT    /api/ns/:ns/tables/:table/:pk      — upsert one row by primary key
 *                                              (201 inserted / 200 updated,
 *                                              body carries which happened and
 *                                              the resulting row)
 *   POST   /api/ns/:ns/tables/_transaction    — ordered envelope of N
 *                                              mutations applied as a UNIT
 *                                              (all-or-nothing, one durability
 *                                              barrier, one change record per
 *                                              action, `applied:0` + the
 *                                              failing action on failure)
 *   GET    /api/ns/:ns/tables/:table?embed=…  — one-level embedding over a
 *                                              relation DECLARED in schema.json
 *                                              (`columns[].references`)
 *   GET    /api/ns/:ns/openapi.json           — OpenAPI 3.1 generated from
 *                                              the registry
 *
 * SQL values never enter SQL text: every value rides a `?` placeholder
 * through DuckDB prepared statements (src/duckdb/table-store.ts), and
 * identifier positions come from the declared schema (double-validated +
 * quoted). PATCH/DELETE rewrite the table's small JSONL files
 * (append-log reality for v1 — no query-rewrite engine, no WAL).
 *
 * Every route is wrapped in requireNamespaceGrant exactly like
 * namespaces.ts, so restricted tokens without a grant get 403.
 *
 * DB-SUPA-4-R2: the namespace grant is the OUTER scope; inside it every
 * table-DATA verb additionally runs requireTableGrant (read for GET /:table,
 * write for POST/PATCH/DELETE), so a role-aware token can no longer read a
 * table it holds no read grant for, nor destroy rows through PATCH/DELETE with
 * a read-only per-table grant. Denials stay on the middleware's own path (403
 * FORBIDDEN + audited). GET "/" (the declared-table LIST) deliberately stays on
 * requireNamespaceGrant alone: it returns registry metadata, not rows, and the
 * grant model has no wildcard table — a stored `tableGrants` map can only name
 * real tables (`/^[a-z0-9_./-]+$/`, src/auth/storeSchema.ts), so guarding the
 * list with a synthetic "*" grant would 403 every grant-bearing token with no
 * way to grant list access back. The openapi.json route is likewise
 * namespace-granted only: it is a spec document, not table data.
 *
 * DB-SUPA-2 AC-1 residual (documented gap): the DATA mutation path is still an
 * in-place rewrite of the table's JSONL file (`patchRowsByPk` /
 * `deleteRowsByPk` in src/duckdb/table-store.ts) — for legacy `.table.json`
 * tables AND for schema.json tables alike. Accepted mutations are now RECORDED
 * through the NamespaceWriter (single-writer audit + DB-SUPA-5 change record),
 * but the rows themselves do not travel through its append-only queue. Doing
 * that migration means superseded row versions stay in the data file, so every
 * read path needs version folding and DELETE stops removing lines; it is a
 * redesign of the table store, not a route change.
 * TODO(DB-SUPA-2-AC1): move table mutations onto append-only serializer writes
 * plus read-side version folding. Until then a rewrite-based delete's
 * tombstone resolves against the parent commit (src/http/realtime/replay.ts).
 *
 * SURFACE-MCP-DATA-001: the data verbs are NOT implemented here any more. The
 * handlers below are thin adapters over src/tables/operations.ts, which the MCP
 * tools (src/mcp/tools/tables.ts) call as well — one implementation, two
 * transports, identical validation and refusal text. What stays in this module
 * is HTTP-shaped only: querystring parsing, CSV rendering, durability headers
 * and the grant middleware chain.
 */

import { Router, Request, Response, NextFunction } from "express";
import { asyncHandler, ApiError } from "../middleware/errorHandler";
import {
  requireNamespaceGrant,
  requireTableGrant,
  getPrincipal,
  auditRequestDenial,
} from "../../auth/middleware";
import { authorizeTableAccess } from "../../auth/roles";
import { setDurabilityHeaders } from "../../storage/durability";
import {
  TABLE_COLUMN_TYPES,
  TABLE_FORMATS,
  listTables,
  type TableFormat,
  type TableDeclaration,
} from "../../schema/table-registry";
import {
  declareTable,
  TableDeclareError,
  type DeclareTableResult,
  type DeclareTableSpec,
} from "../../tables/declare";

import {
  deleteTableRows,
  filterParams,
  insertTableRows,
  listNamespaceTables,
  resolveTableDeclaration,
  runTableTransaction,
  selectTableRows,
  updateTableRows,
  upsertTableRow,
} from "../../tables/operations";

/** Express 5 types named params as string | string[] (GAP-002 pattern). */
function param(req: Request, name: string): string {
  const p: unknown = req.params[name];
  return Array.isArray(p) ? p.join("/") : String(p ?? "");
}

/** `Prefer: count=exact` header OR `?count=exact`. */
function wantsExactCount(req: Request): boolean {
  const prefer = req.headers["prefer"];
  if (typeof prefer === "string" && /count\s*=\s*exact/i.test(prefer)) {
    return true;
  }
  const q = req.query.count;
  return (Array.isArray(q) ? q[0] : q) === "exact";
}

// ---------------------------------------------------------------------------
// ADOPT-DECLARED-001 — declaration body
// ---------------------------------------------------------------------------

/** Keys a declaration body may carry; anything else is a typo, not a feature. */
const DECLARATION_BODY_KEYS = [
  "columns",
  "primary",
  "format",
  "policy",
  "legacy",
  "force",
] as const;

function badDeclaration(message: string): ApiError {
  return new ApiError(message, 400, "INVALID_DECLARATION");
}

/**
 * Turn an HTTP declaration body into the transport-neutral DeclareTableSpec.
 *
 * The shape mirrors the MCP `tables_declare` arguments exactly (columns:
 * [{name,type}], primary, format, legacy, force) so the two agent transports
 * accept the same document; validation of the VALUES stays in declareTable()
 * — this function only refuses shapes the core cannot even read, and refuses
 * unknown keys instead of silently ignoring them (`colums` would otherwise
 * declare nothing and report success).
 */
export function parseDeclarationBody(
  ns: string,
  table: string,
  body: unknown,
): DeclareTableSpec {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badDeclaration(
      "Declaration body must be a JSON object: {columns: [{name, type}], primary?, format?, legacy?, force?}",
    );
  }
  const record = body as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter(
    (key) => !(DECLARATION_BODY_KEYS as readonly string[]).includes(key),
  );
  if (unknownKeys.length > 0) {
    throw badDeclaration(
      `Unknown declaration field(s): ${unknownKeys.join(", ")} (expected ${DECLARATION_BODY_KEYS.join(", ")})`,
    );
  }
  if (!Array.isArray(record.columns) || record.columns.length === 0) {
    throw badDeclaration(
      "columns must be a non-empty array of {name, type} objects",
    );
  }
  const columns: Array<{ name: string; type: string }> = record.columns.map(
    (column, index) => {
      if (
        typeof column !== "object" ||
        column === null ||
        Array.isArray(column)
      ) {
        throw badDeclaration(`columns[${index}] must be a {name, type} object`);
      }
      const entry = column as Record<string, unknown>;
      const extra = Object.keys(entry).filter(
        (key) => key !== "name" && key !== "type",
      );
      if (extra.length > 0) {
        throw badDeclaration(
          `columns[${index}] has unknown field(s): ${extra.join(", ")}`,
        );
      }
      if (typeof entry.name !== "string" || entry.name.length === 0) {
        throw badDeclaration(
          `columns[${index}].name must be a non-empty string`,
        );
      }
      if (typeof entry.type !== "string") {
        throw badDeclaration(
          `columns[${index}].type must be a string (one of ${TABLE_COLUMN_TYPES.join("|")})`,
        );
      }
      return { name: entry.name, type: entry.type };
    },
  );

  const spec: DeclareTableSpec = { ns, table, columns };

  if (record.primary !== undefined) {
    if (typeof record.primary !== "string") {
      throw badDeclaration(
        "primary must be a string naming one of the columns",
      );
    }
    spec.primary = record.primary;
  }
  if (record.policy !== undefined) {
    // RLS-001: the shape is checked by declareTable() against the columns it
    // is about to declare; here we only refuse a value that is not an object.
    if (
      typeof record.policy !== "object" ||
      record.policy === null ||
      Array.isArray(record.policy)
    ) {
      throw badDeclaration("policy must be an object { read?, write? }");
    }
    spec.policy = record.policy;
  }
  if (record.format !== undefined) {
    if (
      typeof record.format !== "string" ||
      !(TABLE_FORMATS as readonly string[]).includes(record.format)
    ) {
      throw badDeclaration(
        `format must be one of ${TABLE_FORMATS.join("|")}, got '${String(record.format)}'`,
      );
    }
    spec.format = record.format as TableFormat;
  }
  for (const flag of ["legacy", "force"] as const) {
    if (record[flag] === undefined) continue;
    if (typeof record[flag] !== "boolean") {
      throw badDeclaration(`${flag} must be a boolean`);
    }
    spec[flag] = record[flag] as boolean;
  }
  return spec;
}

// ---------------------------------------------------------------------------
// CSV rendering
// ---------------------------------------------------------------------------

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  // json columns arrive parsed (objects/arrays) — serialize compactly.
  const s = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function renderCsv(
  declaration: TableDeclaration,
  rows: Record<string, unknown>[],
): string {
  const header = declaration.columns.map((c) => csvEscape(c.name)).join(",");
  const lines = rows.map((row) =>
    declaration.columns.map((c) => csvEscape(row[c.name])).join(","),
  );
  return [header, ...lines].join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------
// OpenAPI 3.1 generation (from the registry — never hand-written blobs)
// ---------------------------------------------------------------------------

function columnSchema(
  col: TableDeclaration["columns"][number],
): Record<string, unknown> {
  switch (col.type) {
    case "integer":
      return { type: "integer", format: "int32" };
    case "bigint":
      return { type: "integer", format: "int64" };
    case "double":
      return { type: "number", format: "double" };
    case "boolean":
      return { type: "boolean" };
    case "timestamp":
      return { type: "string", format: "date-time" };
    case "json":
      return {};
    default:
      return { type: "string" };
  }
}

/** One filter/query parameter description per declared column. */
function filterParameters(
  declaration: TableDeclaration,
): Record<string, unknown>[] {
  const params: Record<string, unknown>[] = [];
  for (const col of declaration.columns) {
    params.push({
      name: col.name,
      in: "query",
      description: `Filter by ${col.name}. PostgREST conventions: eq|ne|neq|gt|gte|lt|lte|like|ilike|in|is|isdistinct|fts|plfts, any of them negated with the not. prefix (e.g. ?${col.name}=eq.5, ?${col.name}=not.is.null, ?${col.name}=fts.alpha,beta). The full 25-operator coverage table is in docs/api/http-api.md.`,
      required: false,
      schema: { type: "string" },
    });
  }
  params.push(
    {
      name: "select",
      in: "query",
      description:
        "Projection: comma-separated declared columns; `*` selects all columns and `relation(*)` embeds a declared relation.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "order",
      in: "query",
      description:
        "Ordering: comma-separated col.asc / col.desc list (e.g. order=qty.desc,name.asc).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "limit",
      in: "query",
      description:
        "Row limit (default 100, hard cap 1000 — larger values clamp).",
      required: false,
      schema: { type: "integer", default: 100, maximum: 1000 },
    },
    {
      name: "offset",
      in: "query",
      description: "Row offset for paging.",
      required: false,
      schema: { type: "integer", minimum: 0 },
    },
    {
      name: "count",
      in: "query",
      description:
        "`count=exact` adds the X-Total-Count response header (same as Prefer: count=exact).",
      required: false,
      schema: { type: "string", enum: ["exact"] },
    },
  );
  return params;
}

function tablePathItem(declaration: TableDeclaration): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const col of declaration.columns) {
    properties[col.name] = columnSchema(col);
  }
  const rowSchema = {
    type: "object",
    properties,
    required: declaration.columns.filter(Boolean).map((c) => c.name),
  };
  return {
    get: {
      operationId: `list_${declaration.name}`,
      summary: `Select rows from '${declaration.name}'`,
      parameters: filterParameters(declaration),
      responses: {
        "200": {
          description: "Rows (JSON array, or CSV with Accept: text/csv)",
          content: {
            "application/json": {
              schema: { type: "array", items: rowSchema },
            },
            "text/csv": {
              schema: { type: "string" },
            },
          },
        },
      },
    },
    post: {
      operationId: `insert_${declaration.name}`,
      summary: `Insert row(s) into '${declaration.name}'`,
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              oneOf: [rowSchema, { type: "array", items: rowSchema }],
            },
          },
          "application/x-ndjson": {
            schema: { type: "string" },
          },
        },
      },
      responses: {
        "201": {
          description: "Inserted",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { inserted: { type: "integer" } },
              },
            },
          },
        },
      },
    },
    patch: {
      operationId: `update_${declaration.name}`,
      summary: `Update rows of '${declaration.name}' by primary key`,
      parameters: [
        {
          name: "pk",
          in: "query",
          description: `Required. Primary key equality filter: pk=eq.<value> on '${declaration.primary ?? "(none)"}'.`,
          required: true,
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: { "application/json": { schema: rowSchema } },
      },
      responses: { "200": { description: "Updated (rows mutated)" } },
    },
    delete: {
      operationId: `delete_${declaration.name}`,
      summary: `Delete rows of '${declaration.name}' by primary key`,
      parameters: [
        {
          name: "pk",
          in: "query",
          description: `Required. Primary key equality filter: pk=eq.<value> on '${declaration.primary ?? "(none)"}'.`,
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: { "200": { description: "Deleted (rows removed)" } },
    },
  };
}

/**
 * REST-ATOMICITY-001: the upsert resource (`/tables/:table/:pk`) as its own
 * path — a PUT to a key-addressed resource, not a verb on the collection.
 */
function tableUpsertPathItem(
  declaration: TableDeclaration,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const col of declaration.columns) {
    properties[col.name] = columnSchema(col);
  }
  const rowSchema = {
    type: "object",
    properties,
    required: declaration.columns.filter(Boolean).map((c) => c.name),
  };
  return {
    put: {
      operationId: `upsert_${declaration.name}`,
      summary: `Insert or replace one row of '${declaration.name}' by primary key`,
      parameters: [
        {
          name: "pk",
          in: "path",
          required: true,
          description: `Primary key value on '${declaration.primary ?? "(none)"}'.`,
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: { "application/json": { schema: rowSchema } },
      },
      responses: {
        "201": {
          description: "Inserted (outcome: inserted, body carries the row)",
        },
        "200": {
          description: "Replaced (outcome: updated, body carries the row)",
        },
        "409": apiErrorSchemaRef,
      },
    },
  };
}

/** REST-ATOMICITY-001: the ordered mutation envelope, per namespace. */
function transactionPathItem(): Record<string, unknown> {
  return {
    post: {
      operationId: "run_table_transaction",
      summary:
        "Apply an ordered list of table mutations as ONE unit (all-or-nothing)",
      description:
        "Every action is validated before anything is written. The envelope takes one durability barrier at commit and appends one change record per action. On failure nothing is applied: the response carries `applied: 0`, `rolledBack: true` and `failedAction`.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["actions"],
              properties: {
                actions: {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "object",
                    required: ["op", "table"],
                    properties: {
                      op: {
                        type: "string",
                        enum: ["insert", "update", "upsert", "delete"],
                      },
                      table: { type: "string" },
                      row: { type: "object", additionalProperties: true },
                      patch: { type: "object", additionalProperties: true },
                      pk: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description:
            "Applied — `applied`, `results[]` and the achieved durability",
        },
        "409": apiErrorSchemaRef,
        "413": apiErrorSchemaRef,
      },
    },
  };
}

/** SDK-PARITY-001: the declared-table registry itself, as a resource. */
function tableListPathItem(): Record<string, unknown> {
  return {
    get: {
      operationId: "list_tables",
      summary: "List the tables DECLARED in this namespace",
      description:
        "Registry metadata only (name, format, columns, primary, source) — no rows. Namespace-granted: the grant model has no wildcard table name.",
      responses: {
        "200": {
          description: "The namespace and its declared tables.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["namespace", "tables"],
                properties: {
                  namespace: { type: "string" },
                  tables: {
                    type: "array",
                    items: { $ref: "#/components/schemas/TableDeclaration" },
                  },
                },
              },
            },
          },
        },
        "403": apiErrorSchemaRef,
        "404": apiErrorSchemaRef,
      },
    },
  };
}

/**
 * SDK-PARITY-001: declaration as a sub-resource of the table (ADOPT-DECLARED-001
 * shipped the route; the document had not described it yet, so a generated
 * client could not have declared a table).
 */
function declareTablePathItem(): Record<string, unknown> {
  return {
    post: {
      operationId: "declare_table",
      summary: "Create or replace a table declaration",
      description:
        "Writes through the SAME core the CLI (`duckbrain tables declare`) and the MCP `tables_declare` tool call. 201 when the declaration is new, 200 when an identical contract already existed or `force` replaced it.",
      parameters: [
        {
          name: "table",
          in: "path",
          required: true,
          description: "Table name (must match /^[a-z0-9_-]+$/).",
          schema: { type: "string", pattern: "^[a-z0-9_-]+$" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/TableDeclarationRequest" },
          },
        },
      },
      responses: {
        "201": { description: "Declared (new contract)." },
        "200": {
          description: "Idempotent re-declare, or `force` replacement.",
        },
        "400": apiErrorSchemaRef,
        "403": apiErrorSchemaRef,
        "409": apiErrorSchemaRef,
      },
    },
  };
}

const apiErrorSchemaRef = {
  description: "Refused",
  content: {
    "application/json": { schema: { $ref: "#/components/schemas/ApiError" } },
  },
};

const memoryResponseSchema = {
  type: "object",
  required: [
    "id",
    "key",
    "domain",
    "content",
    "attributes",
    "timestamp",
    "author",
    "isTombstone",
    "action",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    key: { type: "string", pattern: "^/" },
    domain: {
      type: "string",
      enum: ["person", "event", "concept", "message", "config", "raw_note"],
    },
    content: { type: "string" },
    attributes: { type: "object", additionalProperties: true },
    timestamp: { type: "string", format: "date-time" },
    valid_from: { type: "string", format: "date-time" },
    valid_until: { type: "string", format: "date-time" },
    author: { type: "string", format: "email" },
    isTombstone: { type: "boolean" },
    action: { type: "string", enum: ["add", "update", "tombstone"] },
    score: { type: "number" },
    snippet: { type: "string" },
    highlightedSnippet: { type: "string" },
    namespace: { type: "string" },
    namespace_autocreated: { type: "boolean", const: true },
  },
};

const memoryRequestSchema = {
  type: "object",
  required: ["key", "domain", "content"],
  properties: {
    key: { type: "string", pattern: "^/" },
    domain: {
      type: "string",
      enum: ["person", "event", "concept", "message", "config", "raw_note"],
    },
    content: { type: "string" },
    attributes: { type: "object", additionalProperties: true },
    valid_from: { type: "string", format: "date-time" },
    valid_until: { type: "string", format: "date-time" },
    validFrom: { type: "string", format: "date-time" },
    validUntil: { type: "string", format: "date-time" },
    namespace: { type: "string" },
  },
};

const apiErrorSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: { type: "string" },
    code: { type: "string" },
    fields: { type: "object", additionalProperties: { type: "string" } },
  },
};

const memoryNamespaceParameter = {
  name: "namespace",
  in: "query",
  required: false,
  description:
    "Namespace to query or write. If omitted, the existing active/default namespace resolution applies.",
  schema: { type: "string" },
};

const memoryListParameters = [
  { name: "prefix", in: "query", schema: { type: "string" } },
  {
    name: "domain",
    in: "query",
    schema: {
      type: "string",
      enum: ["person", "event", "concept", "message", "config", "raw_note"],
    },
  },
  { name: "author", in: "query", schema: { type: "string" } },
  { name: "q", in: "query", schema: { type: "string" } },
  { name: "contains", in: "query", schema: { type: "string" } },
  {
    name: "allNamespaces",
    in: "query",
    schema: { type: "boolean", default: false },
  },
  {
    name: "after",
    in: "query",
    schema: { type: "string", format: "date-time" },
  },
  {
    name: "before",
    in: "query",
    schema: { type: "string", format: "date-time" },
  },
  { name: "between", in: "query", schema: { type: "string" } },
  { name: "as_of", in: "query", schema: { type: "string" } },
  {
    name: "historical",
    in: "query",
    schema: { type: "boolean", default: false },
  },
  {
    name: "limit",
    in: "query",
    schema: { type: "integer", minimum: 0, maximum: 1000, default: 50 },
  },
  {
    name: "offset",
    in: "query",
    schema: { type: "integer", minimum: 0, default: 0 },
  },
  {
    name: "attr.<name>",
    in: "query",
    description: "Attribute filter; replace <name> with the attribute name.",
    schema: { type: "string" },
  },
  memoryNamespaceParameter,
];

function memoryErrorResponse(description: string) {
  return {
    description,
    content: {
      "application/json": { schema: { $ref: "#/components/schemas/ApiError" } },
    },
  };
}

/**
 * SDK-PARITY-001: exported, and the declared-table set is INJECTABLE.
 * The route calls it with the live registry; the SDK generator and its
 * drift test call it with a fixed fixture set so the published document
 * (and therefore the checked-in client) is reproducible on any machine,
 * with no data directory and no daemon.
 */
export function generateOpenApi(
  ns: string,
  tablesOverride?: TableDeclaration[],
): Record<string, unknown> {
  const tables = tablesOverride ?? listTables(ns);
  const paths: Record<string, unknown> = {};
  for (const declaration of tables) {
    paths[`/api/ns/${ns}/tables/${declaration.name}`] =
      tablePathItem(declaration);
    // REST-ATOMICITY-001: the key-addressed upsert resource, when the table has
    // a single primary key (`{pk}` needs one addressable column).
    if (declaration.primary !== null) {
      paths[`/api/ns/${ns}/tables/${declaration.name}/{pk}`] =
        tableUpsertPathItem(declaration);
    }
  }
  paths[`/api/ns/${ns}/tables/_transaction`] = transactionPathItem();
  paths[`/api/ns/${ns}/tables`] = tableListPathItem();
  paths[`/api/ns/${ns}/tables/{table}/declare`] = declareTablePathItem();

  // These are the existing global memory routes. They intentionally keep
  // their namespace query/body semantics; the namespace in this document
  // scopes the declared table paths above and does not rewrite memory calls.
  paths["/api/memories"] = {
    get: {
      operationId: "listMemories",
      summary: "List memories",
      description:
        "Query memories. Namespace selection remains the existing optional namespace query parameter.",
      parameters: memoryListParameters,
      responses: {
        "200": {
          description: "A paginated memory list.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/MemoryListResponse" },
            },
          },
        },
        "400": memoryErrorResponse("Invalid query parameters."),
        "403": memoryErrorResponse(
          "The caller is not authorized for this memory namespace.",
        ),
        "503": memoryErrorResponse("Semantic search is unavailable."),
        "500": memoryErrorResponse("The memory query failed."),
      },
    },
    post: {
      operationId: "createMemory",
      summary: "Create a memory",
      description:
        "Create a memory. The namespace query parameter takes precedence over the optional body namespace field.",
      parameters: [memoryNamespaceParameter],
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: memoryRequestSchema },
        },
      },
      responses: {
        "201": {
          description: "The created memory.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/MemoryResponse" },
            },
          },
        },
        "400": memoryErrorResponse("The request body is invalid."),
        "403": memoryErrorResponse(
          "The caller is not authorized for this memory namespace.",
        ),
        "404": memoryErrorResponse("The target namespace does not exist."),
        "500": memoryErrorResponse("The memory could not be created."),
      },
    },
  };
  paths["/api/memories/key/{key}"] = {
    get: {
      operationId: "getMemoryByKey",
      summary: "Get the latest memory by key",
      parameters: [
        {
          name: "key",
          in: "path",
          required: true,
          description:
            "Filesystem-style memory key without the leading slash; slash-separated segments are accepted.",
          schema: { type: "string" },
        },
        memoryNamespaceParameter,
      ],
      responses: {
        "200": {
          description: "The latest non-tombstoned memory for the key.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/MemoryResponse" },
            },
          },
        },
        "404": memoryErrorResponse("No memory exists for the key."),
        "403": memoryErrorResponse(
          "The caller is not authorized for this memory namespace.",
        ),
        "500": memoryErrorResponse("The memory lookup failed."),
      },
    },
  };

  // SDK-PARITY-001: the rest of the memory resource, and the SSE feed. The
  // routes already answer these verbs (src/http/routes/memories.ts,
  // src/http/routes/events.ts); the document simply did not describe them, so
  // no generated client could call them. Document catching up with the
  // routing table — not a new surface.
  paths["/api/memories/{id}"] = {
    get: {
      operationId: "getMemory",
      summary: "Get one memory by id",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          description: "Memory id (UUID).",
          schema: { type: "string", format: "uuid" },
        },
        memoryNamespaceParameter,
      ],
      responses: {
        "200": {
          description: "The memory.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/MemoryResponse" },
            },
          },
        },
        "404": memoryErrorResponse("No memory exists for the id."),
        "403": memoryErrorResponse(
          "The caller is not authorized for this memory namespace.",
        ),
        "500": memoryErrorResponse("The memory lookup failed."),
      },
    },
    put: {
      operationId: "updateMemory",
      summary:
        "Update a memory (new version; the previous version stays in the ledger)",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          description: "Memory id (UUID).",
          schema: { type: "string", format: "uuid" },
        },
        memoryNamespaceParameter,
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/MemoryUpdateRequest" },
          },
        },
      },
      responses: {
        "200": {
          description: "The NEW memory version (the updated row).",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/MemoryResponse" },
            },
          },
        },
        "400": memoryErrorResponse("No update data, or invalid content."),
        "404": memoryErrorResponse("No memory exists for the id."),
        "403": memoryErrorResponse(
          "The caller is not authorized for this memory namespace.",
        ),
        "500": memoryErrorResponse("The memory could not be updated."),
      },
    },
    delete: {
      operationId: "deleteMemory",
      summary: "Delete a memory (writes a tombstone; nothing is erased)",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          description: "Memory id (UUID).",
          schema: { type: "string", format: "uuid" },
        },
        memoryNamespaceParameter,
      ],
      responses: {
        "204": { description: "Tombstone written; no body." },
        "404": memoryErrorResponse("No memory exists for the id."),
        "403": memoryErrorResponse(
          "The caller is not authorized for this memory namespace.",
        ),
        "500": memoryErrorResponse("The tombstone could not be written."),
      },
    },
  };

  paths["/api/events/{namespace}"] = {
    get: {
      operationId: "streamEvents",
      summary: "Server-Sent Events feed for a namespace",
      description:
        "Long-lived text/event-stream. The first frame is {type:'connected', timestamp, namespace}; later frames carry memory/table activity for that namespace.",
      parameters: [
        {
          name: "namespace",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description:
            "SSE stream of JSON frames (one `data:` line per frame).",
          content: {
            "text/event-stream": { schema: { type: "string" } },
          },
        },
        "403": memoryErrorResponse(
          "The caller is not authorized for this memory namespace.",
        ),
      },
    },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: `DuckBrain tables — namespace '${ns}'`,
      version: "1.1.0",
      description:
        "Generated from the declared table registry (namespaces/<ns>/tables/*.table.json). PostgREST-style filters/order/paging on every table. This namespace document also describes the global memory routes; those routes retain their existing namespace query/body behavior.",
    },
    paths,
    components: {
      schemas: {
        MemoryResponse: memoryResponseSchema,
        MemoryRequest: memoryRequestSchema,
        MemoryListResponse: {
          type: "object",
          required: [
            "items",
            "total",
            "offset",
            "limit",
            "hasMore",
            "nextOffset",
            "count",
            "memories",
          ],
          properties: {
            items: {
              type: "array",
              items: { $ref: "#/components/schemas/MemoryResponse" },
            },
            total: { type: "integer", minimum: 0 },
            offset: { type: "integer", minimum: 0 },
            limit: { type: "integer", minimum: 0 },
            hasMore: { type: "boolean" },
            nextOffset: { type: ["integer", "null"], minimum: 0 },
            count: { type: "integer", minimum: 0 },
            memories: {
              type: "array",
              items: { $ref: "#/components/schemas/MemoryResponse" },
            },
          },
        },
        ApiError: apiErrorSchema,
        // SDK-PARITY-001: request/registry shapes the paths above reference.
        MemoryUpdateRequest: {
          type: "object",
          properties: {
            content: { type: "string" },
            attributes: { type: "object", additionalProperties: true },
          },
          description:
            "At least one of content/attributes is required; the server answers 400 VALIDATION_ERROR otherwise.",
        },
        TableDeclaration: {
          type: "object",
          required: ["name", "format", "columns", "primary", "glob"],
          properties: {
            name: { type: "string" },
            format: {
              type: "string",
              enum: ["jsonl-objects", "jsonl-positional"],
            },
            columns: {
              type: "array",
              items: {
                type: "object",
                required: ["name", "type"],
                properties: {
                  name: { type: "string" },
                  type: {
                    type: "string",
                    enum: [
                      "varchar",
                      "integer",
                      "bigint",
                      "double",
                      "boolean",
                      "timestamp",
                      "json",
                    ],
                  },
                },
              },
            },
            primary: { type: ["string", "null"] },
            glob: { type: "string" },
            declaredKeyColumns: { type: "array", items: { type: "string" } },
            schemaVersion: { type: "integer" },
            source: { type: "string", enum: ["schema.json", "legacy"] },
          },
        },
        TableDeclarationRequest: {
          type: "object",
          required: ["columns"],
          properties: {
            columns: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                required: ["name", "type"],
                properties: {
                  name: { type: "string" },
                  type: { type: "string" },
                },
              },
            },
            primary: { type: "string" },
            format: {
              type: "string",
              enum: ["jsonl-objects", "jsonl-positional"],
            },
            policy: { type: "object", additionalProperties: true },
            legacy: { type: "boolean" },
            force: { type: "boolean" },
          },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

function createTableRoutes(): Router {
  // mergeParams: the :ns lives on the MOUNT path (see cli/http.ts); without
  // this, req.params.ns is invisible inside the route handlers.
  const router: Router = Router({ mergeParams: true });

  // DB-SUPA-4-R2: the namespace the per-table grant grades is the SAME value
  // the handlers below and requireNamespaceGrant use — `:ns` off the mount
  // path (mergeParams). memories.ts resolves its namespace from
  // query/body/default because ITS mount carries no :ns; copying that
  // resolver here would grade a different namespace than the route touches
  // (the DF-0926-04 hazard class), so the table surface takes the param.
  const grantNs = (req: Request): string => param(req, "ns");
  const grantTable = (req: Request): string => param(req, "table");

  /**
   * GET /api/ns/:ns/tables — list declared tables in the namespace.
   *
   * DB-SUPA-4-R2: namespace-scope only — this returns registry metadata, not
   * rows, and the grant model has no wildcard table name (see the module
   * header). The per-table READ grant is enforced on GET /:table.
   */
  router.get(
    "/",
    requireNamespaceGrant((req) => param(req, "ns")),
    asyncHandler(async (req: Request, res: Response) => {
      const ns = param(req, "ns");
      res.json({ namespace: ns, tables: listNamespaceTables(ns) });
    }),
  );

  /**
   * GET /api/ns/:ns/tables/:table — SELECT with PostgREST conventions.
   */
  router.get(
    "/:table",
    requireNamespaceGrant((req) => param(req, "ns")),
    requireTableGrant(grantNs, grantTable, "read"),
    asyncHandler(async (req: Request, res: Response) => {
      const ns = param(req, "ns");
      const tableName = param(req, "table");
      const declaration = resolveTableDeclaration(ns, tableName);
      const { rows, totalCount } = await selectTableRows(ns, tableName, {
        // SURFACE-MCP-DATA-001: the same filter/order/paging vocabulary the
        // MCP table_select tool passes, so both transports answer identically.
        filters: filterParams(
          req.query as Record<string, unknown>,
          declaration,
        ),
        // RLS-001: the declared row policy is graded for THIS principal after
        // the table grant above; excluded rows never reach the response,
        // X-Total-Count or CSV rendering.
        principal: getPrincipal(req),
        auditPolicyDenial: (event) => auditRequestDenial(req, event),
        order: req.query.order as string | string[] | undefined,
        limit: req.query.limit,
        offset: req.query.offset,
        wantCount: wantsExactCount(req),
        select: req.query.select as string | string[] | undefined,
        // REST-ATOMICITY-001: one-level embedding over DECLARED relations.
        embed: req.query.embed as string | string[] | undefined,
      });

      if (totalCount !== null) {
        res.setHeader("X-Total-Count", String(totalCount));
      }

      const accept = String(req.headers.accept ?? "");
      if (accept.includes("text/csv")) {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.send(renderCsv(declaration, rows));
        return;
      }
      res.json(rows);
    }),
  );

  /** Parse an insert body: single object / array / NDJSON → row list. */
  function parseInsertRows(req: Request): unknown[] {
    const contentType = String(req.headers["content-type"] ?? "");
    if (contentType.includes("application/x-ndjson")) {
      const text = typeof req.body === "string" ? req.body : "";
      if (!text.trim()) {
        throw new ApiError("NDJSON body required", 400, "VALIDATION_ERROR");
      }
      return text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          try {
            return JSON.parse(line) as unknown;
          } catch {
            throw new ApiError(
              `Invalid NDJSON line: ${line.slice(0, 80)}`,
              400,
              "VALIDATION_ERROR",
            );
          }
        });
    }
    const body = req.body;
    if (Array.isArray(body)) return body;
    if (typeof body === "object" && body !== null) return [body];
    throw new ApiError(
      "Insert body must be a JSON object or array (or NDJSON with Content-Type: application/x-ndjson)",
      400,
      "VALIDATION_ERROR",
    );
  }

  /**
   * POST /api/ns/:ns/tables/_transaction — run N mutations as ONE unit.
   *
   * REST-ATOMICITY-001 AC-2. Registered BEFORE `/:table` so a table route can
   * never shadow the envelope (declared table names must start with a letter,
   * so `_transaction` is not a name a table can take).
   *
   * A multi-table envelope cannot be authorized by the single-table
   * `requireTableGrant`: each action's table is checked for a WRITE grant here,
   * and a denial is audited on the same path as the single-table middleware.
   */
  const requireTransactionTableGrants = (
    req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    const principal = getPrincipal(req);
    if (!principal) return next();
    const ns = param(req, "ns");
    const body = req.body as { actions?: unknown } | undefined;
    const actions = Array.isArray(body?.actions) ? body.actions : [];
    for (const action of actions) {
      const table = (action as { table?: unknown } | null)?.table;
      if (typeof table !== "string") continue; // structure is validated later
      const decision = authorizeTableAccess(principal, ns, table, "write");
      if (!decision.allowed) {
        auditRequestDenial(req, {
          ns,
          table,
          op: "tables.write",
          principal: principal.name,
          reason: decision.reason,
        });
        res.status(403).json({ error: decision.message, code: "FORBIDDEN" });
        return;
      }
    }
    next();
  };

  router.post(
    "/_transaction",
    requireNamespaceGrant((req) => param(req, "ns")),
    requireTransactionTableGrants,
    asyncHandler(async (req: Request, res: Response) => {
      const ns = param(req, "ns");
      const body = req.body as { actions?: unknown } | undefined;
      const outcome = await runTableTransaction(
        ns,
        body?.actions,
        getPrincipal(req),
        {
          // RLS-001: row-policy denials inside the envelope audit on the same
          // path as the single-row verbs.
          auditPolicyDenial: (event) => auditRequestDenial(req, event),
        },
      );
      if (!outcome.ok) {
        res.status(outcome.status).json({
          error: outcome.message,
          code: outcome.code,
          failedAction: outcome.failedAction,
          action: outcome.action,
          applied: 0,
          rolledBack: outcome.rolledBack,
        });
        return;
      }
      setDurabilityHeaders(
        res,
        outcome.durability.configured,
        outcome.durability.achieved,
      );
      res.json({
        applied: outcome.applied,
        results: outcome.results,
        durability: outcome.durability.achieved,
      });
    }),
  );

  /**
   * PUT /api/ns/:ns/tables/:table/:pk — upsert one row by primary key.
   *
   * REST-ATOMICITY-001 AC-1: insert-or-replace in ONE serialized operation
   * under the namespace write lock, answering which branch ran plus the
   * resulting row (201 inserted / 200 updated).
   */
  router.put(
    "/:table/:pk",
    requireNamespaceGrant((req) => param(req, "ns")),
    requireTableGrant(grantNs, grantTable, "write"),
    asyncHandler(async (req: Request, res: Response) => {
      const ns = param(req, "ns");
      const tableName = param(req, "table");
      // Resolve first so an unknown table is a 404 before the body is judged.
      resolveTableDeclaration(ns, tableName);
      const body = req.body;
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new ApiError(
          "PUT body must be a JSON object of column values",
          400,
          "VALIDATION_ERROR",
        );
      }
      const rawPk = param(req, "pk");
      const pkFilter = rawPk.startsWith("eq.") ? rawPk : `eq.${rawPk}`;
      const result = await upsertTableRow(
        ns,
        tableName,
        pkFilter,
        body as Record<string, unknown>,
        getPrincipal(req),
        (event) => auditRequestDenial(req, event),
      );
      setDurabilityHeaders(
        res,
        result.durability.configured,
        result.durability.achieved,
      );
      res.status(result.outcome === "inserted" ? 201 : 200).json({
        outcome: result.outcome,
        inserted: result.outcome === "inserted",
        row: result.row,
      });
    }),
  );

  /**
   * POST /api/ns/:ns/tables/:table/declare — create/replace a table declaration.
   *
   * ADOPT-DECLARED-001: declaration was host-CLI-only (and then MCP-only), so
   * an agent on the network could not create the table it wanted to write to.
   * This route parses an HTTP declaration body into the transport-neutral
   * spec and calls declareTable() — the SAME core as `duckbrain tables declare`
   * and the MCP `tables_declare` tool. No second writer: the schema.json path
   * still validates before the atomic switch, journals under the DDL fence and
   * re-loads through the real registry loader.
   *
   * Authz is the namespace write grant plus the per-table write grant, exactly
   * like the row-insert verb — declaring is a write, and a token restricted to
   * specific tables cannot invent a new one.
   *
   * Status: 201 when the declaration is new, 200 when an identical contract
   * already existed (idempotent re-declare) or `force` replaced it. The body
   * carries the resulting declaration so the caller never has to GET it back.
   */
  router.post(
    "/:table/declare",
    requireNamespaceGrant((req) => param(req, "ns")),
    requireTableGrant(grantNs, grantTable, "write"),
    asyncHandler(async (req: Request, res: Response) => {
      const ns = param(req, "ns");
      const tableName = param(req, "table");
      const spec = parseDeclarationBody(ns, tableName, req.body);
      let result: DeclareTableResult;
      try {
        result = await declareTable(spec);
      } catch (error) {
        if (error instanceof TableDeclareError) {
          // `usage` → the request is malformed (400); `refusal` → the state on
          // disk refused a well-formed request (409). The message is the CLI's
          // own text, so all three surfaces refuse identically.
          throw error.kind === "refusal"
            ? new ApiError(error.message, 409, "DECLARATION_REFUSED")
            : new ApiError(error.message, 400, "INVALID_DECLARATION");
        }
        throw error;
      }
      let declaration: TableDeclaration | undefined;
      try {
        declaration = resolveTableDeclaration(ns, tableName);
      } catch {
        // The declaration is on disk and proven loadable by declareTable();
        // a registry miss here is a reporting gap, not a failed write.
        declaration = undefined;
      }
      res.status(result.replacedExisting ? 200 : 201).json({
        namespace: result.ns,
        table: result.table,
        path: result.path,
        format: result.format,
        replacedExisting: result.replacedExisting,
        ...(declaration ? { declaration } : {}),
      });
    }),
  );

  /**
   * POST /api/ns/:ns/tables/:table — insert (object / array / NDJSON).
   *
   * SURFACE-MCP-DATA-001: the write itself is insertTableRows() in
   * src/tables/operations.ts — the SAME implementation the MCP table_insert
   * tool calls. SUPA-6 writes ride the serializer (validation → ordered write
   * → audit/change record → commit, DDL fence honoured); legacy .table.json
   * declarations keep the direct append, now durability-honest.
   */
  router.post(
    "/:table",
    requireNamespaceGrant((req) => param(req, "ns")),
    requireTableGrant(grantNs, grantTable, "write"),
    asyncHandler(async (req: Request, res: Response) => {
      const ns = param(req, "ns");
      const tableName = param(req, "table");
      resolveTableDeclaration(ns, tableName);
      const rawRows = parseInsertRows(req);
      const { inserted, durability } = await insertTableRows(
        ns,
        tableName,
        rawRows,
        getPrincipal(req),
        (event) => auditRequestDenial(req, event),
      );
      setDurabilityHeaders(res, durability.configured, durability.achieved);
      res.status(201).json({ inserted });
    }),
  );

  /**
   * PATCH /api/ns/:ns/tables/:table?pk=eq.<v> — update by primary key.
   *
   * SURFACE-MCP-DATA-001: updateTableRows() in src/tables/operations.ts is the
   * one implementation (read-merge-rewrite under the namespace write lock plus
   * the DB-SUPA-5 change record before the 2xx); the MCP table_update tool
   * calls it too.
   */
  router.patch(
    "/:table",
    requireNamespaceGrant((req) => param(req, "ns")),
    requireTableGrant(grantNs, grantTable, "write"),
    asyncHandler(async (req: Request, res: Response) => {
      const ns = param(req, "ns");
      const tableName = param(req, "table");
      resolveTableDeclaration(ns, tableName);
      const body = req.body;
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new ApiError(
          "PATCH body must be a JSON object of column values",
          400,
          "VALIDATION_ERROR",
        );
      }
      const { updated, durability } = await updateTableRows(
        ns,
        tableName,
        req.query.pk,
        body as Record<string, unknown>,
        getPrincipal(req),
        (event) => auditRequestDenial(req, event),
      );
      setDurabilityHeaders(res, durability.configured, durability.achieved);
      res.json({ updated });
    }),
  );

  /**
   * DELETE /api/ns/:ns/tables/:table?pk=eq.<v> — delete by primary key.
   *
   * SURFACE-MCP-DATA-001: deleteTableRows() in src/tables/operations.ts is the
   * one implementation (rewrite under the lock, tombstone change record before
   * the 2xx); the MCP table_delete tool calls it too.
   */
  router.delete(
    "/:table",
    requireNamespaceGrant((req) => param(req, "ns")),
    requireTableGrant(grantNs, grantTable, "write"),
    asyncHandler(async (req: Request, res: Response) => {
      const ns = param(req, "ns");
      const tableName = param(req, "table");
      resolveTableDeclaration(ns, tableName);
      const { deleted, durability } = await deleteTableRows(
        ns,
        tableName,
        req.query.pk,
        getPrincipal(req),
        (event) => auditRequestDenial(req, event),
      );
      setDurabilityHeaders(res, durability.configured, durability.achieved);
      res.json({ deleted });
    }),
  );

  return router;
}

/**
 * GET /api/ns/:ns/openapi.json — OpenAPI 3.1 generated from the registry.
 * Mounted separately (its own prefix), because its path lives OUTSIDE the
 * /tables prefix and a shared router would shadow it with the GET "/" list
 * route.
 */
function createNamespaceOpenApiRoutes(): Router {
  const router: Router = Router({ mergeParams: true });
  router.get(
    "/",
    requireNamespaceGrant((req) => param(req, "ns")),
    asyncHandler(async (req: Request, res: Response) => {
      const ns = param(req, "ns");
      res.json(generateOpenApi(ns));
    }),
  );
  return router;
}

export { createTableRoutes, createNamespaceOpenApiRoutes };
export default createTableRoutes();
