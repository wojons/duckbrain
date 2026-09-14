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
import { requireNamespaceGrant } from "../../auth/middleware";
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
} from "../../duckdb/table-store";
import { namespaceDir } from "../../schema/table-registry";

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

function generateOpenApi(ns: string): Record<string, unknown> {
  const tables = listTables(ns);
  const paths: Record<string, unknown> = {};
  for (const declaration of tables) {
    paths[`/api/ns/${ns}/tables/${declaration.name}`] =
      tablePathItem(declaration);
  }
  return {
    openapi: "3.1.0",
    info: {
      title: `DuckBrain tables — namespace '${ns}'`,
      version: "1.0.0",
      description:
        "Generated from the declared table registry (namespaces/<ns>/tables/*.table.json). PostgREST-style filters/order/paging on every table.",
    },
    paths,
    components: {},
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
   * Rewrites the matching JSONL file rows (append-log reality for v1).
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
      const outcome = patchRowsByPk(
        namespaceDir(ns),
        declaration,
        col,
        value,
        coercedBody,
      );
      res.json({ updated: outcome.mutated });
    }),
  );

  /**
   * DELETE /api/ns/:ns/tables/:table?pk=eq.<v> — delete by primary key.
   * Rewrites the matching JSONL files with the row dropped.
   */
  router.delete(
    "/:table",
    requireNamespaceGrant((req) => param(req, "ns")),
    asyncHandler(async (req: Request, res: Response) => {
      const ns = param(req, "ns");
      const tableName = param(req, "table");
      const declaration = getTable(ns, tableName);
      const { col, value } = requirePkFilter(declaration, req);
      const removed = deleteRowsByPk(namespaceDir(ns), declaration, col, value);
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
