/**
 * RETR-009: read-only SQL query surface (`duckbrain query "SELECT ..."`).
 *
 * Runs an operator-supplied SELECT against the memory store of one namespace
 * and returns the rows. The surface is deliberately narrow:
 *
 *   - STRICTLY READ-ONLY. The statement is validated before execution:
 *     the first keyword must be SELECT (or WITH ... SELECT), any mutating
 *     keyword anywhere in the statement is rejected (INSERT/UPDATE/DELETE/
 *     CREATE/DROP/ALTER/ATTACH/DETACH/COPY/PRAGMA/VACUUM/CALL/INSTALL/LOAD/
 *     SET/EXPORT/IMPORT/BEGIN/COMMIT/ROLLBACK/CHECKPOINT/PREPARE/EXECUTE/
 *     ANALYZE), multiple `;`-separated statements are rejected, and the
 *     `query()` / file-reading table functions (read_json_auto, read_csv,
 *     read_parquet, read_text, glob, sqlite_scan, ...) are blocked so the
 *     statement can only touch the namespace's own data — never arbitrary
 *     local files (namespace scoping).
 *   - LIMIT-CAPPED (GAP-023/024 doctrine). A statement without a top-level
 *     numeric LIMIT gets `LIMIT <cap>` appended (before a top-level OFFSET,
 *     if any); an oversized numeric LIMIT is clamped to the cap; `LIMIT ALL`
 *     and non-numeric LIMIT expressions are rejected outright. The default
 *     cap is QUERY_MAX_ROWS (1000), mirroring the HTTP layer's MAX_LIMIT.
 *
 * Data access: the namespace's *.jsonl files (recursive walk, skipping
 * .git/.embeddings/.search — same walk as the search index) are exposed to
 * the statement through a `memories` TEMP VIEW built with read_json_auto.
 * The view applies the SAME semantics as queryMemories (src/duckdb/queries.ts):
 * latest-record-per-id dedup (ROW_NUMBER() over timestamp DESC) with
 * tombstones excluded, so `duckbrain query` sees exactly what recall sees.
 *
 * read_json_auto is called WITH the explicit all-VARCHAR columns override
 * (READ_JSON_COLUMNS) — never bare. Bare read_json_auto auto-infers a
 * heterogeneous `attributes` object as MAP(...) and a stored object with
 * duplicate keys (valid RFC 8259, produced by external writers) then fails
 * MAP conversion with a native throw that SIGABRTs the whole process
 * (DOGFOOD-010/018/019 crash class). The columns override keeps `attributes`
 * as RAW JSON TEXT, so duplicate keys are harmless and ignore_errors=true
 * turns any remaining per-record error into an all-NULL row the dedup
 * window drops.
 *
 * Runs on its OWN in-memory Database — never the singleton connection used
 * by the MCP tools (connection.ts Napi::Error history; the view DDL would
 * also pollute the shared catalog).
 */

import { Database } from "duckdb";
import fs from "fs";
import path from "path";
import { READ_JSON_COLUMNS, parseDuckDBStruct } from "./queries";
import { deepConvertBigInts } from "../utils/serialize";

/** Upper bound on rows returned by one statement (GAP-023 MAX_LIMIT parity). */
export const QUERY_MAX_ROWS = 1000;

/** Rows printed per result before the "... N more" elision (s3 query parity). */
export const QUERY_PRINT_ROWS = 50;

/** Thrown for anything the read-only surface refuses to execute. */
export class ReadOnlyQueryError extends Error {}

export interface QuerySurfaceResult {
  columns: string[];
  rows: Record<string, unknown>[];
  count: number;
  /** True when the result was truncated by the auto cap (no/undersized LIMIT). */
  truncated: boolean;
}

export interface QueryTemplate {
  name: string;
  description: string;
  /** Namespace used when the operator does not pass --namespace. */
  defaultNamespace: string;
  /** SQL over the `memories` view. */
  sql: string;
}

