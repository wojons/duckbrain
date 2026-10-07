/**
 * DB-SUPA-5 replay derivation: the committed parent→child audit-ledger diff.
 *
 * For each first-parent namespace commit the feed compares the child's
 * `_audit/` tree with its first parent using git tree/object reads — NEVER
 * `manifest.json`, a timestamp, or the process-local serializer `seq`.
 *
 * The algorithm (spec "Contract: cursor, ordering, delivery, and replay"):
 *
 *   1. Discover every child `_audit/*.jsonl` path and validate the fixed
 *      segment set/order (`current.jsonl`, then consecutive zero-padded
 *      numeric segments).
 *   2. Prove each parent segment's bytes are an EXACT PREFIX of the same child
 *      segment. The only permitted changes are suffix lines added to the
 *      active append target and/or newly created monotonically numbered
 *      segments (a new numeric segment contributes all of its lines).
 *   3. Collect those newly added lines in canonical segment+line order,
 *      filter to accepted change records, validate each record's
 *      operation/table/row/key/schemaVersion/`targetPath` AND the referenced
 *      data row at the same child ref.
 *   4. Derive ordinals `1..N` from the resulting sequence.
 *
 * The caller emits only after this whole range validated: rewrite, truncation,
 * deletion, rename, numeric gap/backfill, line mutation, a malformed accepted
 * record, a target/data mismatch, or any unaccounted-for audit change is
 * `CHANGELOG_CORRUPT` — never a silently skipped event.
 */

import path from "path";
import {
  AUDIT_DIR,
  AUDIT_CURRENT_SEGMENT,
  ChangelogCorruptError,
  assertCanonicalSegmentAdvance,
  canonicalAuditSegmentOrder,
  isAuditSegmentFile,
} from "../../serialization/auditLedger";
import {
  ChangeRecordSchema,
  contentHashFor,
  declaredKeyColumns,
  isChangeRecordCandidate,
  isSafeRepoRelativePath,
  keyMaterialFor,
  missingKeyColumns,
  type ChangeRecord,
} from "../../serialization/changeRecord";
import {
  commitTimeIso,
  firstParentOf,
  readBlobBytes,
  readPathBytes,
  readTreeEntries,
} from "../../git/ledger";

export interface DerivedChange {
  commit: string;
  ordinal: number;
  record: ChangeRecord;
  /**
   * The row image, resolved from the committed data file at
   * `record.targetPath` and verified against `record.contentHash`
   * (SCHED-GAP-1574 — the ledger stores the hash, not the row).
   */
  row: unknown;
  committedAt: string;
}

export interface DeriveOptions {
  /** Namespace name the ledger belongs to (every record must claim it). */
  ns: string;
  /** Namespace directory (used to resolve declared key columns). */
  namespacePath: string;
  /** Explicit first parent; omitted = resolved from git. */
  parentRef?: string | null;
}

function corrupt(
  message: string,
  detail: {
    commit: string;
    parent?: string | null;
    path?: string;
    line?: number;
  },
): ChangelogCorruptError {
  return new ChangelogCorruptError(message, detail);
}

interface SegmentView {
  /** Canonical order of segment names present at the ref. */
  order: string[];
  /** Segment name → `_audit/<name>` repo-relative path. */
  paths: Map<string, string>;
  /** Segment name → blob sha. */
  shas: Map<string, string>;
}

function readSegmentView(repoDir: string, ref: string): SegmentView {
  const entries = readTreeEntries(repoDir, ref, AUDIT_DIR);
  const paths = new Map<string, string>();
  const shas = new Map<string, string>();
  for (const entry of entries) {
    const remainder = entry.path.slice(AUDIT_DIR.length + 1);
    if (remainder.includes("/")) {
      throw corrupt(
        `nested path '${entry.path}' is not allowed in the committed audit ledger`,
        { commit: ref, path: entry.path },
      );
    }
    if (!isAuditSegmentFile(remainder)) continue;
    paths.set(remainder, entry.path);
    shas.set(remainder, entry.sha);
  }
  const order = canonicalAuditSegmentOrder(
    [...paths.keys()],
    `_audit at ${ref}`,
  );
  return { order, paths, shas };
}

interface AddedLine {
  segment: string;
  /** One-based physical (non-blank) line number inside the segment. */
  line: number;
  text: string;
}

function countNonBlank(text: string): number {
  return text.split("\n").filter((line) => line.trim() !== "").length;
}

/**
 * Newly added ledger lines between a parent and child ref, in canonical
 * segment+line order. Throws `CHANGELOG_CORRUPT` on any prefix violation,
 * segment set/order violation, or torn line.
 */
