/**
 * Generic table→REST resource layer (DB-SUPA-3)
 *
 * Exposes DECLARED tables (src/schema/table-registry.ts) under
 * /api/ns/:ns/tables with PostgREST conventions:
 *
 *   GET    /api/ns/:ns/tables                 — list declared tables
 *   GET    /api/ns/:ns/tables/:table          — SELECT with col=op.value
 *                                              filters (eq/ne/gt/gte/lt/
 *                                              lte/like/in), order=col.asc|
 *                                              col.desc, limit/offset
 *                                              (hard cap 1000, clamped),
 *                                              Prefer: count=exact →
 *                                              X-Total-Count,
 *                                              Accept: text/csv → CSV
 *   POST   /api/ns/:ns/tables/:table          — insert (JSON object /
 *                                              array / NDJSON)
 *   PATCH  /api/ns/:ns/tables/:table?pk=eq.v  — update rows by primary key
 *   DELETE /api/ns/:ns/tables/:table?pk=eq.v  — delete rows by primary key
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
 */

import { Router, Request, Response } from "express";
import { asyncHandler, ApiError } from "../middleware/errorHandler";
import { requireNamespaceGrant, getPrincipal } from "../../auth/middleware";
import {
  listTables,
  getTable,
  type TableDeclaration,
} from "../../schema/table-registry";
import {
  buildSelectPlan,
  executeSelectPlan,
  coerceRowAgainstDeclaration,
  appendRowsToTable,
  patchRowsByPk,
  deleteRowsByPk,
  type MutationWriter,
} from "../../duckdb/table-store";
import { namespaceDir } from "../../schema/table-registry";
import { getNamespaceWriter } from "../../serialization/namespaceWriter";
import {
  assertNamespaceDdlUsable,
  partitionForStoragePath,
} from "../../serialization/ddl";
import { assertNamespaceSchemaUsable } from "../../serialization/schemaRegistry";
import { storedRowFromApiRow } from "../../serialization/schemaTypes";

/** Express 5 types named params as string | string[] (GAP-002 pattern). */
function param(req: Request, name: string): string {
  const p: unknown = req.params[name];
  return Array.isArray(p) ? p.join("/") : String(p ?? "");
}

