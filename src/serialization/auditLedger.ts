/**
 * DB-SUPA-5 append-only audit ledger.
 *
 * `_audit/` is the committed changelog's physical storage. The spec makes it
 * an append-only SEGMENTED ledger with a reconstructable physical order — not
 * a manifest partition:
 *
 *   - `current.jsonl` is the initial segment.
 *   - Once a segment is sealed (at the configured line/byte bound) it is never
 *     shortened, rewritten, renamed, deleted, or reopened for append.
 *   - Rotated segments are zero-padded numeric names (`0001.jsonl`,
 *     `0002.jsonl`, …), created monotonically with no numeric gap/backfill.
 *   - Canonical ledger traversal is ALWAYS `current.jsonl` first, then numeric
 *     segments in ascending numeric order, records inside a segment in
 *     physical (non-blank) line order.
 *
 * `src/storage/jsonl.ts:88-111` supplies the zero-padded numeric-name basis;
 * this module enforces the stronger immutable-segment invariant instead of
 * relying on generic rotation, filename sorting, manifest membership,
 * timestamps, or the process-local serializer `seq`.
 */

import fs from "fs";
import path from "path";

export const AUDIT_DIR = "_audit";
export const AUDIT_CURRENT_SEGMENT = "current.jsonl";

/**
 * Fail-closed ledger/replay error. `CHANGELOG_CORRUPT` is the specified
 * answer for a rewrite, truncation, deletion, rename, numeric gap/backfill,
 * line mutation, malformed accepted record, target/data mismatch, or any
 * unaccounted-for audit change — never a silently skipped event.
 */
export class ChangelogCorruptError extends Error {
  readonly code = "CHANGELOG_CORRUPT";

  constructor(
    message: string,
    readonly detail: {
      commit?: string;
      parent?: string | null;
      path?: string;
      line?: number;
    } = {},
  ) {
    super(message);
    this.name = "ChangelogCorruptError";
  }
}

export function isChangelogCorrupt(error: unknown): error is ChangelogCorruptError {
  return error instanceof ChangelogCorruptError;
}

/**
 * Numeric segment number for a zero-padded segment name, or null when the
 * name is not a numeric segment (including non-padded names such as
 * `1.jsonl` and the reserved `current.jsonl`).
 */
export function auditSegmentNumber(name: string): number | null {
  const match = /^(\d+)\.jsonl$/.exec(name);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  if (match[1] !== String(value).padStart(4, "0")) return null;
  return value;
}

/** Zero-padded numeric segment name for a segment number (4-digit basis). */
export function formatAuditSegmentName(value: number): string {
  return `${String(value).padStart(4, "0")}.jsonl`;
}

/** Only `*.jsonl` files participate in the audit ledger. */
export function isAuditSegmentFile(name: string): boolean {
  return /^[^/\\]+\.jsonl$/.test(name);
}

/**
 * Validate a set of segment names and return them in canonical ledger order
 * (`current.jsonl` first, then ascending consecutive numeric segments).
 *
 * @throws ChangelogCorruptError for an unrecognized segment name, a numeric
 *   gap, or a backfill.
 */
export function canonicalAuditSegmentOrder(
  names: readonly string[],
  context: string,
): string[] {
  const ordered: string[] = [];
  const numeric: Array<{ name: string; value: number }> = [];
  for (const name of names) {
    if (name === AUDIT_CURRENT_SEGMENT) {
      ordered.push(name);
      continue;
    }
    const value = auditSegmentNumber(name);
    if (value === null) {
      throw new ChangelogCorruptError(
        `unrecognized audit segment '${name}' in ${context}`,
      );
    }
    numeric.push({ name, value });
  }
  numeric.sort((left, right) => left.value - right.value);
  numeric.forEach((entry, index) => {
    if (entry.value !== index + 1) {
      throw new ChangelogCorruptError(
        `audit segment numbering is not consecutive in ${context}: expected ` +
          `${formatAuditSegmentName(index + 1)}, found ${entry.name}`,
      );
    }
    ordered.push(entry.name);
  });
  return ordered;
}

/**
 * The parent's canonical segment list must be an exact name prefix of the
 * child's, and any newly created child segments must continue the numbering
 * monotonically with no gap/backfill. This single rule covers deletion,
 * rename, reordering, backfill, gap, and the "sealed segment reopened"
 * violation (a `current.jsonl` that appears after numeric segments exist).
 */
