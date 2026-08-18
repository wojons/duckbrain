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
import { indexDbPath, SearchIndexMissingError, DB_CONFIG } from "./index";
import { mapDigits, splitQuery } from "./transform";
import { dropStopwords, rankKeywordResults, type IndexRow } from "./rank";
import { buildTimeRangeConditions } from "../duckdb/queries";

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
}

export interface KeywordSearchResult {
  memories: KeywordHit[];
  /** True total of matches, unlimited by limit (bounded by MAX_KEYWORD_CANDIDATES) */
  total: number;
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

function closeAsync(db: Database): Promise<void> {
  return new Promise((resolve) => db.close(() => resolve()));
}

const ROW_COLUMNS =
  "id, key, domain, timestamp, author, action, embedding_text, attributes, raw_text, search_text";

function toIndexRow(row: any): IndexRow {
  return {
    id: String(row.id ?? ""),
    key: String(row.key ?? ""),
    domain: String(row.domain ?? ""),
    timestamp: String(row.timestamp ?? ""),
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
        `SELECT ${ROW_COLUMNS}, fts_main_memories.match_bm25(id, '${literal}', conjunctive := ${conjunctive}) AS score FROM memories WHERE fts_main_memories.match_bm25(id, '${literal}', conjunctive := ${conjunctive}) > 0${timeClause} ORDER BY score DESC LIMIT ${maxCandidates}`;
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
      const sql = `SELECT ${ROW_COLUMNS}, 0 AS score FROM memories WHERE raw_text LIKE '${escapeSqlLiteral(pattern)}' ESCAPE '\\'${timeClause} ORDER BY timestamp DESC LIMIT ${maxCandidates}`;
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

  // Rank: exact-literal → all-tokens → any-token, then BM25, then recency.
  const body = query.endsWith("*") ? query.slice(0, -1).trimEnd() : query;
  const ranked = rankKeywordResults(
    [...candidates.values()],
    body,
    kept,
    prefix,
  );

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
  }));

  return { memories, total };
}
