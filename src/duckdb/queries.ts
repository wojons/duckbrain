/**
 * DuckDB Memory Queries
 *
 * Query layer for reading/writing memories via DuckDB.
 * Filters tombstone records by default.
 */

import type { Database } from "./connection";
import type { MemoryType } from "../schema/memory";
import type { AuthPrincipal } from "../auth/middleware";
import { resolveNamespacesPath } from "../config";
import { getNamespaceWriter } from "../serialization/namespaceWriter";
import path from "path";
import fs from "fs";
import { createHash } from "crypto";
import { deepConvertBigInts } from "../utils/serialize";
import { compareChunkNames } from "../storage/jsonl";
import {
  scanMalformedLinesDetailed,
  warnOnCorruption,
  type CorruptionReport,
  type ChunkFileStat,
} from "../storage/corruption";

/**
 * Parse DuckDB STRUCT format string into a JavaScript object
 *
 * DuckDB returns STRUCT columns as strings like: {key1='value1', key2='value2'}
 * This parser handles the STRUCT format and converts to valid JSON
 *
 * @param structStr - The STRUCT format string from DuckDB
 * @returns Parsed JavaScript object
 *
 * Exported so the RETR-009 read-only query surface shapes its rows with the
 * exact same semantics as queryMemories (attributes is VARCHAR raw JSON text
 * under the all-VARCHAR columns override; JSON.parse collapses RFC 8259
 * duplicate keys to the last value).
 */