export function assertCanonicalSegmentAdvance(
  parentSegments: readonly string[],
  childSegments: readonly string[],
  context: string,
): string[] {
  if (childSegments.length < parentSegments.length) {
    throw new ChangelogCorruptError(
      `audit ledger lost a segment in ${context}: parent had ` +
        `[${parentSegments.join(", ")}], child has [${childSegments.join(", ")}]`,
    );
  }
  for (let index = 0; index < parentSegments.length; index += 1) {
    if (parentSegments[index] !== childSegments[index]) {
      throw new ChangelogCorruptError(
        `audit ledger segment order changed in ${context}: position ${index} ` +
          `was '${parentSegments[index]}', is '${childSegments[index]}'`,
      );
    }
  }
  const added = childSegments.slice(parentSegments.length);
  if (added.length === 0) return [];
  let next =
    (parentSegments
      .map((name) => auditSegmentNumber(name))
      .filter((value): value is number => value !== null)
      .reduce((max, value) => (value > max ? value : max), 0) || 0) + 1;
  for (const name of added) {
    if (name === AUDIT_CURRENT_SEGMENT) {
      if (parentSegments.length !== 0) {
        throw new ChangelogCorruptError(
          `audit ledger reopened '${AUDIT_CURRENT_SEGMENT}' after rotation in ${context}`,
        );
      }
      continue;
    }
    const value = auditSegmentNumber(name);
    if (value === null || value !== next) {
      throw new ChangelogCorruptError(
        `audit segment sequence is not monotonic in ${context}: expected ` +
          `${formatAuditSegmentName(next)}, found '${name}'`,
      );
    }
    next += 1;
  }
  return [...added];
}

function countNonBlankLines(filePath: string): number {
  const content = fs.readFileSync(filePath, "utf-8");
  return content.split("\n").filter((line) => line.trim() !== "").length;
}

export interface AuditLedgerLimits {
  /** Segment line bound (config `storage.maxLinesPerChunk`). */
  maxLines: number;
  /** Segment byte bound (config `storage.maxBytesPerChunk`). */
  maxBytes: number;
}

/**
 * Append `lines` to a namespace `_audit/` ledger, sealing and rotating
 * segments exactly at the configured bounds.
 *
 * The caller (the SUPA-2 serializer flush) holds the namespace write lock, so
 * the ledger state is read once per batch and tracked in memory — no
 * per-line stat/read of a growing file, and no chance for a concurrent
 * writer to reopen a sealed segment.
 */
export function appendAuditLedger(
  auditDir: string,
  lines: readonly string[],
  limits: AuditLedgerLimits,
): void {
  if (lines.length === 0) return;
  fs.mkdirSync(auditDir, { recursive: true });
  const existing = fs
    .readdirSync(auditDir)
    .filter((name) => isAuditSegmentFile(name));
  const ordered = canonicalAuditSegmentOrder(existing, `_audit of ${auditDir}`);
  const segmentNumbers = ordered
    .map((name) => auditSegmentNumber(name))
    .filter((value): value is number => value !== null);
  const maxSegment = segmentNumbers.reduce(
    (max, value) => (value > max ? value : max),
    0,
  );

  let activeName = ordered.length > 0 ? ordered[ordered.length - 1] : AUDIT_CURRENT_SEGMENT;
  let activePath = path.join(auditDir, activeName);
  let activeLines = 0;
  let activeBytes = 0;
  if (fs.existsSync(activePath)) {
    activeLines = countNonBlankLines(activePath);
    activeBytes = fs.statSync(activePath).size;
  }
  let highestSegment = maxSegment;

  const rotate = (): void => {
    highestSegment += 1;
    activeName = formatAuditSegmentName(highestSegment);
    activePath = path.join(auditDir, activeName);
    activeLines = 0;
    activeBytes = 0;
  };

  for (const line of lines) {
    const bytes = Buffer.byteLength(line + "\n", "utf-8");
    if (
      activeLines >= limits.maxLines ||
      (activeBytes > 0 && activeBytes + bytes > limits.maxBytes)
    ) {
      rotate();
    }
    fs.appendFileSync(activePath, line + "\n", "utf-8");
    activeLines += 1;
    activeBytes += bytes;
  }
}

/** Canonical ledger order for a namespace directory's `_audit/` segment files. */
export function auditSegmentOrderOnDisk(namespacePath: string): string[] {
  const auditDir = path.join(namespacePath, AUDIT_DIR);
  let entries: string[];
  try {
    entries = fs.readdirSync(auditDir);
  } catch {
    return [];
  }
  return canonicalAuditSegmentOrder(
    entries.filter((name) => isAuditSegmentFile(name)),
    `_audit of ${namespacePath}`,
  );
}
