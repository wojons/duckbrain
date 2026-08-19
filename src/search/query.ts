/**
 * Keyword search query path (RETR-001).
 *
 * Runs a query against a namespace's rebuilt FTS sidecar (see index.ts):
 * the FTS `match_bm25` macro supplies BM25 candidates (AND semantics,
 * OR fallback when no row has every token), a LIKE pass over raw_text
 * supplies prefix (trailing `*`) candidates, and rank.ts orders the union
 * by exact-literal → all-tokens → any-token, with BM25 + recency inside a
 * tier. Pure offline — no embedding provider involved.
 */

import path from "path";
import fs from "fs";
import { Database } from "duckdb";
import {
  indexDbPath,
  SearchIndexMissingError,
  DB_CONFIG,
  listNamespaces,
} from "./index";
import { mapDigits, splitQuery } from "./transform";
import {
  dropStopwords,
  rankKeywordResults,
  highlightMatches,
  type IndexRow,
} from "./rank";
import {
  buildTimeRangeConditions,
  buildAttributeConditions,
  buildValidityConditions,
} from "../duckdb/queries";

/** Safety cap on the candidate pool — mirrors recallTool's MAX_CANDIDATES. */
export const MAX_KEYWORD_CANDIDATES = 1000;

export interface KeywordHit {
  id: string;
  key: string;
  domain: string;
  timestamp: string;
  author: string;
  action: string;
  embedding_text: string;
  attributes: Record<string, unknown>;
  /** BM25 relevance score (keyword path only) */
  score: number;
  /** Snippet around the first matched token */
  snippet: string;
  /** RETR-008: snippet with the matched term(s) wrapped in `<mark>…</mark>`
   *  — a marker style the CLI can print. The raw `snippet` field above
   *  stays marker-free for API/MCP consumers; this rides alongside it. */
  highlightedSnippet?: string;
  /** RETR-011: optional validity-window start (ISO-8601) — echoed from the
   *  row when present (absent on pre-RETR-011 rows and stale sidecars). */
  valid_from?: string;
  /** RETR-011: optional validity-window end (ISO-8601). */
  valid_until?: string;
  /** Source namespace of this hit (RETR-007) — an explicit facet, never
   *  inferred from the key. Single-namespace searches carry the searched
   *  namespace; all-namespaces unions carry each hit's own namespace. */
  namespace: string;
}

export interface KeywordSearchResult {
  memories: KeywordHit[];
  /** True total of matches, unlimited by limit (bounded by MAX_KEYWORD_CANDIDATES) */
  total: number;
  /** RETR-007: namespaces that contributed candidates (all-namespaces
   *  union only; absent on single-namespace results) */
  namespacesSearched?: string[];
  /** RETR-007: namespaces skipped because they have no rebuilt index
   *  (all-namespaces union only; absent on single-namespace results) */
  namespacesSkipped?: string[];
}

export interface KeywordSearchOptions {
  /** Max results (default 10; 0 = count-only, no rows fetched) */
  limit?: number;
  /** Candidate pool cap (default MAX_KEYWORD_CANDIDATES) */
  maxCandidates?: number;
  /** RETR-003: only rows at or after this ISO-8601 instant (timestamp or
   *  chat-archive key date facet) */
  after?: string;
  /** RETR-003: only rows at or before this ISO-8601 instant (timestamp or
   *  chat-archive key date facet) */
  before?: string;
  /** RETR-006: only rows whose `attributes` JSON contains name → value
   *  (exact match, json_extract_string semantics). */
  attr?: Record<string, string>;
  /** RETR-011: validity-window filtering — when `now` is provided and
   *  `historical` is not true, only rows whose validity window contains
   *  `now` are candidates (expired / not-yet-valid rows are excluded).
   *  Requires a rebuilt sidecar (valid_from/valid_until columns); stale
   *  sidecars without the columns skip the clause and degrade gracefully. */
  historical?: boolean;
  /** RETR-011: the "now" instant (ISO-8601) the validity window is
   *  compared against — set once per recall request. */
  now?: string;
  /** RETR-007: restrict the all-namespaces union to these namespace names
   *  (default: every manifest namespace under the namespaces root). */
  namespaces?: string[];
}