/**
 * Saved query templates (RETR-009 T-6). Each runs against the `memories`
 * view of a namespace; the defaults point at the live namespaces that carry
 * the data (hermes-telemetry: /incidents/* + /usage/* daily telemetry rows;
 * coding-hermes: /fleet/projects/<name>/status scheduler rows).
 */
export const QUERY_TEMPLATES: Record<string, QueryTemplate> = {
  "incidents-by-day": {
    name: "incidents-by-day",
    description:
      "Daily incident counts from /incidents/YYYY-MM-DD keys (telemetry).",
    defaultNamespace: "hermes-telemetry",
    sql: `SELECT regexp_extract(key, '/incidents/([0-9]{4}-[0-9]{2}-[0-9]{2})', 1) AS day,
       count(*) AS incidents
FROM memories
WHERE key LIKE '/incidents/%'
GROUP BY day
ORDER BY day DESC`,
  },
  "per-project-status": {
    name: "per-project-status",
    description:
      "Latest scheduler status row per /fleet/projects/<name>/status (coding-hermes).",
    defaultNamespace: "coding-hermes",
    // json_valid-guarded: status bodies are JSON (scheduler state) for some
    // rows and plain text (e.g. consensus 'idle tick #N' lines) for others —
    // json_extract_string throws on malformed JSON, so non-JSON bodies must
    // project NULL instead of failing the whole template. Status writes carry
    // fresh ids per write (upsert-by-key, not by-id), so the view's id-dedup
    // keeps every write: the template itself keeps the LATEST row per project
    // via ROW_NUMBER() over the recency convention (try_cast timestamp DESC).
    sql: `SELECT project, priority, enabled, last_tick, timestamp
FROM (
  SELECT regexp_extract(key, '^/fleet/projects/([^/]+)/status', 1) AS project,
         CASE WHEN json_valid(embedding_text) THEN json_extract_string(embedding_text, '$.priority') END AS priority,
         CASE WHEN json_valid(embedding_text) THEN json_extract_string(embedding_text, '$.enabled') END AS enabled,
         CASE WHEN json_valid(embedding_text) THEN json_extract_string(embedding_text, '$.last_tick') END AS last_tick,
         timestamp,
         ROW_NUMBER() OVER (PARTITION BY regexp_extract(key, '^/fleet/projects/([^/]+)/status', 1) ORDER BY try_cast(timestamp AS TIMESTAMP) DESC) AS __rn
  FROM memories
  WHERE key LIKE '/fleet/projects/%/status'
) sub
WHERE __rn = 1
ORDER BY project`,
  },
  "cost-series": {
    name: "cost-series",
    description:
      "Daily estimated cost series from /usage/YYYY-MM-DD telemetry rows.",
    defaultNamespace: "hermes-telemetry",
    sql: `SELECT json_extract_string(attributes, '$.date') AS day,
       try_cast(json_extract_string(embedding_text, '$.totals.estimated_cost_usd') AS DOUBLE) AS cost_usd
FROM memories
WHERE key LIKE '/usage/%'
ORDER BY day`,
  },
};

/**
 * Resolve a template by name. Throws ReadOnlyQueryError for unknown names,
 * listing the available templates.
 */
export function resolveQueryTemplate(name: string): QueryTemplate {
  const template = QUERY_TEMPLATES[name];
  if (!template) {
    const available = Object.keys(QUERY_TEMPLATES).join(", ");
    throw new ReadOnlyQueryError(
      `Unknown template '${name}'. Available: ${available}`,
    );
  }
  return template;
}

/**
 * Mask string literals, quoted identifiers, and comments with spaces so
 * keyword/function scanning never matches inside them. The output has the
 * EXACT length of the input (same positions) — required for the LIMIT
 * clamp, which replaces digits in the original statement by index.
 */