export function parseDuckDBStruct(structStr: string): Record<string, unknown> {
  if (!structStr || typeof structStr !== "string") {
    return {};
  }

  try {
    // Try to parse as JSON first (in case it's already JSON)
    return JSON.parse(structStr);
  } catch {
    // It's in STRUCT format, parse manually
  }

  const result: Record<string, unknown> = {};

  // Remove outer braces and whitespace
  const content = structStr
    .trim()
    .replace(/^\{|\}$/g, "")
    .trim();
  if (!content) {
    return result;
  }

  // Split by commas, but be careful with nested structures
  // Simple parsing: key='value' pairs
  const pairs = content.split(",");

  for (const pair of pairs) {
    const trimmed = pair.trim();
    if (!trimmed) continue;

    // Find the = separator
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.substring(0, eqIndex).trim();
    let value = trimmed.substring(eqIndex + 1).trim();

    // Remove quotes from value
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }

    // Try to parse as JSON if it looks like a nested object or array
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
 * Query filters shared by queryMemories and countMemories (GAP-024).
 */
export interface MemoryQueryFilters {
  key?: string;
  keyPrefix?: string;
  domain?: string;
  author?: string;
  id?: string;
  query?: string;
  embedding?: number[];
  /** RETR-003: include rows whose timestamp (or chat-archive key date facet)
   *  is at or after this ISO-8601 instant */
  after?: string;
  /** RETR-003: include rows whose timestamp (or chat-archive key date facet)
   *  is at or before this ISO-8601 instant */
  before?: string;
  /** RETR-006: attribute filters — include only rows whose `attributes`
   *  JSON contains name → value (exact string match after DuckDB's
   *  json_extract_string normalization: numeric/bool values compare by
   *  their string form, so attr.tick=403 matches both 403 and "403").
   *  Empty record = no-op. */
  attr?: Record<string, string>;
  /** RETR-011: validity-window filtering — when `now` is provided and
   *  `historical` is not true, only rows whose validity window contains
   *  `now` are included: valid_until in the past (expired) and valid_from
   *  in the future (not yet valid) are excluded. historical=true (or no
   *  `now`) disables the filter. Callers outside the recall surface never
   *  set `now`, so their behavior is unchanged. */
  historical?: boolean;
  /** RETR-011: the "now" instant (ISO-8601) the validity window is
   *  compared against — set once per recall request so the whole query
   *  (and its count) sees one fixed instant. */
  now?: string;
  limit?: number;
  /** DB-GAP-046: page window start — rows [offset, offset+limit) of the
   *  ORDERED, deduplicated, tombstone-filtered result set. Applied as SQL
   *  LIMIT/OFFSET (only along with `limit`), never as a post-query slice of
   *  an already-truncated page: an offset applied outside the query cannot
   *  reach rows the LIMIT never fetched. countMemories ignores this field —
   *  `total` is always the unlimited match count (GAP-024). */
  offset?: number;
}

/**
 * PERF-DUCKBRAIN-003: per-partition directory-listing cache.
 *
 * The bounded plain-list path enumerates every partition on EVERY request.
 * The entry SET of a partition directory changes only when a chunk is
 * created, deleted, or renamed — all of which bump the DIRECTORY mtime —
 * while an append to an existing chunk does NOT change it (and must not
 * invalidate anything here: the listing is names only, never a content
 * verdict). So the listing is cached keyed by the directory mtime taken
 * BEFORE the readdir: any later entry change produces a strictly newer
 * directory mtime than the cached one, forcing a refresh, and an append
 * reuses the cached names.
 *
 * The per-file stats stored on a refresh are informational (AC3's "listing +
 * its per-file stats" composition); NO content verdict is ever derived from
 * them, because an append changes neither the directory mtime nor the name —
 * content freshness remains the exclusive job of corruption.ts's per-file
 * (size, mtimeMs) invalidation.
 */
interface ListingCacheEntry {
  /** Directory mtime captured BEFORE the readdir (see soundness note above). */
  dirMtimeMs: number;
  /** Chunk file names, in the partition's segment order. */
  names: string[];
  /** Per-file stats captured during the refresh that built this entry. */
  fileStats: ChunkFileStat[];
}

const listingCache = new Map<string, ListingCacheEntry>();

/** Bound the listing cache: a daemon serving many namespaces stays bounded. */
const MAX_LISTING_CACHE_ENTRIES = 8192;

/**
 * PERF-DUCKBRAIN-003 test seam: what the read path's OWN enumeration layer
 * did since the last reset. The corruption audit's per-file statSync pass is
 * deliberately NOT counted here — it is corruption.ts's mandated freshness
 * check and stays byte-identical (see the AC(3) disclosure).
 */
const listingCacheMetrics = {
  dirStats: 0,
  readdirs: 0,
  chunkStats: 0,
  hits: 0,
  misses: 0,
};

/** Reset + read the enumeration-layer counters (test seam, like resetCorruptionCache). */
export function __jsonlListingCacheForTests(action: "reset" | "peek"): {
  dirStats: number;
  readdirs: number;
  chunkStats: number;
  hits: number;
  misses: number;
} {
  if (action === "reset") {
    listingCacheMetrics.dirStats = 0;
    listingCacheMetrics.readdirs = 0;
    listingCacheMetrics.chunkStats = 0;
    listingCacheMetrics.hits = 0;
    listingCacheMetrics.misses = 0;
  }
  return { ...listingCacheMetrics };
}

/**
 * Collect the JSONL file paths for the given partitions
 */
export function collectJsonlFiles(partitionPaths: string[]): string[] {
  const jsonlFiles: string[] = [];
  for (const partitionPath of partitionPaths) {
    if (!fs.existsSync(partitionPath)) continue;

    // PERF-DUCKBRAIN-003: stat the directory FIRST, then readdir — the
    // cached mtime must predate the listing snapshot so any later entry
    // create/delete shows up as a strictly newer mtime on the next call.
    let dirStat: fs.Stats;
    try {
      dirStat = fs.statSync(partitionPath);
      listingCacheMetrics.dirStats += 1;
    } catch {
      continue;
    }

    const cached = listingCache.get(partitionPath);
    if (cached && cached.dirMtimeMs === dirStat.mtimeMs) {
      listingCacheMetrics.hits += 1;
      for (const name of cached.names) {
        jsonlFiles.push(path.join(partitionPath, name).replace(/\\/g, "/"));
      }
      continue;
    }

    listingCacheMetrics.misses += 1;
    const names = fs
      .readdirSync(partitionPath)
      .filter((f) => f.endsWith(".jsonl"))
      // Numeric segment order, not readdir order: past segment 9999 the names
      // are not fixed-width, and DuckDB ingests in the order given.
      .sort(compareChunkNames);
    listingCacheMetrics.readdirs += 1;

    // Informational per-file stats for the refreshed entry (see the cache
    // doc block: never a content verdict).
    const fileStats: ChunkFileStat[] = [];
    for (const name of names) {
      const full = path.join(partitionPath, name);
      try {
        const st = fs.statSync(full);
        listingCacheMetrics.chunkStats += 1;
        fileStats.push({
          path: full,
          size: st.size,
          mtimeMs: st.mtimeMs,
          present: true,
        });
      } catch {
        fileStats.push({ path: full, size: 0, mtimeMs: 0, present: false });
      }
    }

    if (listingCache.size >= MAX_LISTING_CACHE_ENTRIES) {
      const oldest = listingCache.keys().next().value;
      if (oldest !== undefined) listingCache.delete(oldest);
    }
    listingCache.set(partitionPath, {
      dirMtimeMs: dirStat.mtimeMs,
      names,
      fileStats,
    });

    for (const name of names) {
      jsonlFiles.push(path.join(partitionPath, name).replace(/\\/g, "/"));
    }
  }
  return jsonlFiles;
}

/**
 * QA-DUCKBRAIN-022: report malformed lines the serving read is about to skip.
 *
 * The serving path reads chunks with `read_json(..., ignore_errors=true)` —
 * deliberate (one torn line must not take a namespace down) but until now
 * silent, so a crash-truncated record vanished from `recall`/`search` with
 * no trace. This audits the same file list through the shared scanner
 * (`src/storage/corruption.ts`) and emits the same warning the JSONL reader
 * emits, so both readers report one count for one namespace (AC4).
 */
export function auditServingChunks(
  jsonlFiles: string[],
): CorruptionReport & { fileStats?: ChunkFileStat[] } {
  // PERF-DUCKBRAIN-003: the same scan (byte-identical behavior), plus the
  // per-file stats the scan already observed. Consumers may key a
  // content-derived cache on these — they are the CURRENT (size, mtimeMs)
  // of every chunk, the same freshness signal corruption.ts invalidates on.
  const detailed = scanMalformedLinesDetailed(jsonlFiles);
  const report = detailed.report;
  if (report.skipped > 0) {
    warnOnCorruption(report);
  }
  return { ...report, fileStats: detailed.fileStats };
}

/**
 * RETR-003: SQL conditions for the after/before time bounds, if any.
 *
 * The row matches when EITHER:
 *  1. its own `timestamp` satisfies ALL bounds — compared as a real
 *     TIMESTAMP (try_cast), NOT as a string: chat-archive rows mix
 *     formats (`.749Z` and `.676525+00:00`), and lexicographic
 *     comparison is wrong across those formats. Bounds arrive already
 *     canonicalized to UTC (src/utils/timerange.ts), and this DuckDB
 *     version parses `Z` and `+00:00` stored rows to the same instant
 *     (non-UTC offsets are read wall-clock-as-UTC — the corpus only
 *     carries +00:00, so comparisons are correct for the data at hand).
 *  2. its KEY carries a chat-archive date facet — /chats/<view>/<YYYY-MM-DD>
 *     — whose facet date satisfies ALL bounds. This is what makes since/until
 *     work on chat-archive keys (T-1/RETR-003): those records' timestamps
 *     are the archive INGESTION time (e.g. 2026-08-07T09:26:22.496Z), while
 *     the message date lives in the key (e.g. /chats/karahermes-dm/2026-05-24).
 *     Facet dates compare at day granularity (midnight UTC).
 *
 * The facet clause deliberately wraps ALL bounds as ONE window: per-bound
 * OR-clauses would let a row pass `after` via its timestamp and `before`
 * via its facet (or vice versa) — a cross-product match outside the window.
 *
 * Exported so the FTS keyword path (src/search/query.ts) applies exactly
 * the same semantics to its candidate SQL.
 */
export function buildTimeRangeConditions(
  after?: string,
  before?: string,
): string[] {
  const timestampBounds: string[] = [];
  const facetBounds: string[] = [];
  if (after !== undefined) {
    timestampBounds.push(buildTimestampBound("after", after));
    facetBounds.push(buildFacetBound("after", after));
  }
  if (before !== undefined) {
    timestampBounds.push(buildTimestampBound("before", before));
    facetBounds.push(buildFacetBound("before", before));
  }
  if (timestampBounds.length === 0) return [];
  return [
    `(${timestampBounds.join(" AND ")} OR (regexp_matches(key, '^/chats/[^/]+/[0-9]{4}-[0-9]{2}-[0-9]{2}(/|$)') AND ${facetBounds.join(" AND ")}))`,
  ];
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * RETR-006: SQL conditions for attribute filters, if any.
 *
 * `attributes` is forced to VARCHAR by READ_JSON_COLUMNS, so rows carry the
 * RAW JSON text and json_extract_string (verified live on duckdb 1.4.4)
 * is the right extractor — it parses the JSON per call, tolerates
 * RFC 8259 duplicate keys (first value wins, DOGFOOD-018/019), stringifies
 * scalars (numeric `tick: 403` extracts to '403', so a single literal
 * comparison matches both `403` and `"403"`), and returns NULL (no match)
 * for missing keys or unparseable rows (read_json ignore_errors=true has
 * already NULLed malformed lines).
 *
 * Injection safety, mirroring the other template-literal conditions:
 *   - the VALUE is escaped as a SQL string literal (single-quote doubling);
 *   - the NAME is embedded in a JSONPath `$."…"` segment with `\` and `"`
 *     backslash-escaped, so quotes/backslashes in a name can neither break
 *     the SQL string nor the JSONPath parser (verified live).
 *
 * Exported so the FTS keyword path (src/search/query.ts) applies exactly
 * the same conditions to its sidecar candidate SQL.
 */
export function buildAttributeConditions(
  attr?: Record<string, string>,
): string[] {
  if (!attr) return [];
  const conditions: string[] = [];
  for (const [name, value] of Object.entries(attr)) {
    const pathSegment = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    conditions.push(
      `json_extract_string(attributes, '$."${pathSegment}"') = '${escapeSqlLiteral(value)}'`,
    );
  }
  return conditions;
}

/**
 * RETR-011: SQL conditions for the validity window, if the caller opted in.
 *
 * Current view (historical !== true AND now provided): a row is visible
 * only while its validity window contains `now`:
 *   - valid_until IS NULL OR valid_until >= now   (not expired)
 *   - valid_from IS NULL OR valid_from <= now     (already valid)
 * Both fields are VARCHAR ISO-8601 (READ_JSON_COLUMNS), compared as
 * TIMESTAMP via try_cast — the same pattern as the RETR-003 time bounds
 * (a lexicographic string compare would be wrong across mixed formats).
 * historical=true (or no `now`) → no conditions, all rows regardless of
 * validity — the historical view where expired facts remain visible.
 *
 * Exported so the FTS keyword path (src/search/query.ts) applies exactly
 * the same semantics to its sidecar candidate SQL.
 */
export function buildValidityConditions(
  historical: boolean | undefined,
  now: string | undefined,
): string[] {
  if (historical === true || now === undefined) return [];
  const nowLit = escapeSqlLiteral(now);
  return [
    `(valid_until IS NULL OR try_cast(valid_until AS TIMESTAMP) >= try_cast('${nowLit}' AS TIMESTAMP))`,
    `(valid_from IS NULL OR try_cast(valid_from AS TIMESTAMP) <= try_cast('${nowLit}' AS TIMESTAMP))`,
  ];
}

function buildTimestampBound(kind: "after" | "before", value: string): string {
  const cmp = kind === "after" ? ">=" : "<=";
  return `try_cast(timestamp AS TIMESTAMP) ${cmp} try_cast('${escapeSqlLiteral(value)}' AS TIMESTAMP)`;
}

function buildFacetBound(kind: "after" | "before", value: string): string {
  const cmp = kind === "after" ? ">=" : "<=";
  return `try_cast(regexp_extract(key, '^/chats/[^/]+/([0-9]{4}-[0-9]{2}-[0-9]{2})', 1) AS TIMESTAMP) ${cmp} try_cast('${escapeSqlLiteral(value)}' AS TIMESTAMP)`;
}

/**
 * RETR-005: recency-aware default ordering for listing paths (exact-key,
 * glob/keyPrefix, domain/author, plain list). Newest-first by default —
 * before RETR-005 these legs had NO ORDER BY at all and surfaced rows in
 * read_json file order (oldest-first on appended JSONL).
 *
 * try_cast(timestamp AS TIMESTAMP) compares the mixed corpus formats
 * (`.749Z` vs `.676525+00:00`) as instants — the same approach the
 * RETR-003 time bounds use; a lexicographic sort would misorder those
 * (0x2B '+' < 0x5A 'Z'). NULLS LAST keeps unparseable rows at the bottom
 * (a corrupt row must never pollute the top of a listing), and id ASC is
 * the deterministic final tiebreak for equal timestamps.
 */
const DEFAULT_ORDER_BY =
  "ORDER BY try_cast(timestamp AS TIMESTAMP) DESC NULLS LAST, id ASC";

/**
 * Build the inner WHERE conditions for the given filters.
 *
 * Shared by queryMemories and countMemories so the counted row set always
 * matches the queried row set (same dedup + tombstone semantics).
 */
function buildWhereConditions(filters?: MemoryQueryFilters): string[] {
  const conditions: string[] = [];

  if (filters?.key) {
    // Escape single quotes in key to prevent SQL injection
    const escapedKey = filters.key.replace(/'/g, "''");
    conditions.push(`key = '${escapedKey}'`);
  }

  if (filters?.id) {
    // Escape single quotes in id to prevent SQL injection
    const escapedId = filters.id.replace(/'/g, "''");
    conditions.push(`id = '${escapedId}'`);
  }

  if (filters?.keyPrefix) {
    // Escape single quotes in prefix and add LIKE pattern
    const escapedPrefix = filters.keyPrefix.replace(/'/g, "''");
    conditions.push(`key LIKE '${escapedPrefix}%%'`);
  }

  if (filters?.domain) {
    conditions.push(`domain = '${filters.domain}'`);
  }

  if (filters?.author) {
    // Escape single quotes in author to prevent SQL injection
    const escapedAuthor = filters.author.replace(/'/g, "''");
    conditions.push(`author = '${escapedAuthor}'`);
  }

  // RETR-003: time-scoped recall — timestamp (and chat-archive key facet)
  // bounds. Applied INSIDE the dedup window, so a memory that was updated
  // after the window's end still surfaces as its latest in-window record.
  conditions.push(...buildTimeRangeConditions(filters?.after, filters?.before));

  // RETR-006: attribute filters — exact matches on the attributes JSON.
  // ANDed with everything above (intersection semantics). Applied inside
  // the dedup window like the time bounds.
  conditions.push(...buildAttributeConditions(filters?.attr));

  // RETR-011: validity-window filter — current view excludes expired
  // (past valid_until) and not-yet-valid (future valid_from) rows.
  // Applied inside the dedup window, mirroring the time bounds; the
  // recall surface always sets `now`, so non-recall callers (which never
  // set it) keep legacy behavior.
  conditions.push(
    ...buildValidityConditions(filters?.historical, filters?.now),
  );

  // Semantic search with vector similarity
  if (filters?.query && filters?.embedding) {
    conditions.push("embedding IS NOT NULL");
  }

  return conditions;
}

/**
 * Explicit read_json column schema (DOGFOOD-010).
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
 * line) into an all-NULL row, which the `action != 'tombstone'` outer filter
 * drops, instead of a native throw.
 */
export const READ_JSON_COLUMNS =
  "columns={id:'VARCHAR', key:'VARCHAR', domain:'VARCHAR', timestamp:'VARCHAR', valid_from:'VARCHAR', valid_until:'VARCHAR', author:'VARCHAR', action:'VARCHAR', embedding_text:'VARCHAR', attributes:'VARCHAR'}";

/**
 * Map one raw DuckDB row (all-VARCHAR READ_JSON_COLUMNS shape) to the
 * exported MemoryType shape.
 *
 * PERF-003: extracted from queryMemories so queryMemoriesWithTotal shapes
 * its rows with the SAME code path — identical key order, identical
 * attributes parsing (parseDuckDBStruct), identical BigInt normalization —
 * which is what makes the fused result byte-identical to the old
 * two-scan path.
 */
function mapMemoryRow(row: any): MemoryType {
  return deepConvertBigInts({
    id: row.id,
    key: row.key,
    domain: row.domain,
    timestamp: row.timestamp,
    // RETR-011: optional validity window — absent on rows written
    // before the fields existed (NULL → undefined).
    ...(typeof row.valid_from === "string"
      ? { valid_from: row.valid_from }
      : {}),
    ...(typeof row.valid_until === "string"
      ? { valid_until: row.valid_until }
      : {}),
    author: row.author,
    action: row.action,
    embedding_text: row.embedding_text,
    attributes:
      typeof row.attributes === "string"
        ? parseDuckDBStruct(row.attributes)
        : row.attributes,
  });
}

/**
 * Query memories from DuckDB with optional filters
 *
 * @param db - DuckDB database instance
 * @param partitionPaths - Array of absolute partition paths to query
 * @param filters - Optional query filters
 * @returns Array of matching memory records
 */
export function queryMemories(
  db: Database,
  partitionPaths: string[],
  filters?: MemoryQueryFilters,
): MemoryType[] | Promise<MemoryType[]> {
  if (partitionPaths.length === 0) {
    return [];
  }

  // Build file list for DuckDB (use read_json instead of glob for reliability)
  const jsonlFiles = collectJsonlFiles(partitionPaths);

  if (jsonlFiles.length === 0) {
    return [];
  }

  // QA-DUCKBRAIN-022: never serve a short page silently.
  auditServingChunks(jsonlFiles);

  // Build WHERE clause based on filters - use template literals instead of
  // prepared statements to avoid DuckDB Node.js binding issues with parameter
  // placeholders
  const innerConditions = buildWhereConditions(filters);

  // RETR-005: listing legs default to newest-first. The semantic leg keeps
  // cosine similarity as the primary key and breaks equal-distance ties by
  // recency (same try_cast + id tiebreak as DEFAULT_ORDER_BY), so fresh
  // memories outrank equal-similarity old ones at the SQL layer too.
  let orderByClause = DEFAULT_ORDER_BY;

  // Semantic search with vector similarity
  if (filters?.query && filters?.embedding) {
    // Use DuckDB VSS extension for cosine similarity
    const embeddingStr = `[${filters.embedding.join(",")}]`;
    orderByClause = `ORDER BY array_cosine_distance(embedding, ${embeddingStr}::FLOAT[384]) ASC, try_cast(timestamp AS TIMESTAMP) DESC NULLS LAST, id ASC`;
  }

  const innerWhereClause =
    innerConditions.length > 0 ? `WHERE ${innerConditions.join(" AND ")}` : "";

  // Use a window function to deduplicate by ID, keeping only the latest
  // record for each memory. If the latest action is 'tombstone', the
  // memory is considered deleted and excluded from results.
  // This fixes BUG-027: tombstone filtering was broken because the
  // old flat WHERE clause excluded tombstone records but still returned
  // the original 'add' record with the same ID.
  //
  // The "latest" pick orders by try_cast(timestamp AS TIMESTAMP) — NOT the
  // raw VARCHAR — so mixed timestamp formats (.749Z vs .749525+00:00,
  // RETR-003) order as instants and the genuinely newest version wins. A
  // lexicographic VARCHAR sort misorders those (0x5A 'Z' > 0x35 '5'), so
  // the OLDER .749Z row would be kept and the newer version made invisible.
  const outerWhereClause = "__rn = 1 AND action != 'tombstone'";

  // GAP-023: explicit undefined check — a falsy 0 previously produced NO
  // LIMIT clause at all (returning every row). LIMIT 0 must emit "LIMIT 0".
  const limitClause =
    filters?.limit !== undefined ? `LIMIT ${filters.limit}` : "";

  // DB-GAP-046: the page window (offset) is applied HERE, to the ordered
  // deduped result set, so the DB returns rows [offset, offset+limit) and
  // callers never have to slice a page they already truncated. Emitted only
  // alongside a LIMIT: a bare OFFSET is meaningless for this query shape and
  // would split callers onto a second SQL path. A non-positive offset is a
  // no-op (the HTTP route rejects negative/non-numeric offsets up front).
  const offsetClause =
    filters?.limit !== undefined && (filters?.offset ?? 0) > 0
      ? `OFFSET ${filters.offset}`
      : "";

  // Use read_json with explicit file list instead of glob pattern
  const fileList = jsonlFiles.map((f) => `'${f}'`).join(", ");
  const sql = `
    SELECT id, key, domain, timestamp, valid_from, valid_until, author, action, embedding_text, attributes
    FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY id ORDER BY try_cast(timestamp AS TIMESTAMP) DESC NULLS LAST) as __rn
      FROM read_json([${fileList}], format='newline_delimited', ignore_errors=true, ${READ_JSON_COLUMNS})
      ${innerWhereClause}
    ) sub
    WHERE ${outerWhereClause}
    ${orderByClause}
    ${limitClause}
    ${offsetClause}
  `;

  // Use db.all() directly instead of prepared statements to avoid parameter binding issues
  return new Promise((resolve, reject) => {
    try {
      db.all(sql, (err: any, result: any) => {
        if (err) {
          const errMsg = err?.message || String(err);
          console.error("DuckDB query error:", err);
          // BUG-034: Propagate connection errors so callers can retry.
          // A silently-broken Database (e.g. file locked by another process)
          // must be evicted from the cache and re-created.
          if (
            /connection.*never established|closed already|locked/i.test(errMsg)
          ) {
            reject(new Error(`DUCKDB_CONNECTION_LOST: ${errMsg}`));
            return;
          }
          resolve([]);
          return;
        }

        // Handle case where result is undefined or not an array
        if (!result || !Array.isArray(result)) {
          resolve([]);
          return;
        }

        resolve((result as any[]).map(mapMemoryRow));
      });
    } catch (error) {
      console.error("DuckDB query error:", error);
      resolve([]);
    }
  });
}

/**
 * Count memories matching the given filters (GAP-024).
 *
 * Produces the same row set as queryMemories — deduplicated by id (latest
 * record wins) with tombstoned memories excluded — but with no LIMIT, so
 * the result is the true total for the active filters regardless of any
 * limit/offset the caller applies to the data query.
 *
 * @param db - DuckDB database instance
 * @param partitionPaths - Array of absolute partition paths to query
 * @param filters - Optional query filters (limit AND offset are ignored —
 *   GAP-024/DB-GAP-046: the total must be the unlimited match count)
 * @returns Number of matching memory records
 */
export function countMemories(
  db: Database,
  partitionPaths: string[],
  filters?: MemoryQueryFilters,
): Promise<number> {
  if (partitionPaths.length === 0) {
    return Promise.resolve(0);
  }

  const jsonlFiles = collectJsonlFiles(partitionPaths);

  if (jsonlFiles.length === 0) {
    return Promise.resolve(0);
  }

  // QA-DUCKBRAIN-022: a count computed over a truncated ingest must say so.
  auditServingChunks(jsonlFiles);

  const innerConditions = buildWhereConditions(filters);
  const innerWhereClause =
    innerConditions.length > 0 ? `WHERE ${innerConditions.join(" AND ")}` : "";

  // Same dedup/tombstone semantics as queryMemories
  const outerWhereClause = "__rn = 1 AND action != 'tombstone'";

  // Use read_json with explicit file list instead of glob pattern
  const fileList = jsonlFiles.map((f) => `'${f}'`).join(", ");
  const sql = `
    SELECT COUNT(*) AS total
    FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY id ORDER BY try_cast(timestamp AS TIMESTAMP) DESC NULLS LAST) as __rn
      FROM read_json([${fileList}], format='newline_delimited', ignore_errors=true, ${READ_JSON_COLUMNS})
      ${innerWhereClause}
    ) sub
    WHERE ${outerWhereClause}
  `;

  // Use db.all() directly instead of prepared statements to avoid parameter binding issues
  return new Promise((resolve, reject) => {
    try {
      db.all(sql, (err: any, result: any) => {
        if (err) {
          const errMsg = err?.message || String(err);
          console.error("DuckDB count error:", err);
          // BUG-034: Propagate connection errors so callers can retry.
          // A silently-broken Database (e.g. file locked by another process)
          // must be evicted from the cache and re-created.
          if (
            /connection.*never established|closed already|locked/i.test(errMsg)
          ) {
            reject(new Error(`DUCKDB_CONNECTION_LOST: ${errMsg}`));
            return;
          }
          resolve(0);
          return;
        }

        // COUNT(*) comes back as BIGINT; Number() normalizes it
        resolve(Number(result?.[0]?.total ?? 0));
      });
    } catch (error) {
      console.error("DuckDB count error:", error);
      resolve(0);
    }
  });
}

/** Combined query+total result (PERF-003). */
export interface QueryMemoriesWithTotalResult {
  memories: MemoryType[];
  /**
   * The true total for the active filters — the DEDUPED, tombstone-filtered
   * match count, unlimited by limit/offset (GAP-024 semantics — identical to
   * what countMemories reports).
   */
  total: number;
}

/**
 * PERF-DUCKBRAIN-001: plain-list detection.
 *
 * The plain-list case is a request with no search/attribute/time-range
 * dimensions: no `query` (semantic/hybrid), no `embedding` (semantic
 * override), no `attr` (attribute filter), and no `after`/`before` (time
 * range). Single-value equality filters (`key` / `id` / `keyPrefix` /
 * `domain` / `author`) are still cheap, still list-shaped, so they stay on
 * the bounded path. (`contains` / `allNamespaces` are handled in the recall
 * tool's keyword leg and never reach this layer.)
 *
 * The ledger shows 5,968 slow plain-list calls carry no query string at all;
 * this predicate is true exactly for those requests.
 */
function isPlainList(filters?: MemoryQueryFilters): boolean {
  if (!filters) return true;
  if (filters.query !== undefined) return false;
  if (filters.embedding !== undefined) return false;
  if (filters.attr !== undefined) return false;
  if (filters.after !== undefined || filters.before !== undefined) return false;
  return true;
}

/** PERF-DUCKBRAIN-001: raw rows fetched beyond the page to absorb duplicate /
 * tombstone collapse — a page of N live rows can require more than N raw rows. */
const PLAIN_LIST_DEDUP_SLACK = 50;

/**
 * PERF-DUCKBRAIN-003: segments per partition the first bounded read covers.
 * Writes always resolve to the partition's newest segment, so the newest
 * rows overwhelmingly live in the newest few segments; the slice doubles on
 * under-fill or unprovable pages and the FULL list is used whenever the
 * widened slice cannot prove it fills the page (AC2's own fallback).
 * 8 keeps a 500-segment fixture partition under the 50-path AC(3) bound.
 */
const PLAIN_LIST_SLICE_START = 8;

/** PERF-DUCKBRAIN-001: hard cap on raw rows scanned for one page before the
 * bounded read gives up and falls back to the fused statement. */
const PLAIN_LIST_MAX_WINDOW = 100_000;

/** All-VARCHAR raw row shape produced by the bounded read (READ_JSON_COLUMNS). */
interface RawJsonRow {
  id: string;
  key: string;
  domain: string;
  timestamp: string;
  valid_from: string | null;
  valid_until: string | null;
  author: string;
  action: string;
  embedding_text: string;
  attributes: string;
  /**
   * PERF-DUCKBRAIN-003: `epoch_ms(try_cast(timestamp AS TIMESTAMP))` of the
   * row, computed BY DuckDB (no JS date-parsing ambiguity). Present only on
   * bounded-read rows; NULL for rows whose timestamp cannot be cast.
   */
  __ts_ms?: number | null;
}

/**
 * Run a raw read_json statement with the SAME error contract as the fused
 * statement: a connection-lost error REJECTS (so recall.ts retries on a fresh
 * connection, BUG-034); every other error resolves to an empty result set.
 */
function runRawQuery(db: Database, sql: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    try {
      db.all(sql, (err: any, result: any) => {
        if (err) {
          const errMsg = err?.message || String(err);
          if (
            /connection.*never established|closed already|locked/i.test(errMsg)
          ) {
            reject(new Error(`DUCKDB_CONNECTION_LOST: ${errMsg}`));
            return;
          }
          resolve([]);
          return;
        }
        resolve(Array.isArray(result) ? result : []);
      });
    } catch (error) {
      resolve([]);
    }
  });
}

/**
 * PERF-DUCKBRAIN-001: dedupe a bounded, recency-ordered raw window in code.
 *
 * The window arrives ordered by `timestamp DESC NULLS LAST, id ASC` — the
 * SAME recency order the fused page applies — so the FIRST occurrence of any
 * id in the window is its newest copy (a newer copy always sorts above an
 * older copy of the same id, so the newest copy can never be cut off below a
 * duplicate of itself). Keep the first occurrence per id, drop the id when
 * that newest copy is a tombstone (and drop rows with a NULL action, which
 * `action != 'tombstone'` also excludes in SQL), then slice
 * [offset, offset + limit) of the surviving live rows.
 */
function dedupePage(
  raw: RawJsonRow[],
  offset: number,
  limit: number,
): MemoryType[] {
  const seen = new Set<string>();
  const live: MemoryType[] = [];
  for (const row of raw) {
    if (row.id == null) continue;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    if (row.action == null || row.action === "tombstone") continue;
    live.push(mapMemoryRow(row));
  }
  return live.slice(offset, offset + limit);
}

/**
 * PERF-DUCKBRAIN-001: exact live count without the full-corpus window sort.
 *
 * `total` must keep its GAP-024 meaning — the count of live, DEDUPED rows
 * (newest version per id, tombstoned ids excluded). A plain
 * `COUNT(DISTINCT id) WHERE action != 'tombstone'` is NOT that: it counts a
 * tombstoned id's surviving older copies too (measured +51 on the compacted
 * coding-hermes copy), so it changes total's meaning and is rejected.
 *
 * Instead, GROUP BY id with `arg_max(action, try_cast(timestamp AS TIMESTAMP))`
 * — the action of the newest row per id — and count ids whose newest action is
 * not 'tombstone'. This is a hash aggregation (no window sort) and returns the
 * exact same 241,901 as the ROW_NUMBER window on the compacted copy.
 *
 * One documented equivalence caveat: an id whose every timestamp is
 * unparseable (all-NULL) resolves to arg_max NULL → excluded here, whereas
 * ROW_NUMBER picks an arbitrary row. Both are non-deterministic in that
 * pathological case (and such rows are all-NULL anyway, so the page path
 * drops them too); no real corpus exercises it.
 */
async function countLiveDeduped(
  db: Database,
  fileList: string,
  innerWhereClause: string,
): Promise<number> {
  const sql = `
    SELECT COUNT(*) AS total FROM (
      SELECT id
      FROM read_json([${fileList}], format='newline_delimited', ignore_errors=true, ${READ_JSON_COLUMNS})
      ${innerWhereClause}
      GROUP BY id
      HAVING arg_max(action, try_cast(timestamp AS TIMESTAMP)) != 'tombstone'
    ) deduped
  `;
  const result = await runRawQuery(db, sql);
  // COUNT(*) comes back as BIGINT; Number() normalizes it (same as
  // countMemories).
  return Number(result?.[0]?.total ?? 0);
}

/**
 * PERF-DUCKBRAIN-003: countLiveDeduped plus the NEXT instant this count's
 * result could change under the current-view validity filter — in the SAME
 * read_json scan.
 *
 * The recall surface sets `now` on every list request (RETR-011), so a
 * content-derived total cache keyed on the whole WHERE clause changes key on
 * every request and the cached total never serves (this was measured live on
 * the staged 20k-chunk corpus: every warm request re-ran the full-corpus
 * count, erasing PERF-003's warm win on the serving path). The fix keeps the
 * key on the now-INDEPENDENT query semantics and anchors validity through
 * this boundary: the count under the current view can only change when
 * `now` crosses some row's valid_from (a row becomes valid) or valid_until
 * (a row expires). So while
 *
 *   computedAtMs <= now < nextEdgeMs
 *
 * the cached count is EXACT regardless of how now moves sub-second inside
 * that interval.
 *
 * THE ROW SETS ARE DELIBERATELY SPLIT: the edge scan reads the row set the
 * now-INDEPENDENT (base) conditions select — the validity view can HIDE a
 * row whose valid_from is still in the future, and that hidden row's
 * upcoming edge is precisely the boundary the cache must wait for (an
 * edges scan over the validity-filtered rows would never see it and the
 * stale count would serve forever past a real recompute point). The count
 * itself applies the validity clause BEFORE the dedup window, exactly the
 * way countLiveDeduped applies the full clause — same rows in, same count
 * out. Boundaries come from RAW rows (pre-dedup), which is conservative:
 * an edge on a non-surviving duplicate row only forces a harmless early
 * recompute, never a wrong total. next_edge NULL (no boundary ahead) means
 * nothing the base row set holds can flip the view for any future now —
 * Infinity, cached for the corpus lifetime.
 *
 * Edge windows match the validity clause exactly:
 *   - valid_from STRICTLY ahead of now (a row whose valid_from == now is
 *     already counted at now; no flip AT now), and
 *   - valid_until >= now (valid_until == now is the LAST counted instant,
 *     so the earliest flip after computedAt can be AT computedAt itself).
 */
async function countLiveDedupedWithNextValidity(
  db: Database,
  fileList: string,
  baseWhereClause: string,
  validityClause: string,
  nowLit: string,
): Promise<{ total: number; nextEdgeMs: number }> {
  const nowAnchor = tryCastTimestampLiteral(nowLit);
  const sql = `
    WITH raw AS MATERIALIZED (
      SELECT id, key, domain, author, timestamp, valid_from, valid_until, action, attributes
      FROM read_json([${fileList}], format='newline_delimited', ignore_errors=true, ${READ_JSON_COLUMNS})
      ${baseWhereClause}
    ),
    live_current AS (
      SELECT id FROM raw
      ${validityClause}
      GROUP BY id
      HAVING arg_max(action, try_cast(timestamp AS TIMESTAMP)) != 'tombstone'
    ),
    edges AS (
      SELECT min(edge) AS next_edge FROM (
        SELECT try_cast(valid_from AS TIMESTAMP) AS edge FROM raw
        WHERE valid_from IS NOT NULL
              AND try_cast(valid_from AS TIMESTAMP) > ${nowAnchor}
        UNION ALL
        SELECT try_cast(valid_until AS TIMESTAMP) AS edge FROM raw
        WHERE valid_until IS NOT NULL
              AND try_cast(valid_until AS TIMESTAMP) >= ${nowAnchor}
      ) upcoming
    )
    SELECT (SELECT COUNT(*) FROM live_current) AS total,
           epoch_ms((SELECT next_edge FROM edges)) AS next_edge
  `;
  const result = await runRawQuery(db, sql);
  const total = Number(result?.[0]?.total ?? 0);
  const nextEdgeRaw = result?.[0]?.next_edge;
  const nextEdgeMs =
    nextEdgeRaw == null ? Number.POSITIVE_INFINITY : Number(deepConvertBigInts(nextEdgeRaw));
  return { total, nextEdgeMs };
}

/** Cast an ISO instant string as a TIMESTAMP literal (injection-escaped). */
function tryCastTimestampLiteral(isoInstant: string): string {
  return `try_cast('${escapeSqlLiteral(isoInstant)}' AS TIMESTAMP)`;
}

/**
 * PERF-DUCKBRAIN-001: one read_json scan yielding BOTH the bounded page and
 * the exact total, without the whole-corpus window sort.
 *
 * The current fused statement pays a full ROW_NUMBER dedup sort to return a
 * single page. This variant reads the files ONCE into a materialized CTE,
 * derives the page as a bounded recency top-k (a heap, not a sort), and
 * derives the total as an arg_max GROUP BY over that same scan (a hash
 * aggregation, not a sort). Sharing ONE read_json is what keeps the
 * file-dominated namespaces fast (fleet-quality, 29k files): two separate
 * statements would re-ingest every chunk file twice.
 */
interface BoundedReadResult {
  pageRows: RawJsonRow[];
  total: number;
}

async function runBoundedRead(
  db: Database,
  fileList: string,
  innerWhereClause: string,
  window: number,
): Promise<BoundedReadResult> {
  const sql = `
    WITH src AS MATERIALIZED (
      SELECT id, key, domain, timestamp, valid_from, valid_until, author, action, embedding_text, attributes,
             epoch_ms(try_cast(timestamp AS TIMESTAMP)) AS __ts_ms
      FROM read_json([${fileList}], format='newline_delimited', ignore_errors=true, ${READ_JSON_COLUMNS})
      ${innerWhereClause}
    ),
    total AS (
      SELECT COUNT(*) AS __total FROM (
        SELECT id FROM src GROUP BY id HAVING arg_max(action, try_cast(timestamp AS TIMESTAMP)) != 'tombstone'
      ) t
    ),
    page AS (
      SELECT * FROM src ORDER BY try_cast(timestamp AS TIMESTAMP) DESC NULLS LAST, id ASC LIMIT ${window}
    )
    SELECT kind, id, key, domain, timestamp, valid_from, valid_until, author, action, embedding_text, attributes, __ts_ms, __total
    FROM (
      SELECT 'row' AS kind, p.*, 0 AS __total FROM page p
      UNION ALL
      SELECT 'total' AS kind, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, t.__total FROM total t
    ) fused
    ORDER BY kind DESC, try_cast(timestamp AS TIMESTAMP) DESC NULLS LAST, id ASC
  `;
  const result = await runRawQuery(db, sql);
  const pageRows: RawJsonRow[] = [];
  let total = 0;
  for (const row of result as any[]) {
    if (row?.kind === "total") {
      // COUNT(*) comes back as BIGINT; Number() normalizes it.
      total = Number(row.__total ?? 0);
    } else if (row?.kind === "row") {
      pageRows.push(row as RawJsonRow);
    }
  }
  return { pageRows, total };
}

/**
 * PERF-DUCKBRAIN-003: exact live count over the FULL chunk list, cached
 * under (corpus freshness, now-independent query semantics, validity
 * lifetime).
 *
 * The slice read can never produce the namespace-global total by itself —
 * ids living in excluded segments are invisible to it — so when a proved
 * slice serves the PAGE, the total still comes from a full-corpus
 * countLiveDeduped scan. To keep that exactness affordable, the result is
 * cached under a digest of the CURRENT per-file stats the corruption audit
 * just observed (path + size + mtimeMs of every chunk) plus the query's
 * now-INDEPENDENT semantics, with the validity view handled by its own
 * exactness anchor: any append/delete/create changes some chunk's
 * (size, mtimeMs) or the file set, which changes the digest and forces a
 * recompute. This is the same freshness signal corruption.ts itself caches
 * content verdicts under — a directory-mtime key is explicitly NOT used
 * (an append does not change the directory mtime).
 *
 * WHY THE KEY CANNOT DIGEST THE WHOLE WHERE CLAUSE: the recall surface sets
 * `now` on every request (RETR-011), and the validity clause embeds it — a
 * whole-clause digest changes key on every request and the cache never
 * serves (measured live: every warm list request re-ran the full-corpus
 * count, erasing PERF-003's warm win on the real serving path). The key
 * therefore digests the BASE conditions (everything but the validity
 * clause) plus whether a current validity view is active at all, and the
 * entry records the next instant the view could change the count
 * (countLiveDedupedWithNextValidity's nextEdge): an entry computed at
 * now=t is served for requests with now' in [t, nextEdge) and recomputed
 * at the first now' >= nextEdge (or a clock step backwards — computedAtMs
 * guards that too). historical=true / now unset are now-independent, so
 * nextEdge = Infinity, and the count runs through plain countLiveDeduped.
 *
 * The count itself always runs under the FULL clause (the request's exact
 * validity view), never the bucketed/anchored one — no approximation enters
 * the served numbers, only the cache REUSE window is bounded by the proof.
 */
interface TotalCacheEntry {
  total: number;
  /** Earliest instant the current validity view could change the count (ms epoch); Infinity when now-independent. */
  nextEdgeMs: number;
  /** The now (ms epoch) the count was computed at; 0 when now-independent. */
  computedAtMs: number;
}
const MAX_TOTAL_CACHE_ENTRIES = 128;
const totalCache = new Map<string, TotalCacheEntry>();
const totalCacheMetrics = { hits: 0, misses: 0 };

/** PERF-DUCKBRAIN-003 test seam: total-cache accounting since the last reset. */
export function __totalCacheForTests(action: "reset" | "peek"): {
  entries: number;
  misses: number;
  hits: number;
} {
  if (action === "reset") {
    totalCache.clear();
    totalCacheMetrics.hits = 0;
    totalCacheMetrics.misses = 0;
  }
  return {
    entries: totalCache.size,
    misses: totalCacheMetrics.misses,
    hits: totalCacheMetrics.hits,
  };
}

function totalCacheKey(
  baseWhereClause: string,
  hasValidityView: boolean,
  fileStats: ChunkFileStat[],
): string {
  const hash = createHash("sha1");
  hash.update(baseWhereClause);
  hash.update("\u0000");
  hash.update(hasValidityView ? "view:current" : "view:none");
  hash.update("\u0000");
  for (const stat of fileStats) {
    hash.update(
      `${stat.present ? "1" : "0"}:${stat.size}:${stat.mtimeMs}:${stat.path}\n`,
    );
  }
  return hash.digest("hex");
}

async function cachedLiveTotal(
  db: Database,
  jsonlFiles: string[],
  baseWhereClause: string,
  hasValidityView: boolean,
  validityClause: string,
  nowLit: string | undefined,
  fileStats: ChunkFileStat[],
): Promise<number> {
  const key = totalCacheKey(baseWhereClause, hasValidityView, fileStats);
  const cached = totalCache.get(key);
  const nowMs = hasValidityView && nowLit ? Date.parse(nowLit) : 0;
  if (cached) {
    const stillValid =
      !hasValidityView ||
      (cached.computedAtMs <= nowMs && nowMs < cached.nextEdgeMs);
    if (stillValid) {
      totalCacheMetrics.hits += 1;
      return cached.total;
    }
  }
  totalCacheMetrics.misses += 1;
  const fileList = jsonlFiles.map((f) => `'${f}'`).join(", ");
  let total: number;
  let nextEdgeMs = Number.POSITIVE_INFINITY;
  let computedAtMs = 0;
  if (hasValidityView && nowLit) {
    const counted = await countLiveDedupedWithNextValidity(
      db,
      fileList,
      baseWhereClause,
      validityClause,
      nowLit,
    );
    total = counted.total;
    nextEdgeMs = counted.nextEdgeMs;
    computedAtMs = nowMs;
  } else {
    // No validity view: the count runs under the base clause as-is
    // (historical=true / now unset are now-independent).
    total = await countLiveDeduped(db, fileList, baseWhereClause);
  }
  if (totalCache.size >= MAX_TOTAL_CACHE_ENTRIES) {
    const oldest = totalCache.keys().next().value;
    if (oldest !== undefined) totalCache.delete(oldest);
  }
  totalCache.set(key, { total, nextEdgeMs, computedAtMs });
  return total;
}

/**
 * PERF-DUCKBRAIN-003: the newest-segments slice of a partition list.
 *
 * `jsonlFiles` arrives in collectJsonlFiles order — partition by partition,
 * each partition's segments in ascending compareChunkNames order (oldest
 * first, the partition's active/newest chunk last). Grouping by directory
 * and taking the LAST `take` entries per partition therefore yields the
 * newest `take` segments of every partition, in a stable order. When every
 * partition has at most `take` segments the slice IS the full list.
 */
function sliceNewestSegments(
  jsonlFiles: string[],
  take: number,
): { files: string[]; fullCoverage: boolean } {
  const byPartition = new Map<string, string[]>();
  for (const file of jsonlFiles) {
    const dir = path.dirname(file);
    const list = byPartition.get(dir);
    if (list) list.push(file);
    else byPartition.set(dir, [file]);
  }
  let fullCoverage = true;
  const files: string[] = [];
  for (const list of byPartition.values()) {
    if (list.length > take) {
      fullCoverage = false;
      files.push(...list.slice(list.length - take));
    } else {
      files.push(...list);
    }
  }
  return { files, fullCoverage };
}

/**
 * PERF-DUCKBRAIN-003: can the slice PROVE it fills the page?
 *
 * The page came from a read of the newest segments only. It equals the true
 * page iff no row in an EXCLUDED chunk ranks above the window's cut row —
 * the last (lowest-ranked) row the bounded read returned. Chunks freeze
 * when rotation moves writes to a newer segment (appendToJsonl always
 * resolves to the partition's NEWEST segment), and compaction rewrites set
 * a fresh mtime, so every row in an excluded chunk satisfies
 *
 *   row.timestamp <= chunk mtimeMs   (record time <= append wall time)
 *
 * Combined with the cut row's exact DuckDB-computed epoch (epoch_ms of
 * try_cast — no JS date parsing), requiring EVERY excluded chunk's CURRENT
 * mtime to be strictly below the cut proves no excluded row can tie or
 * outrank the cut: excluded rows have timestamp <= mtime < cut, so they
 * can neither enter the window, displace a window row via the id
 * tiebreak, nor carry a newer tombstone for an id already in the page.
 * NULL-timestamp rows sort NULLS LAST and are covered by the same bound
 * whenever the cut itself is non-NULL; a NULL cut disproves the bound.
 *
 * Excluded chunk mtimes are the CURRENT stats the audit pass just observed
 * — a chunk appended in place has a fresh mtime and the proof fails (the
 * caller widens the slice or falls back to the full list), never a stale
 * directory-level signal.
 */
function sliceProofHolds(
  jsonlFiles: string[],
  take: number,
  cutTsMs: number | null | undefined,
  fileStats: Map<string, ChunkFileStat>,
): boolean {
  if (cutTsMs == null) return false;
  const byPartition = new Map<string, string[]>();
  for (const file of jsonlFiles) {
    const dir = path.dirname(file);
    const list = byPartition.get(dir);
    if (list) list.push(file);
    else byPartition.set(dir, [file]);
  }
  for (const list of byPartition.values()) {
    const slicedHere = Math.min(take, list.length);
    // Everything BEFORE the slice in this partition is excluded.
    for (let i = 0; i < list.length - slicedHere; i += 1) {
      const stat = fileStats.get(list[i]);
      if (!stat || !stat.present) return false;
      if (stat.mtimeMs >= cutTsMs) return false;
    }
  }
  return true;
}

/**
 * PERF-DUCKBRAIN-001: bounded top-k + code dedupe for the PLAIN LIST path.
 *
 * The whole-corpus dedup sort (ROW_NUMBER over every row's id) is what made a
 * limit=10 request pay a full dedup sort to return 10 rows. For the plain
 * list there is no search/attribute/time-range dimension, so the page is just
 * the newest live rows: fetch a bounded recency-ordered window in ONE
 * read_json scan that also yields the exact total, dedupe the page in code,
 * and only REFILL (re-query with a growing window) when duplicate / tombstone
 * collapse leaves the page short. If the page cannot be satisfied within the
 * window cap, return null so the caller falls back to the fused statement
 * (which is exact by construction).
 *
 * PERF-DUCKBRAIN-003: the read is additionally bounded by FILES. The read
 * starts on the newest few segments per partition (the segments writes land
 * in) and widens — slice first, then the raw-row window — until the page is
 * filled AND provable (sliceProofHolds) or the full chunk list is being read
 * (byte-identical to the pre-003 behavior). Whenever a proved partial slice
 * serves the page, the namespace-global total comes from cachedLiveTotal —
 * a full-corpus arg_max count cached under the audit's current per-file
 * stats and the query's now-independent semantics, valid until the next
 * validity boundary (see cachedLiveTotal) — so page AND total stay
 * byte-identical to the full-list read.
 *
 * Returns null when the request is not bounded (no LIMIT) — an unbounded
 * page cannot be sliced by the bounded read, so the caller must use the fused
 * statement.
 */
async function queryPlainListBounded(
  db: Database,
  jsonlFiles: string[],
  filters: MemoryQueryFilters,
  fileStats: ChunkFileStat[],
): Promise<QueryMemoriesWithTotalResult | null> {
  const limit = filters.limit;
  if (limit === undefined) {
    return null; // unbounded page — fused statement returns everything
  }

  const offset = filters.offset ?? 0;
  const needed = offset + limit;

  const innerConditions = buildWhereConditions(filters);
  const innerWhereClause =
    innerConditions.length > 0 ? `WHERE ${innerConditions.join(" AND ")}` : "";

  // PERF-DUCKBRAIN-003: split the validity conditions out of the base
  // conditions. The total cache keys on the NOW-INDEPENDENT query
  // semantics — the recall surface embeds a fresh `now` (RETR-011) in the
  // validity clause of every request, so a clause-whole digest changes key
  // per request and the cached total never serves. The validity VIEW is
  // carried by the count's exactness anchor (see cachedLiveTotal and
  // countLiveDedupedWithNextValidity), never by the key: the served count
  // always comes from the FULL clause, the key only decides reuse.
  const validityConditions = buildValidityConditions(
    filters.historical,
    filters.now,
  );
  const hasValidityView = validityConditions.length > 0;
  const baseConditions = innerConditions.filter(
    (condition) => !validityConditions.includes(condition),
  );
  const baseWhereClause =
    baseConditions.length > 0 ? `WHERE ${baseConditions.join(" AND ")}` : "";
  const validityClause =
    hasValidityView ? `WHERE ${validityConditions.join(" AND ")}` : "";

  // Positional freshness map: scanMalformedLinesDetailed preserves the input
  // order, so fileStats[i] is the CURRENT stat of jsonlFiles[i]. Keyed by the
  // exact string the read path uses (no path.resolve re-normalization drift).
  const statByPath = new Map<string, ChunkFileStat>();
  for (let i = 0; i < jsonlFiles.length && i < fileStats.length; i += 1) {
    statByPath.set(jsonlFiles[i], fileStats[i]);
  }

  // limit=0: empty page, but the true total is still reported (GAP-023/024).
  if (limit === 0) {
    const total = await cachedLiveTotal(
      db,
      jsonlFiles,
      baseWhereClause,
      hasValidityView,
      validityClause,
      filters.now,
      fileStats,
    );
    return { memories: [], total };
  }

  const maxSegmentsPerPartition = (() => {
    const perPartition = new Map<string, number>();
    for (const file of jsonlFiles) {
      const dir = path.dirname(file);
      perPartition.set(dir, (perPartition.get(dir) ?? 0) + 1);
    }
    let max = 1;
    for (const count of perPartition.values()) {
      if (count > max) max = count;
    }
    return max;
  })();

  // Bounded top-k page (fused with the total in one scan) + refill on
  // under-fill; PERF-DUCKBRAIN-003 adds the newest-segment file bound.
  let window = needed + PLAIN_LIST_DEDUP_SLACK;
  let take = Math.min(PLAIN_LIST_SLICE_START, maxSegmentsPerPartition);
  for (;;) {
    if (window > PLAIN_LIST_MAX_WINDOW) {
      // Could not satisfy the page within the cap — fall back to the fused
      // statement for exactness.
      return null;
    }
    const { files: slicedFiles, fullCoverage } = sliceNewestSegments(
      jsonlFiles,
      take,
    );
    const fileList = slicedFiles.map((f) => `'${f}'`).join(", ");
    const { pageRows, total: sliceTotal } = await runBoundedRead(
      db,
      fileList,
      innerWhereClause,
      window,
    );
    const exhausted = pageRows.length < window;
    const memories = dedupePage(pageRows, offset, limit);
    if (memories.length === limit) {
      if (fullCoverage) {
        // The read covered the whole chunk list — the slice total IS the
        // exact global total (pre-003 behavior, byte-identical).
        return { memories, total: sliceTotal };
      }
      const cut = pageRows[pageRows.length - 1];
      const cutTsMs = cut?.__ts_ms == null ? null : Number(cut.__ts_ms);
      if (sliceProofHolds(jsonlFiles, take, cutTsMs, statByPath)) {
        // The slice provably fills the page. The total is namespace-global,
        // which a partial slice cannot count — serve the exact full-corpus
        // total (cached under the audit's current per-file stats).
        const total = await cachedLiveTotal(
          db,
          jsonlFiles,
          baseWhereClause,
          hasValidityView,
          validityClause,
          filters.now,
          fileStats,
        );
        return { memories, total };
      }
      // Cannot prove — widen the slice (never widen the window here: the
      // page is already full, coverage is what failed).
      take = Math.min(take * 2, maxSegmentsPerPartition);
      continue;
    }
    if (exhausted) {
      if (fullCoverage) {
        // Fewer rows exist than the window asked for — the short page is the
        // exact answer (pre-003 behavior).
        return { memories, total: sliceTotal };
      }
      // The slice ran out of rows before filling the page — excluded
      // segments may hold both more rows and newer ones. Widen coverage.
      take = Math.min(take * 2, maxSegmentsPerPartition);
      continue;
    }
    // Page short with rows still unread: duplicate/tombstone collapse —
    // the pre-003 refill (grow the raw-row window, same slice).
    window *= 2;
  }
}

/**
 * Query memories AND their true total.
 *
 * PERF-DUCKBRAIN-001: the plain-list case (no query/embedding/attr/time-range)
 * is served by a bounded top-k + code dedupe read (queryPlainListBounded)
 * instead of the whole-corpus dedup sort, because the ledger shows those
 * requests (5,968 slow calls with no query string) paid a full dedup sort to
 * return a single page. Every filtered/search/attribute/time-range request
 * keeps the original fused statement (queryMemoriesWithTotalFused) verbatim.
 *
 * (Historical PERF-003 note — the fused statement is unchanged: it mounted
 * the files once, computed the dedup window ONCE, and derived both the page
 * and the total from that single materialized set, byte-identical to the old
 * queryMemories + countMemories two-scan pair.)
 *
 * @param db - DuckDB database instance
 * @param partitionPaths - Array of absolute partition paths to query
 * @param filters - Optional query filters (limit/offset slice the page;
 *   the total is always the unlimited match count)
 * @returns { memories, total }
 */
export async function queryMemoriesWithTotal(
  db: Database,
  partitionPaths: string[],
  filters?: MemoryQueryFilters,
): Promise<QueryMemoriesWithTotalResult> {
  const empty: QueryMemoriesWithTotalResult = { memories: [], total: 0 };
  if (partitionPaths.length === 0) {
    return empty;
  }

  const jsonlFiles = collectJsonlFiles(partitionPaths);
  if (jsonlFiles.length === 0) {
    return empty;
  }

  // QA-DUCKBRAIN-022: the total must not silently omit skipped rows.
  // PERF-DUCKBRAIN-003: the audit's per-file stats are also the CURRENT
  // (size, mtimeMs) of every chunk — the freshness oracle the bounded
  // plain-list path uses for its slice proof and its cached total.
  const audit = auditServingChunks(jsonlFiles);
  const fileStats = audit.fileStats ?? [];

  if (isPlainList(filters)) {
    const bounded = await queryPlainListBounded(
      db,
      jsonlFiles,
      filters ?? {},
      fileStats,
    );
    if (bounded !== null) {
      return bounded;
    }
    // Not bounded (no LIMIT, or window cap exceeded) — fall through to fused.
  }

  return queryMemoriesWithTotalFused(db, jsonlFiles, filters);
}

/**
 * The original PERF-003 fused statement — the filtered/search path AND the
 * exactness fallback for the bounded plain-list read.
 *
 * Rows and total are byte-identical to the old two-scan path: same inner
 * conditions, same dedup window, same ordering, same LIMIT/OFFSET placement,
 * same row mapper (mapMemoryRow), and the total is a COUNT(*) over exactly
 * the set countMemories counts.
 *
 * @param db - DuckDB database instance
 * @param jsonlFiles - Absolute JSONL chunk paths to query (pre-collected)
 * @param filters - Optional query filters (limit/offset slice the page;
 *   the total is always the unlimited match count)
 * @returns { memories, total }
 */
export async function queryMemoriesWithTotalFused(
  db: Database,
  jsonlFiles: string[],
  filters?: MemoryQueryFilters,
): Promise<QueryMemoriesWithTotalResult> {
  const empty: QueryMemoriesWithTotalResult = { memories: [], total: 0 };
  if (jsonlFiles.length === 0) {
    return empty;
  }

  const innerConditions = buildWhereConditions(filters);
  const innerWhereClause =
    innerConditions.length > 0 ? `WHERE ${innerConditions.join(" AND ")}` : "";

  // Same dedup/tombstone semantics as queryMemories/countMemories
  const outerWhereClause = "__rn = 1 AND action != 'tombstone'";

  // RETR-005 default order; the semantic leg keeps cosine similarity first
  // (same override queryMemories applies).
  let orderByClause = DEFAULT_ORDER_BY;
  if (filters?.query && filters?.embedding) {
    const embeddingStr = `[${filters.embedding.join(",")}]`;
    orderByClause = `ORDER BY array_cosine_distance(embedding, ${embeddingStr}::FLOAT[384]) ASC, try_cast(timestamp AS TIMESTAMP) DESC NULLS LAST, id ASC`;
  }

  // GAP-023: LIMIT 0 must emit "LIMIT 0" (undefined → no clause).
  const limitClause =
    filters?.limit !== undefined ? `LIMIT ${filters.limit}` : "";

  // DB-GAP-046: page window emitted only alongside a LIMIT (same rule as
  // queryMemories — a bare OFFSET would split callers onto a second path).
  const offsetClause =
    filters?.limit !== undefined && (filters?.offset ?? 0) > 0
      ? `OFFSET ${filters.offset}`
      : "";

  const fileList = jsonlFiles.map((f) => `'${f}'`).join(", ");
  const sql = `
    WITH matches AS MATERIALIZED (
      SELECT id, key, domain, timestamp, valid_from, valid_until, author, action, embedding_text, attributes
      FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY id ORDER BY try_cast(timestamp AS TIMESTAMP) DESC NULLS LAST) as __rn
        FROM read_json([${fileList}], format='newline_delimited', ignore_errors=true, ${READ_JSON_COLUMNS})
        ${innerWhereClause}
      ) sub
      WHERE ${outerWhereClause}
    ),
    total AS MATERIALIZED (
      SELECT COUNT(*) AS __total FROM matches
    ),
    page AS (
      SELECT * FROM matches
      ${orderByClause}
      ${limitClause}
      ${offsetClause}
    )
    SELECT kind, id, key, domain, timestamp, valid_from, valid_until, author, action, embedding_text, attributes, __total
    FROM (
      SELECT 'row' AS kind, p.*, 0 AS __total FROM page p
      UNION ALL
      SELECT 'total' AS kind, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, t.__total FROM total t
    ) fused
    ORDER BY kind DESC
  `;

  return new Promise<QueryMemoriesWithTotalResult>((resolve, reject) => {
    try {
      db.all(sql, (err: any, result: any) => {
        if (err) {
          const errMsg = err?.message || String(err);
          console.error("DuckDB query error:", err);
          // BUG-034: Propagate connection errors so callers can retry
          // (same contract as queryMemories/countMemories).
          if (
            /connection.*never established|closed already|locked/i.test(errMsg)
          ) {
            reject(new Error(`DUCKDB_CONNECTION_LOST: ${errMsg}`));
            return;
          }
          resolve(empty);
          return;
        }

        if (!result || !Array.isArray(result)) {
          resolve(empty);
          return;
        }

        const memories: MemoryType[] = [];
        let total = 0;
        for (const row of result as any[]) {
          if (row?.kind === "total") {
            // COUNT(*) comes back as BIGINT; Number() normalizes it
            total = Number(row.__total ?? 0);
          } else if (row?.kind === "row") {
            memories.push(mapMemoryRow(row));
          }
        }
        resolve({ memories, total });
      });
    } catch (error) {
      console.error("DuckDB query error:", error);
      resolve(empty);
    }
  });
}

/**
 * Insert a memory record through the SUPA-2 namespace serializer.
 *
 * @param db - DuckDB database instance (retained for API compatibility)
 * @param memory - Memory record to insert
 * @param partitionPath - Absolute path to partition directory
 * @param principal - Authenticated principal for the SUPA-4 authorization seam
 */
export async function insertMemory(
  _db: Database,
  memory: MemoryType,
  partitionPath: string,
  principal?: AuthPrincipal,
): Promise<void> {
  await insertMemoryToPartition(memory, partitionPath, principal);
}

interface SerializationTarget {
  namespacesPath: string;
  ns: string;
  namespacePath: string;
  targetPath: string;
  partitionPath?: string;
}

/** Resolve a production namespace partition, with a legacy test-path fallback. */
function resolveSerializationTarget(
  partitionPath: string,
): SerializationTarget {
  // GAP-062: classify against the config-derived root, never the caller's cwd.
  const configuredRoot = resolveNamespacesPath();
  const resolvedPartition = path.resolve(partitionPath);
  const relative = path.relative(configuredRoot, resolvedPartition);
  const parts = relative.split(path.sep).filter(Boolean);
  if (
    relative !== "" &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative) &&
    parts.length >= 2
  ) {
    const [ns, ...partitionParts] = parts;
    const relativePartition = partitionParts.join(path.sep) + path.sep;
    return {
      namespacesPath: configuredRoot,
      ns,
      namespacePath: path.join(configuredRoot, ns),
      targetPath: path.join(relativePartition, "current.jsonl"),
      partitionPath: relativePartition,
    };
  }

  // `insertMemory` is a historical exported helper used by isolated tests with
  // an arbitrary partition directory. Treat that directory as a standalone
  // namespace while still routing its write through the serializer.
  return {
    namespacesPath: path.dirname(resolvedPartition),
    ns: path.basename(resolvedPartition),
    namespacePath: resolvedPartition,
    targetPath: "current.jsonl",
  };
}

/** Insert memory to partition through the one writer that owns its namespace. */
async function insertMemoryToPartition(
  memory: MemoryType,
  partitionPath: string,
  principal?: AuthPrincipal,
): Promise<void> {
  const target = resolveSerializationTarget(partitionPath);
  fs.mkdirSync(target.namespacePath, { recursive: true });
  const writerOptions = target.partitionPath
    ? { namespacesPath: target.namespacesPath }
    : {
        namespacesPath: target.namespacesPath,
        // Historical standalone test helper paths are not namespace git repositories.
        scheduleCommit: () => undefined,
      };
  const result = await getNamespaceWriter(target.ns, writerOptions).enqueue({
    ns: target.ns,
    table: "memories",
    op:
      memory.action === "tombstone"
        ? "delete"
        : memory.action === "update"
          ? "update"
          : "insert",
    record: memory,
    principal,
    targetPath: target.targetPath,
    ...(target.partitionPath ? { partitionPath: target.partitionPath } : {}),
  });
  if (!result.ok) {
    const error = new Error(`${result.code}: ${result.message}`) as Error & {
      code?: string;
      retryAfter?: number;
    };
    error.code = result.code;
    error.retryAfter = result.retryAfter;
    throw error;
  }
}

/**
 * Create tombstone record for a memory
 *
 * Appends a tombstone record with the same ID as the original memory.
 * Never deletes files - preserves git history.
 *
 * @param db - DuckDB database instance
 * @param memoryId - ID of memory to tombstone
 * @param partitionPath - Partition path to search and append to
 * @param reason - Optional reason for deletion (stored in attributes)
 * @param author - Optional author identity for the tombstone (DB-GAP-031:
 *  authenticated principal; absent = the original memory's author)
 */
export async function tombstoneMemory(
  db: Database,
  memoryId: string,
  partitionPath: string,
  reason?: string,
  author?: string,
  principal?: AuthPrincipal,
): Promise<void> {
  // Find the original memory in the partition using DuckDB WHERE clause
  const memories = await queryMemories(db, [partitionPath], {
    id: memoryId,
    limit: 1,
  });
  const originalMemory = memories[0];

  if (!originalMemory) {
    // Memory not found - create tombstone anyway with minimal data
    // This handles cases where the memory might be in a different partition
    const tombstone: MemoryType = {
      id: memoryId,
      key: "/unknown",
      domain: "raw_note",
      timestamp: new Date().toISOString(),
      author: author ?? "system@localhost.localdomain",
      action: "tombstone",
      embedding_text: "",
      attributes: reason ? { tombstone_reason: reason } : {},
    };
    await insertMemoryToPartition(tombstone, partitionPath, principal);
    return;
  }

  // Create tombstone record copying all fields from original — the author
  // is replaced by the authenticated principal when one was provided
  // (DB-GAP-031), else the original memory's author is preserved.
  const tombstone: MemoryType = {
    ...originalMemory,
    action: "tombstone",
    timestamp: new Date().toISOString(),
    author: author ?? originalMemory.author,
    attributes: {
      ...originalMemory.attributes,
      ...(reason ? { tombstone_reason: reason } : {}),
    },
  };

  await insertMemoryToPartition(tombstone, partitionPath, principal);
}
