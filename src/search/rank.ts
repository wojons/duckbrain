/**
 * Keyword search ranking and snippet extraction (RETR-001).
 *
 * Ranking tiers (deterministic, exported for RETR-002 hybrid fusion):
 *   tier 0 — exact literal: the raw query appears as a case-insensitive
 *            substring of the memory's searchable text
 *   tier 1 — all tokens: every query token appears (prefix tokens match
 *            via startsWith)
 *   tier 2 — any token: at least one query token appears (OR fallback)
 *
 * Within a tier: BM25 score desc, then timestamp desc (recency tiebreak).
 * The tiers exist because BM25 alone cannot distinguish "contains the
 * exact token GAP-020" from "contains GAP and 020 somewhere apart" — the
 * corpus's dominant regime is exact ticket IDs, cron IDs, UUIDs.
 */

import { tokenize } from "./transform";
import { FTS_STOPWORDS } from "./stopwords";

/** A row as stored in the sidecar index base table. */
export interface IndexRow {
  id: string;
  key: string;
  domain: string;
  timestamp: string;
  author: string;
  action: string;
  embedding_text: string;
  /** Raw attributes JSON (parsed by callers) */
  attributes: string;
  /** Raw searchable text (key + content + attributes) — literal + prefix checks */
  raw_text: string;
  /** Digit-mapped searchable text (FTS matching only) */
  search_text: string;
  /** BM25 score from the FTS query (absent for LIKE-only candidates) */
  bm25?: number;
}

export interface RankedHit {
  row: IndexRow;
  /** 0 = exact literal, 1 = all tokens, 2 = any token */
  tier: number;
  /** BM25 score (0 when the candidate came from the LIKE path) */
  score: number;
  snippet: string;
}

/** The three ranking tiers, exported for RETR-002 fusion tests. */
export const RANK_TIER_EXACT = 0;
export const RANK_TIER_ALL = 1;
export const RANK_TIER_ANY = 2;

/** Words in the index / query must never disagree with the FTS tokenizer. */
const STOPWORDS = FTS_STOPWORDS;

/** Filter stopwords out of a token list (keeps FTS/JS token sets aligned). */
export function dropStopwords(tokens: string[]): string[] {
  return tokens.filter((t) => !STOPWORDS.has(t));
}

/**
 * Compute the ranking tier for one candidate row against the raw query.
 *
 * @param row index row (raw_text is the raw searchable text)
 * @param rawQuery the raw query string, trailing "*" already stripped
 * @param tokens raw query tokens (stopwords already dropped)
 * @param prefix raw prefix token (from a trailing "*"), if any
 */
export function computeTier(
  row: IndexRow,
  rawQuery: string,
  tokens: string[],
  prefix?: string,
): number {
  const hay = row.raw_text.toLowerCase();

  // Tier 0: exact literal substring (only meaningful without a prefix —
  // for "GAP-02*" a bare "gap-02" substring is the prefix tier's job).
  if (!prefix) {
    const literal = rawQuery.toLowerCase();
    if (literal.length > 0 && hay.includes(literal)) return RANK_TIER_EXACT;
  }

  const rowTokens = tokenize(row.raw_text);
  const rowSet = new Set(rowTokens);
  // Every non-prefix token must be present exactly; the prefix token
  // matches via startsWith on any raw token ("02" matches "020").
  const nonPrefixOk = tokens.every((t) => t === prefix || rowSet.has(t));
  if (!nonPrefixOk) return RANK_TIER_ANY;
  if (!prefix) return RANK_TIER_ALL;
  const prefixLower = prefix.toLowerCase();
  return rowTokens.some((t) => t.startsWith(prefixLower))
    ? RANK_TIER_ALL
    : RANK_TIER_ANY;
}

/**
 * Rank candidate rows: tier asc, BM25 desc, timestamp desc.
 * Rows that are not part of the candidate set (no tier-2 match at all)
 * are dropped — callers should only pass FTS/LIKE candidates.
 */
export function rankKeywordResults(
  rows: IndexRow[],
  rawQuery: string,
  tokens: string[],
  prefix?: string,
): RankedHit[] {
  return rows
    .map((row) => {
      const tier = computeTier(row, rawQuery, tokens, prefix);
      return {
        row,
        tier,
        score: typeof row.bm25 === "number" ? row.bm25 : 0,
        snippet: makeSnippet(row.raw_text, tokens, prefix),
      };
    })
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (b.score !== a.score) return b.score - a.score;
      return (
        Date.parse(b.row.timestamp) - Date.parse(a.row.timestamp) ||
        a.row.id.localeCompare(b.row.id)
      );
    });
}

/**
 * Extract a snippet around the first token match in raw text.
 *
 * Anchors on the first case-insensitive occurrence of any query token
 * (longest token first, so "GAP-020" is preferred over "gap"), or the
 * first whitespace-delimited word starting with the prefix for wildcard
 * queries. Windows ±windowWords words around the anchor, ellipsizes.
 */
export function makeSnippet(
  text: string,
  tokens: string[],
  prefix?: string,
  windowWords = 14,
): string {
  if (!text) return "";
  const lower = text.toLowerCase();

  // Whitespace-delimited words with offsets (punctuation stays attached,
  // which keeps ticket IDs intact inside the snippet).
  const words: { w: string; start: number }[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    words.push({ w: m[0], start: m.index });
  }
  if (words.length === 0) return "";

  let anchor = -1;
  if (prefix) {
    const p = prefix.toLowerCase();
    // A word matches the prefix when a non-alphanumeric-separated segment
    // starts with it ("gap-020" contains the segment "020" for prefix "02"
    // — the rank tiers split on the same boundaries).
    for (let i = 0; i < words.length; i++) {
      const segs = words[i].w.toLowerCase().split(/[^a-z0-9]+/);
      if (segs.some((s) => s.startsWith(p))) {
        anchor = i;
        break;
      }
    }
  } else {
    const needles = [...tokens].sort((a, b) => b.length - a.length);
    for (const n of needles) {
      const idx = lower.indexOf(n);
      if (idx === -1) continue;
      // The word containing the match (walk back to the previous word end).
      for (let i = 0; i < words.length; i++) {
        if (
          words[i].start <= idx &&
          (i === words.length - 1 || words[i + 1].start > idx)
        ) {
          anchor = i;
          break;
        }
      }
      if (anchor !== -1) break;
    }
  }

  if (anchor === -1) {
    // Fallback: no token present (defensive) — head of the text.
    const head = words
      .slice(0, windowWords)
      .map((w) => w.w)
      .join(" ");
    return words.length > windowWords ? `${head} …` : head;
  }

  const from = Math.max(0, anchor - windowWords);
  const to = Math.min(words.length - 1, anchor + windowWords);
  const parts: string[] = [];
  if (from > 0) parts.push("…");
  parts.push(
    words
      .slice(from, to + 1)
      .map((w) => w.w)
      .join(" "),
  );
  if (to < words.length - 1) parts.push("…");
  return parts.join(" ");
}