function escapeSqlLiteral(s: string): string {
  return s.replace(/'/g, "''");
}

function escapeLikePattern(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function allAsync(db: Database, sql: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, (err: any, result: any) =>
      err ? reject(err) : resolve(result ?? []),
    );
  });
}

/**
 * RETR-011: does this sidecar's `memories` table carry the validity columns?
 *
 * Sidecars rebuilt before RETR-011 lack valid_from/valid_until; the
 * current-view validity clause would error on them, so the keyword leg
 * checks once per search and degrades gracefully (no validity filtering)
 * until the operator runs `duckbrain search-index rebuild`.
 */
async function sidecarHasValidityColumns(db: Database): Promise<boolean> {
  try {
    const rows = await allAsync(db, "PRAGMA table_info(memories)");
    const names = new Set(
      rows.map((r: any) => String(r.name ?? r.column_name ?? "")),
    );
    return names.has("valid_from") && names.has("valid_until");
  } catch {
    return false;
  }
}

function closeAsync(db: Database): Promise<void> {
  return new Promise((resolve) => db.close(() => resolve()));
}

const ROW_COLUMNS =
  "id, key, domain, timestamp, valid_from, valid_until, author, action, embedding_text, attributes, raw_text, search_text";

function toIndexRow(row: any): IndexRow {
  return {
    id: String(row.id ?? ""),
    key: String(row.key ?? ""),
    domain: String(row.domain ?? ""),
    timestamp: String(row.timestamp ?? ""),
    // RETR-011: optional validity window — echoed when the sidecar carries
    // the columns (stale sidecars yield undefined).
    ...(typeof row.valid_from === "string"
      ? { valid_from: row.valid_from }
      : {}),
    ...(typeof row.valid_until === "string"
      ? { valid_until: row.valid_until }
      : {}),
    author: String(row.author ?? ""),
    action: String(row.action ?? ""),
    embedding_text: String(row.embedding_text ?? ""),
    attributes: String(row.attributes ?? "{}"),
    raw_text: String(row.raw_text ?? ""),
    search_text: String(row.search_text ?? ""),
    bm25: typeof row.score === "number" ? row.score : undefined,
  };
}