function maskSqlLiterals(sql: string): string {
  const buf = sql.split("");
  const n = buf.length;
  let i = 0;
  while (i < n) {
    const c = buf[i];
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      buf[i] = " ";
      i += 1;
      while (i < n) {
        if (buf[i] === quote) {
          buf[i] = " ";
          i += 1;
          // '' (or "" / ``) is an escaped quote inside the literal.
          if (i < n && buf[i] === quote) {
            buf[i] = " ";
            i += 1;
            continue;
          }
          break;
        }
        buf[i] = " ";
        i += 1;
      }
    } else if (c === "-" && buf[i + 1] === "-") {
      buf[i] = " ";
      buf[i + 1] = " ";
      i += 2;
      while (i < n && buf[i] !== "\n") {
        buf[i] = " ";
        i += 1;
      }
    } else if (c === "/" && buf[i + 1] === "*") {
      buf[i] = " ";
      buf[i + 1] = " ";
      i += 2;
      while (i < n && !(buf[i] === "*" && buf[i + 1] === "/")) {
        buf[i] = " ";
        i += 1;
      }
      if (i < n) {
        buf[i] = " ";
        buf[i + 1] = " ";
        i += 2;
      }
    } else {
      i += 1;
    }
  }
  return buf.join("");
}

/**
 * Statement keywords that can mutate state, write files, load extensions,
 * or change connection settings. Matched as whole words on the MASKED
 * statement (string contents can't trigger).
 */
const MUTATING_KEYWORDS =
  /\b(insert|update|delete|create|drop|alter|attach|detach|copy|pragma|vacuum|call|install|load|set|export|import|begin|commit|rollback|checkpoint|prepare|execute|analyze|reindex|use)\b/i;

/**
 * Table functions that escape the namespace scope (arbitrary local/S3 file
 * reads, nested SQL execution via query(), external database scans).
 * Blocked so the surface can only touch the `memories` view.
 */
const ESCAPE_TABLE_FUNCTIONS =
  /\b(read_json_auto|read_json|read_csv_auto|read_csv|read_parquet|read_text|read_blob|read_ndjson|read_xlsx|read_xls|glob|query|sqlite_scan|postgres_scan|mysql_scan|parquet_scan|csv_scan|json_scan|iceberg_scan|delta_scan|duckdb_scan)\s*\(/i;

/** First keyword of a statement must be SELECT (WITH ... SELECT also ok). */
const FIRST_KEYWORD = /^\s*([a-z_]+)/i;

const SELECT_LIKE = /\b(select|with)\b/i;

/**
 * Validate a statement for the read-only surface. Returns the trimmed single
 * statement (trailing `;` stripped). Throws ReadOnlyQueryError on any
 * violation:
 *   - empty statement
 *   - multiple `;`-separated statements
 *   - first keyword not SELECT/WITH
 *   - any mutating keyword
 *   - any namespace-escaping table function
 */
export function validateReadOnlySql(rawSql: string): string {
  const masked = maskSqlLiterals(rawSql);

  const statements = masked
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (statements.length === 0) {
    throw new ReadOnlyQueryError("Empty SQL statement.");
  }
  if (statements.length > 1) {
    throw new ReadOnlyQueryError(
      "Only a single SQL statement is allowed (read-only surface).",
    );
  }

  const statement = statements[0]!;
  if (MUTATING_KEYWORDS.test(statement)) {
    throw new ReadOnlyQueryError(
      "Statement rejected: it contains a keyword that can mutate state, write files, or load extensions (INSERT/UPDATE/DELETE/CREATE/DROP/ALTER/ATTACH/DETACH/COPY/PRAGMA/VACUUM/CALL/INSTALL/LOAD/SET/EXPORT/IMPORT/BEGIN/COMMIT/ROLLBACK/CHECKPOINT/PREPARE/EXECUTE/ANALYZE). The query surface is strictly read-only.",
    );
  }
  if (ESCAPE_TABLE_FUNCTIONS.test(statement)) {
    throw new ReadOnlyQueryError(
      "Statement rejected: it calls a table function that escapes the namespace scope (read_json*/read_csv*/read_parquet/read_text/glob/query()/external scans). Query only the `memories` view.",
    );
  }

  const first = statement.match(FIRST_KEYWORD)?.[1]?.toLowerCase();
  if (first !== "select" && first !== "with") {
    throw new ReadOnlyQueryError(
      `Statement rejected: only read-only SELECT statements are allowed (got '${first ?? "?"}').`,
    );
  }
  // WITH must still lead to a SELECT (bare `WITH x AS (...) SELECT ...`).
  if (first === "with" && !SELECT_LIKE.test(statement)) {
    throw new ReadOnlyQueryError(
      "Statement rejected: a WITH statement must contain a SELECT.",
    );
  }

  // Recover the original text of the single statement (masked had to lose
  // the `;` — but the trim positions match, so slice the original by the
  // masked split's boundaries).
  const leading = rawSql.length - masked.trimStart().length;
  const trimmed = rawSql.slice(leading).trimEnd();
  return trimmed.replace(/;\s*$/, "");
}

/**
 * Scan the masked statement and locate the TOP-LEVEL LIMIT clause: the last
 * LIMIT keyword at parenthesis depth 0. Returns the keyword index or -1.
 */
function findTopLevelLimit(masked: string): number {
  let depth = 0;
  let last = -1;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (depth === 0 && /\blimit\b/i.test(masked.slice(i, i + 5))) {
      last = i;
      i += 4; // skip the keyword; the loop's i++ lands on the next char
    }
  }
  return last;
}

