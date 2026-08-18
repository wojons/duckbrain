/**
 * Time-scoped recall helpers (RETR-003).
 *
 * Shared ISO-8601 validation and normalization for the after/before/between
 * parameters accepted by the MCP recall tool, the HTTP GET /api/memories
 * route, and the CLI `duckbrain recall` command.
 *
 * Semantics (inclusive bounds — "since"/"until" style):
 *   - after   → timestamp >= after  (date-only = start of that day, UTC)
 *   - before  → timestamp <= before (date-only = END of that day, so
 *               before=2026-08-12 includes everything on 2026-08-12)
 *   - between → "START,END" → after=START AND before=END (shorthand)
 *
 * Normalization: every bound is canonicalized to a UTC ISO-8601 instant
 * (`YYYY-MM-DDTHH:MM:SS.mmmZ`) so the SQL layer only ever compares one
 * format. Datetime bounds with offsets are converted via Date.parse; naive
 * datetimes (no Z / no offset) are treated as UTC. The canonical form also
 * matters because the bundled DuckDB parses stored rows' `+00:00` suffixes
 * and `Z` identically, while a lexicographic string compare would not.
 */

/**
 * ISO-8601: a date (YYYY-MM-DD) or a datetime (date + T + HH:MM[:SS[.fff]]
 * + optional Z / ±HH:MM offset). Date-only values mean UTC midnight
 * (consistent with `new Date("2026-08-10")`).
 */
const ISO8601_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/** Date-only value (YYYY-MM-DD) — expanded to a full instant below. */
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Full datetime value that already carries a Z or ±HH:MM offset. */
const OFFSET_PATTERN = /(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Validate a single ISO-8601 date/datetime string.
 *
 * The regex enforces the SHAPE; a component round-trip then rejects
 * calendar impossibilities (2026-13-45, 2026-02-30 — Date.parse alone
 * is useless here: V8 rolls 2026-02-30 over to 2026-03-02 instead of
 * returning NaN, while out-of-range TIME components do yield NaN).
 */
export function isValidIso8601(value: string): boolean {
  if (!ISO8601_PATTERN.test(value)) return false;

  // Calendar check on the date part: build a UTC Date and verify every
  // component round-trips (rejects 2026-13-45 and 2026-02-30).
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return false;
  }

  // Time part (when present): Date.parse returns NaN for out-of-range
  // hours/minutes/seconds (25:99:00 → NaN) — the regex already pins the
  // shape to exactly two digits each.
  return !Number.isNaN(Date.parse(value));
}

/** Raw (unvalidated) time-range parameters as callers receive them. */
export interface TimeRangeInput {
  after?: string;
  before?: string;
  between?: string;
}

/** Normalized time-range parameters — between expanded, bounds canonical. */
export interface NormalizedTimeRange {
  after?: string;
  before?: string;
}

/**
 * Canonicalize one validated bound to a UTC ISO-8601 instant:
 *   - date-only after  → YYYY-MM-DDT00:00:00.000Z (start of day)
 *   - date-only before → YYYY-MM-DDT23:59:59.999Z (END of day — "until
 *     2026-08-12" must include 2026-08-12 itself)
 *   - datetime         → canonical UTC via Date.parse (offsets converted;
 *     naive values without Z/offset are treated as UTC, NOT host-local)
 */
function normalizeBound(value: string, kind: "after" | "before"): string {
  if (DATE_ONLY_PATTERN.test(value)) {
    return kind === "after"
      ? `${value}T00:00:00.000Z`
      : `${value}T23:59:59.999Z`;
  }
  const withOffset = OFFSET_PATTERN.test(value) ? value : `${value}Z`;
  return new Date(withOffset).toISOString();
}

/**
 * Validate and normalize the after/before/between triple.
 *
 * @throws Error with a human-readable message on any invalid input:
 *   - a value that is not a valid ISO-8601 date/datetime
 *   - `between` without exactly two comma-separated values
 *   - `between` combined with after/before (mutually exclusive)
 *   - after later than before (empty window)
 */
export function parseTimeRange(input: TimeRangeInput): NormalizedTimeRange {
  const { after, before, between } = input;

  if (between !== undefined) {
    if (after !== undefined || before !== undefined) {
      throw new Error(
        "Use either 'between' or 'after'/'before' — combining them is not supported",
      );
    }
    const separator = between.indexOf(",");
    if (separator === -1) {
      throw new Error(
        "between must be two comma-separated ISO-8601 values (e.g. 2026-08-10,2026-08-12)",
      );
    }
    const start = between.slice(0, separator).trim();
    const end = between.slice(separator + 1).trim();
    if (!isValidIso8601(start) || !isValidIso8601(end)) {
      throw new Error(
        `Invalid ISO-8601 datetime in between: '${between}' (expected START,END)`,
      );
    }
    const normalizedAfter = normalizeBound(start, "after");
    const normalizedBefore = normalizeBound(end, "before");
    assertOrdered(normalizedAfter, normalizedBefore);
    return { after: normalizedAfter, before: normalizedBefore };
  }

  if (after !== undefined && !isValidIso8601(after)) {
    throw new Error(`Invalid ISO-8601 datetime for after: '${after}'`);
  }
  if (before !== undefined && !isValidIso8601(before)) {
    throw new Error(`Invalid ISO-8601 datetime for before: '${before}'`);
  }
  const normalizedAfter =
    after !== undefined ? normalizeBound(after, "after") : undefined;
  const normalizedBefore =
    before !== undefined ? normalizeBound(before, "before") : undefined;
  if (normalizedAfter !== undefined && normalizedBefore !== undefined) {
    assertOrdered(normalizedAfter, normalizedBefore);
  }
  return { after: normalizedAfter, before: normalizedBefore };
}

/** Reject an empty window (after strictly later than before). */
function assertOrdered(after: string, before: string): void {
  if (Date.parse(after) > Date.parse(before)) {
    throw new Error(
      `after (${after}) must not be later than before (${before})`,
    );
  }
}