export function addedAuditLines(
  repoDir: string,
  childRef: string,
  parentRef: string | null,
): AddedLine[] {
  const child = readSegmentView(repoDir, childRef);
  const parent =
    parentRef === null ? null : readSegmentView(repoDir, parentRef);
  const parentOrder = parent?.order ?? [];
  assertCanonicalSegmentAdvance(
    parentOrder,
    child.order,
    `_audit ${parentRef ?? "<root>"} → ${childRef}`,
  );

  const added: AddedLine[] = [];
  for (const segment of child.order) {
    const childPath = child.paths.get(segment)!;
    const childSha = child.shas.get(segment)!;
    const parentSha = parent?.shas.get(segment);
    if (parentSha !== undefined && parentSha === childSha) continue;

    const childBytes = readBlobBytes(repoDir, childSha);
    const parentBytes =
      parentSha !== undefined
        ? readBlobBytes(repoDir, parentSha)
        : Buffer.alloc(0);

    if (
      childBytes.length < parentBytes.length ||
      !childBytes.subarray(0, parentBytes.length).equals(parentBytes)
    ) {
      throw corrupt(
        `committed audit segment '${segment}' is not an append-only extension of its parent`,
        { commit: childRef, parent: parentRef, path: childPath },
      );
    }
    if (childBytes.length > 0 && childBytes[childBytes.length - 1] !== 0x0a) {
      throw corrupt(
        `committed audit segment '${segment}' does not end on a line boundary`,
        { commit: childRef, parent: parentRef, path: childPath },
      );
    }

    const parentText = parentBytes.toString("utf-8");
    const baseLine = countNonBlank(parentText);
    const addedText = childBytes.subarray(parentBytes.length).toString("utf-8");
    let nonBlank = 0;
    for (const raw of addedText.split("\n")) {
      if (raw.trim() === "") continue;
      nonBlank += 1;
      added.push({
        segment,
        line: baseLine + nonBlank,
        text: raw,
      });
    }
  }
  return added;
}

/** Structural equality for JSON values (key order independent). */
function deepEqualJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((value, index) => deepEqualJson(value, right[index]));
  }
  if (left !== null && right !== null && typeof left === "object") {
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(b, key) &&
        deepEqualJson(a[key], b[key]),
    );
  }
  return false;
}

/**
 * SCHED-GAP-1574: resolve the row a change record points at by CONTENT HASH.
 * The ledger carries `contentHash` (SHA-256 of the serialized data line —
 * compact JSON + trailing newline — exactly the bytes the serializer
 * appended), not a full row image. The committed data file at the SAME child
 * ref is the source of truth: a line whose exact bytes hash to the recorded
 * value must exist there, and its parsed form is the row image.
 *
 * Failure classes (all `CHANGELOG_CORRUPT` at the caller):
 *   - `targetPath` escapes the namespace or is absent at the child ref;
 *   - no line in the target hashes to `contentHash` (rewritten, moved, or
 *     fabricated record).
 */
function resolveDataRowByHash(
  repoDir: string,
  commit: string,
  targetPath: string,
  contentHash: string,
): { row: unknown } | null {
  if (!isSafeRepoRelativePath(targetPath)) {
    throw corrupt(
      `change record targetPath '${targetPath}' escapes the namespace`,
      {
        commit,
        path: targetPath,
      },
    );
  }
  const bytes = readPathBytes(repoDir, commit, targetPath);
  if (bytes === null) {
    throw corrupt(
      `change record target '${targetPath}' does not exist in commit ${commit}`,
      { commit, path: targetPath },
    );
  }
  for (const line of bytes.toString("utf-8").split("\n")) {
    if (line.trim() === "") continue;
    if (contentHashFor(line) !== contentHash) continue;
    try {
      return { row: JSON.parse(line) };
    } catch {
      // The bytes hash-match but do not parse: treat as unresolved and keep
      // scanning — the caller fails closed if no parseable match exists.
      continue;
    }
  }
  return null;
}

/**
 * Derive the accepted change records newly added by `childRef` versus its
 * first parent, with contiguous ordinals. `options.parentRef` may be passed
 * explicitly (tests, and the null root case).
 */