/** Find the first top-level OFFSET keyword index, or -1. */
function findTopLevelOffset(masked: string): number {
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (depth === 0 && /\boffset\b/i.test(masked.slice(i, i + 6))) {
      return i;
    }
  }
  return -1;
}

// Bare integer literals only — `LIMIT 2+3` / `LIMIT (SELECT ...)` would let
// an expression bypass the clamp (rewriting only the leading digits).
const LIMIT_NUMBER = /^limit\s+(\d+)(?=\s|$)/i;

/**
 * Enforce the row cap on a validated statement:
 *   - no top-level LIMIT        → append ` LIMIT <cap>` (before a top-level
 *                                 OFFSET if present, so the SQL stays valid)
 *   - top-level numeric LIMIT   → clamp the number to <= cap
 *   - LIMIT ALL / non-numeric   → rejected outright (would bypass the cap)
 *
 * Returns the capped statement and whether the cap was actually applied
 * (truncated=true only when the statement would otherwise exceed it).
 */
export function applyLimitCap(
  statement: string,
  cap: number = QUERY_MAX_ROWS,
): { sql: string; capped: boolean } {
  const masked = maskSqlLiterals(statement);
  const limitIdx = findTopLevelLimit(masked);
  if (limitIdx === -1) {
    const offsetIdx = findTopLevelOffset(masked);
    if (offsetIdx === -1) {
      return { sql: `${statement} LIMIT ${cap}`, capped: true };
    }
    return {
      sql: `${statement.slice(0, offsetIdx)}LIMIT ${cap} ${statement.slice(offsetIdx)}`,
      capped: true,
    };
  }

  const after = masked.slice(limitIdx);
  const numberMatch = after.match(LIMIT_NUMBER);
  if (!numberMatch) {
    throw new ReadOnlyQueryError(
      "Statement rejected: LIMIT must be a numeric literal (LIMIT ALL / expressions would bypass the read-only row cap).",
    );
  }
  const requested = parseInt(numberMatch[1]!, 10);
  if (requested <= cap) return { sql: statement, capped: false };
  // Clamp in place — mask preserves positions, so digits[1] is at
  // limitIdx + numberMatch[1]'s offset inside the ORIGINAL statement.
  const digitsStart =
    limitIdx +
    numberMatch.index! +
    numberMatch[0]!.length -
    numberMatch[1]!.length;
  return {
    sql: `${statement.slice(0, digitsStart)}${cap}${statement.slice(digitsStart + numberMatch[1]!.length)}`,
    capped: true,
  };
}

