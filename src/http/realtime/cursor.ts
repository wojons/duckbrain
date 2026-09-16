/**
 * DB-SUPA-5 opaque cursors and the error surface of the change feed.
 *
 * A cursor is opaque ASCII in the form `dbch1.<base64url(canonical-json)>`,
 * where the canonical JSON is exactly
 * `{"v":1,"ns":<namespace>,"commit":<40-hex SHA>,"ordinal":<positive integer>}`
 * with keys in that order and no whitespace.
 *
 * It is deliberately NOT signed: a restart-safe HMAC would require a durable
 * shared secret, key identifiers, rotation grace, and multi-process
 * configuration that DB-SUPA-5 does not otherwise need. A cursor never
 * contains a serializer `seq` and never depends on an ephemeral process
 * secret — clients store and replay it verbatim and must not construct it.
 */

export const CURSOR_PREFIX = "dbch1.";
export const CURSOR_VERSION = 1;

export type RealtimeErrorCode =
  | "INVALID_SUBSCRIPTION"
  | "INVALID_CURSOR"
  | "CHANGE_CURSOR_GONE"
  | "CHANGELOG_CORRUPT"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "SUBSCRIBER_LIMIT";

export const REALTIME_ERROR_STATUS: Record<RealtimeErrorCode, number> = {
  INVALID_SUBSCRIPTION: 400,
  INVALID_CURSOR: 400,
  CHANGE_CURSOR_GONE: 410,
  CHANGELOG_CORRUPT: 500,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  SUBSCRIBER_LIMIT: 503,
};

/**
 * A specified, non-retryable subscription failure. Raised BEFORE any SSE byte
 * is written, so every failure is a clean JSON error with no partial stream.
 */
export class RealtimeError extends Error {
  readonly code: RealtimeErrorCode;
  readonly status: number;
  /** Operator-facing recovery hint (never leaks gated table information). */
  readonly guidance?: string;

  constructor(code: RealtimeErrorCode, message: string, guidance?: string) {
    super(message);
    this.name = "RealtimeError";
    this.code = code;
    this.status = REALTIME_ERROR_STATUS[code];
    this.guidance = guidance;
  }
}

export interface DecodedCursor {
  ns: string;
  commit: string;
  ordinal: number;
}

/** Canonical cursor JSON — exact key order, no whitespace. */
export function canonicalCursorJson(
  ns: string,
  commit: string,
  ordinal: number,
): string {
  return `{"v":${CURSOR_VERSION},"ns":${JSON.stringify(ns)},"commit":"${commit}","ordinal":${ordinal}}`;
}

export function encodeCursor(
  ns: string,
  commit: string,
  ordinal: number,
): string {
  const payload = canonicalCursorJson(ns, commit, ordinal);
  return `${CURSOR_PREFIX}${Buffer.from(payload, "utf-8").toString("base64url")}`;
}

/**
 * Decode and verify an exact cursor encoding. Returns null for anything that
 * is not a byte-exact canonical DB-SUPA-5 cursor — malformed base64, a
 * re-encoded payload that differs from the input, a wrong version, a
 * non-canonical commit/ordinal, or extra keys. Namespace and repository
 * checks happen after this (they need the route's `:ns` and the repo).
 */
export function decodeCursor(raw: string): DecodedCursor | null {
  if (!raw.startsWith(CURSOR_PREFIX)) return null;
  const encoded = raw.slice(CURSOR_PREFIX.length);
  if (encoded === "" || /[^A-Za-z0-9_-]/.test(encoded)) return null;

  let payload: string;
  try {
    payload = Buffer.from(encoded, "base64url").toString("utf-8");
  } catch {
    return null;
  }
  // Byte-exact round trip: rejects padding, non-canonical base64 aliases, and
  // any payload that re-encodes differently.
  if (Buffer.from(payload, "utf-8").toString("base64url") !== encoded) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).length !== 4) return null;
  if (record.v !== CURSOR_VERSION) return null;
  if (typeof record.ns !== "string" || record.ns === "") return null;
  if (
    typeof record.commit !== "string" ||
    !/^[0-9a-f]{40}$/.test(record.commit)
  ) {
    return null;
  }
  if (
    typeof record.ordinal !== "number" ||
    !Number.isInteger(record.ordinal) ||
    record.ordinal <= 0
  ) {
    return null;
  }
  // The canonical form is the contract: a non-canonical key order or
  // whitespace in the payload is not a cursor this server ever issued.
  const canonical = canonicalCursorJson(
    record.ns as string,
    record.commit as string,
    record.ordinal as number,
  );
  if (canonical !== payload) return null;

  return {
    ns: record.ns as string,
    commit: record.commit as string,
    ordinal: record.ordinal as number,
  };
}