function parseAttributes(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Collect the keyword candidate rows for one namespace's FTS sidecar
 * (RETR-001; factored out of keywordSearch for the RETR-007 union).
 *
 * Runs the BM25 pass (AND semantics with OR fallback) plus the raw-text
 * LIKE prefix pass, applying the same time/attr window clauses as the
 * recall legs. Rows carry their source namespace (row.namespace) so a
 * cross-namespace union ranks with an explicit facet.
 */
async function collectKeywordCandidates(
  namespacePath: string,
  query: string,
  opts: KeywordSearchOptions,
): Promise<IndexRow[]> {
  const maxCandidates = opts.maxCandidates ?? MAX_KEYWORD_CANDIDATES;
  const namespace = path.basename(namespacePath);

  const dbPath = indexDbPath(namespacePath);
  if (!fs.existsSync(dbPath)) {
    throw new SearchIndexMissingError(namespace, namespacePath);
  }

  const { tokens, prefix } = splitQuery(query);
  const kept = dropStopwords(tokens);
  // The prefix token (partial digit code) must not reach the FTS query —
  // prefix candidates come from the LIKE pass; its ranking is startsWith.
  const ftsTokens = prefix ? kept.filter((t) => t !== prefix) : kept;

  const candidates = new Map<string, IndexRow>();
  const db = new Database(dbPath, DB_CONFIG);
  // RETR-003: same timestamp + chat-archive-facet bounds as queryMemories —
  // applied to BOTH candidate passes so the keyword leg of a time-scoped
  // recall never surfaces out-of-window rows.
  const timeConditions = buildTimeRangeConditions(opts.after, opts.before);
  const timeClause =
    timeConditions.length > 0 ? ` AND ${timeConditions.join(" AND ")}` : "";
  // RETR-006: same attribute conditions as queryMemories — applied to BOTH
  // candidate passes so an attr-scoped recall never surfaces non-matching
  // rows from the keyword leg (hybrid fusion included).
  const attrConditions = buildAttributeConditions(opts.attr);
  const attrClause =
    attrConditions.length > 0 ? ` AND ${attrConditions.join(" AND ")}` : "";
  // RETR-011: same validity-window conditions as queryMemories — applied to
  // BOTH candidate passes. DEFENSIVE: the clause references valid_from/
  // valid_until columns that only exist on sidecars rebuilt after RETR-011;
  // on a stale sidecar the columns are missing and the clause would make
  // every keyword search error, so it is skipped (the keyword leg degrades
  // to unfiltered validity until `duckbrain search-index rebuild`).
  const validityConditions = (await sidecarHasValidityColumns(db))
    ? buildValidityConditions(opts.historical, opts.now)
    : [];
  const validityClause =
    validityConditions.length > 0
      ? ` AND ${validityConditions.join(" AND ")}`
      : "";
  try {
    if (ftsTokens.length > 0) {
      // Digit-map + collapse separator runs so the query never produces
      // the FTS tokenizer's empty tokens (e.g. "GAP--020").
      const mapped = mapDigits(ftsTokens.join(" ")).replace(
        /[^a-zA-Z0-9]+/g,
        " ",
      );
      const literal = escapeSqlLiteral(mapped.trim());
      const ftsSql = (conjunctive: number) =>
        `SELECT ${ROW_COLUMNS}, fts_main_memories.match_bm25(id, '${literal}', conjunctive := ${conjunctive}) AS score FROM memories WHERE fts_main_memories.match_bm25(id, '${literal}', conjunctive := ${conjunctive}) > 0${timeClause}${attrClause}${validityClause} ORDER BY score DESC LIMIT ${maxCandidates}`;
      let rows = await allAsync(db, ftsSql(1));
      if (rows.length === 0) {
        // AND found nothing — relax to OR (any token) and let rank.ts
        // re-order by tier.
        rows = await allAsync(db, ftsSql(0));
      }
      for (const r of rows) {
        const row = toIndexRow(r);
        candidates.set(row.id, row);
      }
    }

    if (prefix) {
      // Raw-text prefix pass (digit-exact, stemmer-free). Candidates get
      // no BM25 score — tier + recency order them.
      const pattern = `${escapeLikePattern(prefix)}%`;
      const sql = `SELECT ${ROW_COLUMNS}, 0 AS score FROM memories WHERE raw_text LIKE '${escapeSqlLiteral(pattern)}' ESCAPE '\\'${timeClause}${attrClause}${validityClause} ORDER BY timestamp DESC LIMIT ${maxCandidates}`;
      const rows = await allAsync(db, sql);
      for (const r of rows) {
        const row = toIndexRow(r);
        // A row already found via FTS keeps its real BM25 score.
        if (!candidates.has(row.id)) candidates.set(row.id, row);
      }
    }
  } finally {
    await closeAsync(db);
  }

  for (const row of candidates.values()) {
    row.namespace = namespace;
  }
  return [...candidates.values()];
}

/**
 * Run a keyword search against a namespace's rebuilt FTS sidecar.
 *
 * @param namespacePath absolute path to the namespace
 * @param rawQuery the raw search string (trailing `*` = prefix on last token)
 * @param opts limit / candidate cap
 * @throws SearchIndexMissingError when the sidecar has not been rebuilt
 */
export async function keywordSearch(
  namespacePath: string,
  rawQuery: string,
  opts: KeywordSearchOptions = {},
): Promise<KeywordSearchResult> {
  const query = rawQuery.trim();
  const limit = opts.limit ?? 10;
  const namespace = path.basename(namespacePath);

  const rows = await collectKeywordCandidates(namespacePath, query, opts);

  // Rank: exact-literal → all-tokens → any-token, then BM25, then recency.
  const body = query.endsWith("*") ? query.slice(0, -1).trimEnd() : query;
  const { tokens, prefix } = splitQuery(query);
  const kept = dropStopwords(tokens);
  const ranked = rankKeywordResults(rows, body, kept, prefix);

  const total = ranked.length;
  const top = limit > 0 ? ranked.slice(0, limit) : [];
  const memories: KeywordHit[] = top.map((hit) => ({
    id: hit.row.id,
    key: hit.row.key,
    domain: hit.row.domain,
    timestamp: hit.row.timestamp,
    author: hit.row.author,
    action: hit.row.action,
    embedding_text: hit.row.embedding_text,
    attributes: parseAttributes(hit.row.attributes),
    score: hit.score,
    snippet: hit.snippet,
    // RETR-008: highlighted display form — matched terms wrapped in
    // `<mark>…</mark>` (raw snippet stays available above).
    highlightedSnippet: highlightMatches(hit.snippet, kept, prefix, body),
    // RETR-011: echo the validity window when the row carries it.
    ...(hit.row.valid_from !== undefined
      ? { valid_from: hit.row.valid_from }
      : {}),
    ...(hit.row.valid_until !== undefined
      ? { valid_until: hit.row.valid_until }
      : {}),
    namespace: hit.row.namespace ?? namespace,
  }));

  return { memories, total };
}

/**
 * RETR-007: cross-namespace keyword search (Q-4).
 *
 * Unions the keyword candidate sets of every manifest namespace under the
 * namespaces root (or the explicitly requested subset) and ranks the
 * combined pool ONCE with the same tier → BM25 → recency ordering as a
 * single-namespace search, so equal-tier hits from different namespaces
 * compete by score and recency — never by namespace. Each returned hit
 * carries an explicit `namespace` facet identifying its source.
 *
 * Namespaces without a rebuilt index are skipped (reported via
 * namespacesSkipped) — a partial union beats a hard failure when some
 * sidecars are stale — but when NO namespace has an index the rebuild-hint
 * error is thrown, preserving the single-namespace contract that a missing
 * index must error rather than silently return nothing.
 *
 * @param namespacesRoot absolute path to the namespaces root (config
 *   namespacesPath)
 * @param rawQuery the raw search string (trailing `*` = prefix on last token)
 */
export async function keywordSearchAllNamespaces(
  namespacesRoot: string,
  rawQuery: string,
  opts: KeywordSearchOptions = {},
): Promise<KeywordSearchResult> {
  const query = rawQuery.trim();
  const limit = opts.limit ?? 10;
  const nsNames = opts.namespaces ?? listNamespaces(namespacesRoot);

  if (nsNames.length === 0) {
    return {
      memories: [],
      total: 0,
      namespacesSearched: [],
      namespacesSkipped: [],
    };
  }

  const searched: string[] = [];
  const skipped: string[] = [];
  const rows: IndexRow[] = [];
  for (const ns of nsNames) {
    try {
      rows.push(
        ...(await collectKeywordCandidates(
          path.join(namespacesRoot, ns),
          query,
          opts,
        )),
      );
      searched.push(ns);
    } catch (error) {
      // A namespace without a rebuilt index is skipped, not fatal — but
      // any other failure (corrupt sidecar, IO error) stays loud.
      if (error instanceof SearchIndexMissingError) {
        skipped.push(ns);
        continue;
      }
      throw error;
    }
  }

  if (searched.length === 0) {
    // No namespace was searchable — surface the rebuild hint instead of a
    // silently-empty union.
    const first = nsNames[0];
    throw new SearchIndexMissingError(first, path.join(namespacesRoot, first));
  }

  // Rank the union once with the same ordering a single-namespace search
  // uses: exact-literal → all-tokens → any-token, then BM25, then recency.
  const body = query.endsWith("*") ? query.slice(0, -1).trimEnd() : query;
  const { tokens, prefix } = splitQuery(query);
  const kept = dropStopwords(tokens);
  const ranked = rankKeywordResults(rows, body, kept, prefix);

  const total = ranked.length;
  const top = limit > 0 ? ranked.slice(0, limit) : [];
  const memories: KeywordHit[] = top.map((hit) => ({
    id: hit.row.id,
    key: hit.row.key,
    domain: hit.row.domain,
    timestamp: hit.row.timestamp,
    author: hit.row.author,
    action: hit.row.action,
    embedding_text: hit.row.embedding_text,
    attributes: parseAttributes(hit.row.attributes),
    score: hit.score,
    snippet: hit.snippet,
    // RETR-008: highlighted display form — matched terms wrapped in
    // `<mark>…</mark>` (raw snippet stays available above).
    highlightedSnippet: highlightMatches(hit.snippet, kept, prefix, body),
    // RETR-011: echo the validity window when the row carries it.
    ...(hit.row.valid_from !== undefined
      ? { valid_from: hit.row.valid_from }
      : {}),
    ...(hit.row.valid_until !== undefined
      ? { valid_until: hit.row.valid_until }
      : {}),
    namespace: hit.row.namespace ?? "",
  }));

  return {
    memories,
    total,
    namespacesSearched: searched,
    namespacesSkipped: skipped,
  };
}