/**
 * Recursively collect every *.jsonl file under a namespace directory,
 * skipping git and cache dirs (.git, .embeddings, .search — same walk as
 * the search index).
 */
export function collectNamespaceJsonl(namespacePath: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (
          ent.name === ".git" ||
          ent.name === ".embeddings" ||
          ent.name === ".search"
        ) {
          continue;
        }
        walk(full);
      } else if (ent.name.endsWith(".jsonl")) {
        files.push(full.replace(/\\/g, "/"));
      }
    }
  };
  walk(namespacePath);
  return files;
}

/**
 * Build the `memories` TEMP VIEW DDL over a namespace's JSONL files.
 *
 * read_json_auto WITH the explicit all-VARCHAR columns override — never
 * bare (DOGFOOD-010/018/019 duplicate-key SIGABRT). The dedup window
 * (ROW_NUMBER() per id, timestamp DESC) + tombstone exclusion mirror
 * queryMemories exactly. Validity filtering (DOGFOOD-031) excludes rows
 * with expired valid_until or not-yet-valid valid_from, matching the
 * recall layer's default behavior.
 */
export function buildNamespaceViewSql(jsonlFiles: string[]): string {
  const fileList = jsonlFiles.map((f) => `'${f}'`).join(", ");
  return `CREATE TEMP VIEW memories AS
SELECT id, key, domain, timestamp, author, action, embedding_text, attributes
FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY id ORDER BY timestamp DESC) AS __rn
  FROM read_json_auto([${fileList}], format='newline_delimited', ignore_errors=true, ${READ_JSON_COLUMNS})
) sub
WHERE __rn = 1
  AND action != 'tombstone'
  AND (valid_until IS NULL OR try_cast(valid_until AS TIMESTAMP) >= now())
  AND (valid_from IS NULL OR try_cast(valid_from AS TIMESTAMP) <= now())`;
}

/** node-duckdb db.exec promisified. */
function execAsync(db: Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/** node-duckdb db.all promisified. */
function allAsync(
  db: Database,
  sql: string,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, (err: Error | null, result: unknown) => {
      if (err) {
        reject(err);
        return;
      }
      resolve((result as Record<string, unknown>[]) ?? []);
    });
  });
}

/**
 * Run a read-only statement against a namespace's memory store.
 *
 * @param namespacePath Absolute path of the namespace directory
 * @param rawSql        Operator-supplied SQL (validated + capped here)
 * @param cap           Optional row cap override (default QUERY_MAX_ROWS)
 * @throws ReadOnlyQueryError for anything the surface refuses
 */
export async function runReadOnlyQuery(
  namespacePath: string,
  rawSql: string,
  cap: number = QUERY_MAX_ROWS,
): Promise<QuerySurfaceResult> {
  const statement = validateReadOnlySql(rawSql);
  const { sql, capped } = applyLimitCap(statement, cap);

  const jsonlFiles = collectNamespaceJsonl(namespacePath);
  if (jsonlFiles.length === 0) {
    return { columns: [], rows: [], count: 0, truncated: false };
  }

  const db = new Database(":memory:");
  try {
    await execAsync(db, buildNamespaceViewSql(jsonlFiles));
    const rawRows = await allAsync(db, sql);
    const rows = rawRows.map((row) => {
      const shaped: Record<string, unknown> = { ...row };
      // attributes is VARCHAR raw JSON text under the columns override;
      // shape it exactly like queryMemories does (JSON.parse first, STRUCT
      // fallback) so CLI output matches recall's. Only when SELECTed —
      // never inject an empty attributes key into the projection.
      if (typeof row.attributes === "string") {
        shaped.attributes = parseDuckDBStruct(row.attributes);
      }
      return deepConvertBigInts(shaped) as Record<string, unknown>;
    });
    const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];
    return { columns, rows, count: rows.length, truncated: capped };
  } finally {
    db.close();
  }
}