export function deriveCommitChanges(
  repoDir: string,
  childRef: string,
  options: DeriveOptions,
): DerivedChange[] {
  const parentRef =
    options.parentRef === undefined
      ? firstParentOf(repoDir, childRef)
      : options.parentRef;
  const committedAt = commitTimeIso(repoDir, childRef);
  const changes: DerivedChange[] = [];

  for (const added of addedAuditLines(repoDir, childRef, parentRef)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(added.text);
    } catch {
      throw corrupt(
        `audit line ${added.line} of '${added.segment}' is not valid JSON`,
        {
          commit: childRef,
          parent: parentRef,
          path: `${AUDIT_DIR}/${added.segment}`,
          line: added.line,
        },
      );
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw corrupt(
        `audit line ${added.line} of '${added.segment}' is not a JSON object`,
        {
          commit: childRef,
          parent: parentRef,
          path: `${AUDIT_DIR}/${added.segment}`,
          line: added.line,
        },
      );
    }
    const entry = parsed as Record<string, unknown>;
    // Denial rows and marker-less audit rows are legitimate ledger content but
    // are not change records. A line carrying ANY change-record marker must
    // validate completely — a partial record is corrupt, not a skipped event.
    if (!isChangeRecordCandidate(entry)) continue;

    const validation = ChangeRecordSchema.safeParse(entry);
    if (!validation.success) {
      throw corrupt(
        `accepted change record at '${AUDIT_DIR}/${added.segment}:${added.line}' ` +
          `is malformed: ${validation.error.issues
            .map(
              (issue) =>
                `${issue.path.map(String).join(".") || "general"}: ${issue.message}`,
            )
            .join(", ")}`,
        {
          commit: childRef,
          parent: parentRef,
          path: `${AUDIT_DIR}/${added.segment}`,
          line: added.line,
        },
      );
    }
    const record = validation.data;
    if (record.ns !== options.ns) {
      throw corrupt(
        `change record at '${AUDIT_DIR}/${added.segment}:${added.line}' claims namespace ` +
          `'${record.ns}' but the ledger belongs to '${options.ns}'`,
        {
          commit: childRef,
          parent: parentRef,
          path: `${AUDIT_DIR}/${added.segment}`,
          line: added.line,
        },
      );
    }
    if (record.tombstone !== (record.op === "delete")) {
      throw corrupt(
        `change record at '${AUDIT_DIR}/${added.segment}:${added.line}' has a tombstone ` +
          `flag inconsistent with op '${record.op}'`,
        {
          commit: childRef,
          parent: parentRef,
          path: `${AUDIT_DIR}/${added.segment}`,
          line: added.line,
        },
      );
    }
    // SCHED-GAP-1574: the ledger stores `contentHash` — the SHA-256 of the
    // serialized data line — instead of a full row image. The committed data
    // file at the SAME child ref is the source of truth: a line whose exact
    // bytes hash to `record.contentHash` must exist there, and THAT parsed
    // line is the row image. This is the hash-replay form of the
    // target/data mismatch guard — a mutated, moved, or rewritten data row
    // (or a fabricated hash) fails closed exactly like a row-image mismatch.
    const resolved = resolveDataRowByHash(
      repoDir,
      childRef,
      record.targetPath,
      record.contentHash,
    );
    if (resolved === null) {
      throw corrupt(
        `change record at '${AUDIT_DIR}/${added.segment}:${added.line}' has no data row ` +
          `with the recorded content hash in committed target '${record.targetPath}'`,
        {
          commit: childRef,
          parent: parentRef,
          path: `${AUDIT_DIR}/${added.segment}`,
          line: added.line,
        },
      );
    }
    const row = resolved.row;
    if (row === undefined || row === null) {
      throw corrupt(
        `change record at '${AUDIT_DIR}/${added.segment}:${added.line}' has no row image`,
        {
          commit: childRef,
          parent: parentRef,
          path: `${AUDIT_DIR}/${added.segment}`,
          line: added.line,
        },
      );
    }
    const missing = missingKeyColumns(options.namespacePath, record.table, row);
    if (missing.length > 0) {
      throw corrupt(
        `change record at '${AUDIT_DIR}/${added.segment}:${added.line}' is missing declared key ` +
          `column(s) ${missing.join(", ")}`,
        {
          commit: childRef,
          parent: parentRef,
          path: `${AUDIT_DIR}/${added.segment}`,
          line: added.line,
        },
      );
    }
    const declaredKeys = declaredKeyColumns(
      options.namespacePath,
      record.table,
    );
    if (declaredKeys.length > 0) {
      const derived = keyMaterialFor(options.namespacePath, record.table, row);
      for (const column of declaredKeys) {
        if (!deepEqualJson(record.key[column], derived[column])) {
          throw corrupt(
            `change record at '${AUDIT_DIR}/${added.segment}:${added.line}' key.${column} does ` +
              `not match the row image`,
            {
              commit: childRef,
              parent: parentRef,
              path: `${AUDIT_DIR}/${added.segment}`,
              line: added.line,
            },
          );
        }
      }
    }

    changes.push({
      commit: childRef,
      ordinal: changes.length + 1,
      record,
      row,
      committedAt,
    });
  }

  return changes;
}

/**
 * Ordinals newly added by a commit, as a lookup for cursor validation
 * ("ordinal names exactly one committed accepted audit record").
 */
export function commitOrdinalCount(
  repoDir: string,
  commit: string,
  options: DeriveOptions,
): number {
  return deriveCommitChanges(repoDir, commit, options).length;
}

/** Canonical segment file name for a namespace directory (tests/diagnostics). */
export function auditSegmentPath(
  namespacePath: string,
  segment: string,
): string {
  return path.join(namespacePath, AUDIT_DIR, segment);
}

export { AUDIT_CURRENT_SEGMENT };
