/**
 * Digit-safe text transform for the keyword search index (RETR-001).
 *
 * DuckDB's FTS tokenizer (the one wired into the `fts` extension's
 * `create_fts_index` pragma) only keeps alphabetic tokens: pure-numeric
 * runs are dropped and alphanumeric runs are split at letter/digit
 * boundaries. That makes ticket IDs ("GAP-020"), cron IDs, UUIDs and other
 * digit-heavy tokens — the corpus's dominant regime — unsearchable.
 *
 * `mapDigits` maps every ASCII digit to a reserved two-letter code so the
 * encoded text is pure alphabetic and survives the tokenizer unchanged.
 * The mapping is a char-wise injection (letters pass through untouched,
 * digits become a letter pair starting with "z"), so:
 *
 *   - two different strings never encode to the same string
 *   - "GAP-020" encodes to a single queryable token pair ("gap" "zqzqzq")
 *   - pure-alpha queries ("gap") are unaffected — no false positives from
 *     single-digit encodings (digits never map to a single letter)
 *
 * The encoded text is ONLY used for FTS matching. Snippets, literal-match
 * ranking and prefix matching all operate on the raw text (see rank.ts and
 * the raw_text column in index.ts), so the encoding never leaks into
 * output.
 */

/** Reserved prefix for digit codes — no English word contains "z" + these. */
const DIGIT_CODES = [
  "zq", // 0
  "zx", // 1
  "zc", // 2
  "zk", // 3
  "zv", // 4
  "zw", // 5
  "zu", // 6
  "zy", // 7
  "zo", // 8
  "zn", // 9
];

/**
 * Map ASCII digits to their reserved two-letter codes; everything else
 * passes through unchanged. Exported for tests.
 */
export function mapDigits(text: string): string {
  let out = "";
  for (const ch of text) {
    const code =
      ch >= "0" && ch <= "9" ? DIGIT_CODES[ch.charCodeAt(0) - 48] : ch;
    out += code;
  }
  return out;
}

/**
 * Tokenize text into lowercase tokens (split on non-alphanumeric runs,
 * empty tokens dropped). Used for JS-side ranking tiers — mirrors the FTS
 * tokenizer's separators without its digit dropping.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length > 0);
}

/**
 * Split a raw search query into its tokens, honoring a trailing `*` as a
 * prefix marker on the last token (e.g. "GAP-02*" → tokens ["gap","02"],
 * prefix "02").
 */
export function splitQuery(query: string): {
  tokens: string[];
  prefix?: string;
} {
  const trimmed = query.trim();
  let prefix: string | undefined;
  let body = trimmed;
  if (trimmed.endsWith("*")) {
    body = trimmed.slice(0, -1).trimEnd();
    const last = tokenize(body).pop();
    // Only treat the final token as a prefix when the query actually ends
    // in a token character (never a bare "*").
    prefix = /[a-z0-9]$/i.test(body) ? last : undefined;
  }
  return { tokens: tokenize(body), prefix };
}
