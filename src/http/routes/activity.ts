/**
 * Activity API Routes
 *
 * Returns recent memory activity across all namespaces.
 * Queries DuckDB JSONL files for recent memory entries, ordered by timestamp.
 */

import { Router, Request, Response } from "express";
import { getDuckDBConnection } from "../../duckdb/connection";
import { asyncHandler } from "../middleware/errorHandler";
import { deepConvertBigInts } from "../../utils/serialize";
import { resolveNamespacesPath } from "../../config/index";
import path from "path";
import fs from "fs";

const router: Router = Router();

/**
 * In-memory DuckDB connection for cross-namespace queries.
 * Created once and reused for the lifetime of the server.
 */
let crossNsDb: any = null;

function getCrossNsConnection(): any {
  if (!crossNsDb) {
    crossNsDb = getDuckDBConnection("per-query", ":memory:");
  }
  return crossNsDb;
}

/**
 * Parse DuckDB STRUCT format to object (same as queries.ts)
 */
function parseDuckDBStruct(structStr: string): Record<string, unknown> {
  if (!structStr || typeof structStr !== "string") return {};
  try {
    return JSON.parse(structStr);
  } catch {
    /* not JSON */
  }

  const result: Record<string, unknown> = {};
  const content = structStr
    .trim()
    .replace(/^\{|\}$/g, "")
    .trim();
  if (!content) return result;

  const pairs = content.split(",");
  for (const pair of pairs) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.substring(0, eqIndex).trim();
    let value = trimmed.substring(eqIndex + 1).trim();
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }
    if (
      (value.startsWith("{") && value.endsWith("}")) ||
      (value.startsWith("[") && value.endsWith("]"))
    ) {
      try {
        result[key] = JSON.parse(value);
      } catch {
        result[key] = value;
      }
    } else if (value === "true") {
      result[key] = true;
    } else if (value === "false") {
      result[key] = false;
    } else if (value === "null") {
      result[key] = null;
    } else if (!isNaN(Number(value)) && value !== "") {
      result[key] = Number(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Explicit read_json column schema (DOGFOOD-018 — mirrors the DOGFOOD-010
 * fix in src/duckdb/queries.ts).
 *
 * Auto-inference types a heterogeneous `attributes` object as MAP(...); when
 * a record's JSON object then contains duplicate keys (valid per RFC 8259,
 * produced by external writers — JSON.parse in-process silently collapses
 * them), MAP conversion fails with `duckdb::InvalidInputException: Map keys
 * must be unique.` thrown from native code. node-duckdb's
 * RunPreparedTask::DoWork() (the db.all() path) has NO try/catch around
 * Execute(), so the C++ throw escapes the libuv worker thread →
 * std::terminate → SIGABRT → whole process dies. A JS try/catch cannot help:
 * the exception never crosses back into JS.
 *
 * Forcing every column to VARCHAR means `attributes` arrives as RAW JSON TEXT
 * (parsed in JS by parseDuckDBStruct, which tries JSON.parse first) and no
 * MAP/STRUCT is ever built — duplicate keys become harmless. ignore_errors
 * converts any remaining per-record conversion error (e.g. a malformed JSON
 * line) into an all-NULL row, which the `action != 'tombstone'` filter drops,
 * instead of a native throw.
 */
const READ_JSON_COLUMNS =
  "columns={id:'VARCHAR', key:'VARCHAR', domain:'VARCHAR', timestamp:'VARCHAR', author:'VARCHAR', action:'VARCHAR', embedding_text:'VARCHAR', attributes:'VARCHAR'}";

/**
 * Namespace directories under the resolved root that carry a manifest.
 *
 * Used as a cheap gate: `read_json` over a glob that matches nothing raises,
 * and an absent/empty root must stay a clean empty feed (DOGFOOD-018).
 *
 * Resolved via resolveNamespacesPath() so the route honors the same env-only
 * overrides as the rest of the codebase (DUCKBRAIN_CONFIG_PATH GAP-022,
 * DUCKBRAIN_NAMESPACES_PATH BUG-037) and the same root the write paths use
 * (GAP-062: the directory owning duckbrain.config.json, never the caller's
 * cwd) — the test suite redirects namespace storage to a per-worker temp dir,
 * and this route must follow it instead of scanning the live ./namespaces tree.
 */
function collectNamespaceDirs(): string[] {
  // GAP-062: scan the root the writes use (the config file's own directory),
  // never a cwd-relative one.
  const nsPath = resolveNamespacesPath();
  if (!fs.existsSync(nsPath)) return [];

  const names: string[] = [];
  for (const nsName of fs.readdirSync(nsPath)) {
    const nsDir = path.join(nsPath, nsName);
    try {
      if (!fs.statSync(nsDir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!fs.existsSync(path.join(nsDir, "manifest.json"))) continue;
    names.push(nsName);
  }
  return names;
}

/**
 * One glob covering every namespace's JSONL segments.
 *
 * Replaces the previous `read_json([...122,000 quoted paths...])` form: on the
 * live store that single statement grew to ~8.9 MB of SQL, and it made
 * per-row namespace attribution impossible (the old code labelled EVERY row
 * with the namespace of `allFiles[0]`). A glob plus `filename=true` keeps the
 * statement tiny AND yields the source file per row, so each row can be
 * attributed to its real namespace.
 */
function namespaceRootGlob(): string {
  const nsPath = resolveNamespacesPath()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  return `${nsPath}/*/*/*/*.jsonl`;
}

/**
 * Namespace that owns a file, derived relative to the resolved root.
 *
 * Must be root-relative rather than "the path segment after /namespaces/" —
 * under an overridden root (DUCKBRAIN_NAMESPACES_PATH, as the test suite and
 * any isolated deployment use) there is no `namespaces` segment to key off.
 */
function namespaceFromFile(filePath: string, root: string): string {
  const rel = path.relative(root, filePath).replace(/\\/g, "/");
  const first = rel.split("/")[0];
  return first && first !== "" && first !== "." ? first : "default";
}

/**
 * Query recent memories across all namespaces.
 */
async function queryRecentActivity(limit: number): Promise<
  Array<{
    id: string;
    key: string;
    domain: string;
    timestamp: string;
    author: string;
    action: string;
    content: string;
    attributes: Record<string, unknown>;
    namespace: string;
  }>
> {
  const nsDirs = collectNamespaceDirs();
  if (nsDirs.length === 0) return [];

  const db = getCrossNsConnection();
  const root = resolveNamespacesPath();
  const glob = namespaceRootGlob().replace(/'/g, "''");

  return new Promise((resolve) => {
    const sql = `
      SELECT id, key, domain, timestamp, author, action, embedding_text, attributes, filename
      FROM read_json(['${glob}'], filename=true, format='newline_delimited', ignore_errors=true, ${READ_JSON_COLUMNS})
      WHERE action != 'tombstone'
      ORDER BY timestamp DESC
      LIMIT ${Math.min(limit, 200)}
    `;

    try {
      db.all(sql, (err: any, result: any) => {
        if (err || !result || !Array.isArray(result)) {
          resolve([]);
          return;
        }

        resolve(
          (result as any[]).map((row: any) =>
            deepConvertBigInts({
              id: row.id,
              key: row.key,
              domain: row.domain,
              timestamp: row.timestamp,
              author: row.author,
              action: row.action,
              content: row.embedding_text || "",
              attributes:
                typeof row.attributes === "string"
                  ? parseDuckDBStruct(row.attributes)
                  : row.attributes || {},
              // Per-row, from the file the row was read out of. The previous
              // implementation labelled every row with allFiles[0]'s namespace.
              namespace: row.filename
                ? namespaceFromFile(row.filename, root)
                : "default",
            }),
          ),
        );
      });
    } catch {
      resolve([]);
    }
  });
}

/**
 * GET /activity
 * Returns recent memory activity across all namespaces.
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(
      parseInt((req.query.limit as string) || "50", 10) || 50,
      200,
    );

    const activities = await queryRecentActivity(limit);

    res.json({
      activities,
      count: activities.length,
      limit,
    });
  }),
);

export { router as createActivityRoutes };
export default router;