/** Extract only the querystring entries that look like column filters. */
function filterParams(
  req: Request,
  declaration: TableDeclaration,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(req.query)) {
    if (
      key === "order" ||
      key === "limit" ||
      key === "offset" ||
      key === "count" ||
      key === "pk"
    ) {
      continue;
    }
    if (!declaration.columns.some((c) => c.name === key)) {
      // Unknown querystring key: only an error when it carries a filter
      // operator shape (col.op.value) — bare unknown keys are ignored so
      // clients can pass tracing/cache-busting params.
      const first = Array.isArray(value) ? String(value[0]) : String(value);
      if (/^[a-z]+\./.test(first)) {
        throw new ApiError(
          `Unknown filter column '${key}' (table '${declaration.name}' declares: ${declaration.columns.map((c) => c.name).join(", ")})`,
          400,
          "VALIDATION_ERROR",
        );
      }
      continue;
    }
    out[key] = Array.isArray(value)
      ? (value as string[]).map(String)
      : String(value);
  }
  return out;
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
      description: `Filter by ${col.name}. PostgREST conventions: eq|ne|gt|gte|lt|lte|like|in (e.g. ?${col.name}=eq.5, ?${col.name}=in.(a,b,c)).`,
      required: false,
      schema: { type: "string" },
    });
  }
  params.push(
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

function generateOpenApi(ns: string): Record<string, unknown> {
  const tables = listTables(ns);
  const paths: Record<string, unknown> = {};
  for (const declaration of tables) {
    paths[`/api/ns/${ns}/tables/${declaration.name}`] =
      tablePathItem(declaration);
  }

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

  return {
    openapi: "3.1.0",
    info: {
      title: `DuckBrain tables — namespace '${ns}'`,
      version: "1.0.0",
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

  /**
   * GET /api/ns/:ns/tables — list declared tables in the namespace.
   */
  router.get(
    "/",
    requireNamespaceGrant((req) => param(req, "ns")),
    asyncHandler(async (req: Request, res: Response) => {
      const ns = param(req, "ns");
      const tables = listTables(ns).map((t) => ({
        name: t.name,
        format: t.format,
        columns: t.columns,
        primary: t.primary,
        glob: t.glob,
      }));
      res.json({ namespace: ns, tables });
    }),
  );

  /**
   * GET /api/ns/:ns/tables/:table — SELECT with PostgREST conventions.
   */
  router.get(
    "/:table",
    requireNamespaceGrant((req) => param(req, "ns")),
    asyncHandler(async (req: Request, res: Response) => {
      const ns = param(req, "ns");
      const tableName = param(req, "table");
      const declaration = getTable(ns, tableName);
      const plan = buildSelectPlan(declaration, {
        filters: filterParams(req, declaration),
        order: req.query.order as string | string[] | undefined,
        limit: req.query.limit,
        offset: req.query.offset,
        wantCount: wantsExactCount(req),
      });
      const { rows: rawRows, totalCount } = await executeSelectPlan(
        namespaceDir(ns),
        declaration,
        plan,
      );
      // Declared json columns arrive as VARCHAR text (DuckDB JSON→VARCHAR
      // projection); parse them back into real JSON values so responses
      // carry actual JSON, matching what was inserted.
      const jsonCols = declaration.columns
        .filter((c) => c.type === "json")
        .map((c) => c.name);
      const rows = rawRows.map((row) => {
        if (jsonCols.length === 0) return row;
        const shaped: Record<string, unknown> = { ...row };
        for (const name of jsonCols) {
          const cell = shaped[name];
          if (typeof cell === "string") {
            try {
              shaped[name] = JSON.parse(cell) as unknown;
            } catch {
              // leave raw text when it isn't valid JSON
            }
          }
        }
        return shaped;
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
   * POST /api/ns/:ns/tables/:table — insert (object / array / NDJSON).
   *
   * A DB-SUPA-6 `schema.json` declaration writes through the SUPA-2 serializer
   * (`NamespaceWriter.enqueue`) at the table's DECLARED storage path, so the
   * write rides the same validation → ordered write → audit/change-record →
   * commit path as every other durable row, and it observes the DDL fence: a
   * write attempted while a DDL operation holds the namespace lock receives the
   * retryable `SERIALIZER_LOCKED` result and writes nothing. Legacy
   * `tables/<table>.table.json` declarations keep the historical direct append.
   */
  router.post(
    "/:table",
    requireNamespaceGrant((req) => param(req, "ns")),
    asyncHandler(async (req: Request, res: Response) => {
      const ns = param(req, "ns");
      const tableName = param(req, "table");
      const declaration = getTable(ns, tableName);
      const rawRows = parseInsertRows(req);
      if (rawRows.length === 0) {
        throw new ApiError(
          "Insert body must contain at least one row",
          400,
          "VALIDATION_ERROR",
        );
      }
      const coerced = rawRows.map((row) =>
        coerceRowAgainstDeclaration(declaration, row),
      );
      // AUG-045: a row that omits (or nulls) the declared primary key would be
      // stored with id:null and become unreachable via the API — PATCH/DELETE
      // both require ?pk=eq.<value>. Validate ALL rows before any writer
      // enqueue / append so a bad batch inserts nothing (no partial inserts).
      if (declaration.primary) {
        for (const row of coerced) {
          const pkValue = row[declaration.primary];
          if (pkValue === undefined || pkValue === null || pkValue === "") {
            throw new ApiError(
              `Row is missing the required primary key '${declaration.primary}' for table '${declaration.name}'`,
              400,
              "VALIDATION_ERROR",
            );
          }
        }
      }
      if (declaration.source === "schema.json") {
        // Fail closed on a failed DDL recovery and on an invalid on-disk
        // schema before accepting new generic-table work.
        assertNamespaceDdlUsable(ns);
        assertNamespaceSchemaUsable(ns);
        const declaredColumns = declaration.columns.map((column) => ({
          name: column.name,
          type: column.declaredType!,
          nullable: column.nullable ?? true,
          ...(column.hasDefault ? { default: column.default } : {}),
        }));
        const writer = getNamespaceWriter(ns);
        const partition = partitionForStoragePath(declaration.glob);
        let inserted = 0;
        for (const row of coerced) {
          const record = storedRowFromApiRow(
            declaredColumns,
            declaration.format === "jsonl-positional" ? "positional" : "object",
            row,
          );
          const result = await writer.enqueue({
            ns,
            table: declaration.name,
            op: "insert",
            record,
            principal: getPrincipal(req),
            targetPath: declaration.glob,
            ...(partition ? { partitionPath: partition } : {}),
          });
          if (!result.ok) {
            const status =
              result.code === "VALIDATION_ERROR"
                ? 422
                : result.code === "NOT_FOUND"
                  ? 404
                  : result.code === "FORBIDDEN"
                    ? 403
                    : result.code === "SERIALIZER_LOCKED" ||
                        result.code === "SERIALIZER_FENCED" ||
                        result.code === "SERVER_SHUTTING_DOWN"
                      ? 503
                      : 500;
            if (result.retryAfter !== undefined)
              res.setHeader("Retry-After", String(result.retryAfter));
            throw new ApiError(result.message, status, result.code);
          }
          inserted += 1;
        }
        res.status(201).json({ inserted });
        return;
      }
      appendRowsToTable(namespaceDir(ns), declaration, coerced);
      res.status(201).json({ inserted: coerced.length });
    }),
  );

  /** Validate + resolve the pk=eq.<v> filter for PATCH/DELETE. */
  function requirePkFilter(
    declaration: TableDeclaration,
    req: Request,
  ): { col: TableDeclaration["columns"][number]; value: string } {
    if (!declaration.primary) {
      throw new ApiError(
        `Table '${declaration.name}' declares no primary key; PATCH/DELETE are not available`,
        400,
        "VALIDATION_ERROR",
      );
    }
    const col = declaration.columns.find(
      (c) => c.name === declaration.primary,
    )!;
    const pkRaw = req.query.pk;
    const pkValue = Array.isArray(pkRaw) ? pkRaw[0] : pkRaw;
    const pk = pkValue === undefined ? undefined : String(pkValue);
    if (pk === undefined) {
      throw new ApiError(
        "PATCH/DELETE require a primary key filter: ?pk=eq.<value>",
        400,
        "VALIDATION_ERROR",
      );
    }
    const m = pk.match(/^eq\.(.+)$/s) ?? (pk === "eq.null" ? null : null);
    if (!m) {
      throw new ApiError(
        "PATCH/DELETE require an equality filter on the primary key: ?pk=eq.<value>",
        400,
        "VALIDATION_ERROR",
      );
    }
    return { col, value: m[1]! };
  }

  /**
   * PATCH /api/ns/:ns/tables/:table?pk=eq.<v> — update by primary key.
   * Rewrites the matching JSONL file rows and enqueues the mutation through
   * the NamespaceWriter for audit/durability invariants (schema.json tables
   * only; legacy .table.json tables use direct file rewrite to match POST).
   */
  router.patch(
    "/:table",
    requireNamespaceGrant((req) => param(req, "ns")),
    asyncHandler(async (req: Request, res: Response) => {
      const ns = param(req, "ns");
      const tableName = param(req, "table");
      const declaration = getTable(ns, tableName);
      const { col, value } = requirePkFilter(declaration, req);
      const body = req.body;
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new ApiError(
          "PATCH body must be a JSON object of column values",
          400,
          "VALIDATION_ERROR",
        );
      }
      const unknownKeys = Object.keys(body as Record<string, unknown>).filter(
        (k) => !declaration.columns.some((c) => c.name === k),
      );
      if (unknownKeys.length > 0) {
        throw new ApiError(
          `Unknown column(s) in PATCH body: ${unknownKeys.join(", ")}`,
          400,
          "VALIDATION_ERROR",
        );
      }
      const coercedBody: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
        coercedBody[k] =
          v === null
            ? null
            : coerceRowAgainstDeclaration(declaration, { [k]: v })[k];
      }

      const mutationWriter: MutationWriter | undefined =
        declaration.source === "schema.json"
          ? {
              ns,
              enqueue: (input) =>
                getNamespaceWriter(ns).enqueue(input as never),
            }
          : undefined;

      const outcome = patchRowsByPk(
        namespaceDir(ns),
        declaration,
        col,
        value,
        coercedBody,
        {},
        mutationWriter,
      );
      res.setHeader(
        "X-Durability",
        process.env.DUCKBRAIN_DURABILITY_MODE || "buffered",
      );
      res.json({ updated: outcome.mutated });
    }),
  );

  /**
   * DELETE /api/ns/:ns/tables/:table?pk=eq.<v> — delete by primary key.
   * Rewrites the matching JSONL files with the row dropped and enqueues a
   * tombstone through the NamespaceWriter for audit trail (schema.json
   * tables only; legacy .table.json tables use direct file rewrite to match
   * POST).
   */
  router.delete(
    "/:table",
    requireNamespaceGrant((req) => param(req, "ns")),
    asyncHandler(async (req: Request, res: Response) => {
      const ns = param(req, "ns");
      const tableName = param(req, "table");
      const declaration = getTable(ns, tableName);
      const { col, value } = requirePkFilter(declaration, req);

      const mutationWriter: MutationWriter | undefined =
        declaration.source === "schema.json"
          ? {
              ns,
              enqueue: (input) =>
                getNamespaceWriter(ns).enqueue(input as never),
            }
          : undefined;

      const removed = deleteRowsByPk(
        namespaceDir(ns),
        declaration,
        col,
        value,
        mutationWriter,
      );
      res.setHeader(
        "X-Durability",
        process.env.DUCKBRAIN_DURABILITY_MODE || "buffered",
      );
      res.json({ deleted: removed });
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
