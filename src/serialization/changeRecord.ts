/**
 * DB-SUPA-5 accepted change records.
 *
 * `docs/specs/SUPA-5-realtime.md` makes the namespace append/audit log the
 * changelog: for every accepted write the SUPA-2 serializer appends ONE
 * canonical change record to `_audit/*.jsonl`, after the data append, in the
 * same flush. The record carries exactly what a later replay needs:
 * operation, table, row image (or tombstone), key material, the
 * namespace-relative physical data path the row landed in
 * (`targetPath` — rotation-aware), and the table's declared schema version.
 *
 * It deliberately does NOT carry an audit-file path or a commit-local
 * total-order field: the committed tree identifies the audit segment, and no
 * git commit boundary exists while the serializer appends. Ordering is
 * derived post-commit from the parent→child audit diff
 * (`src/http/realtime/replay.ts`).
 *
 * These fields are ADDITIVE on the SUPA-2 audit row, so `AuditEntrySchema`
 * keeps accepting legacy rows and denial rows unchanged; an audit line is a
 * change record only when `outcome === "accepted"` and at least one
 * change-record marker field is present.
 */

import fs from "fs";
import path from "path";
import { z } from "zod";

/** The built-in compatibility table every namespace exposes. */
export const MEMORIES_TABLE = "memories";

export const CHANGE_OPERATIONS = ["insert", "update", "delete"] as const;
export type ChangeOperation = (typeof CHANGE_OPERATIONS)[number];

/**
 * Marker fields that promote an accepted audit row to a change record.
 * Presence of ANY of them means the line MUST validate as a change record —
 * a partially-written marker set is `CHANGELOG_CORRUPT` at replay time, never
 * a silently skipped event.
 */
export const CHANGE_RECORD_MARKERS = [
  "row",
  "key",
  "targetPath",
  "tombstone",
  "schemaVersion",
] as const;

export const ChangeRecordSchema = z.object({
  ts: z.string().min(1),
  ns: z.string().min(1),
  table: z.string().min(1),
  op: z.enum(CHANGE_OPERATIONS),
  principal: z.string().nullable().optional(),
  outcome: z.literal("accepted"),
  /** Internal process-local serializer sequence — never a cursor. */
  seq: z.number().int().positive().optional(),
  /** Post-operation row image (insert/update) or appended tombstone (delete). */
  row: z.unknown(),
  /** Every declared key column and its value. */
  key: z.record(z.string(), z.unknown()),
  /** Namespace-relative physical data JSONL path the row was appended to. */
  targetPath: z.string().min(1),
  tombstone: z.boolean(),
  /** Declared table schema version (`1` for the `memories` compatibility entry). */
  schemaVersion: z.number().int().positive(),
});

export type ChangeRecord = z.infer<typeof ChangeRecordSchema>;

/** An audit line that claims to be a change record (marker field present). */
export function isChangeRecordCandidate(
  entry: Record<string, unknown>,
): boolean {
  if (entry.outcome !== "accepted") return false;
  return CHANGE_RECORD_MARKERS.some((field) => entry[field] !== undefined);
}

/** Declared table metadata the change feed needs (SUPA-6 owns the full DDL). */
export interface DeclaredTableView {
  /** Declared primary key column, or null when the table declares none. */
  primary: string | null;
  /** Declared column names, in declaration order. */
  columns: string[];
  /** Declared table schema version (defaults to 1). */
  schemaVersion: number;
}

/**
 * Read `tables/<table>.table.json` from a namespace directory — the SUPA-3
 * declaration SUPA-5 consumes for key columns and schema version. Returns
 * null when the table is not declared (or the declaration is unreadable);
 * undeclared tables simply carry no key columns and schemaVersion 1.
 */
export function readDeclaredTableView(
  namespacePath: string,
  table: string,
): DeclaredTableView | null {
  const file = path.join(namespacePath, "tables", `${table}.table.json`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const raw = parsed as Record<string, unknown>;
  const columns = Array.isArray(raw.columns)
    ? raw.columns
        .map((column) =>
          typeof column === "object" && column !== null
            ? (column as Record<string, unknown>).name
            : undefined,
        )
        .filter((name): name is string => typeof name === "string")
    : [];
  const version = raw.schemaVersion;
  return {
    primary: typeof raw.primary === "string" ? raw.primary : null,
    columns,
    schemaVersion:
      typeof version === "number" && Number.isInteger(version) && version > 0
        ? version
        : 1,
  };
}

/**
 * Declared key columns for a table. `memories` uses the built-in
 * compatibility key `id` (it is never serialized into a namespace schema);
 * every other table uses its declared primary key column, or no key columns
 * when it declares none.
 */
export function declaredKeyColumns(
  namespacePath: string,
  table: string,
): string[] {
  if (table === MEMORIES_TABLE) return ["id"];
  const declaration = readDeclaredTableView(namespacePath, table);
  return declaration?.primary ? [declaration.primary] : [];
}

/** Declared schema version for a table (1 when undeclared / `memories`). */
export function declaredSchemaVersion(
  namespacePath: string,
  table: string,
): number {
  if (table === MEMORIES_TABLE) return 1;
  return readDeclaredTableView(namespacePath, table)?.schemaVersion ?? 1;
}

/**
 * Extract the declared key columns from a row image.
 *
 * Row images are JSON objects for `jsonl-objects` tables and arrays for
 * `jsonl-positional` tables; a positional column is resolved through the
 * declaration's column order. A row that is neither (or a column the row does
 * not carry) yields no entry, which the delete guard and replay validation
 * both treat as missing key material.
 */
export function keyMaterialFor(
  namespacePath: string,
  table: string,
  row: unknown,
): Record<string, unknown> {
  const columns = declaredKeyColumns(namespacePath, table);
  if (columns.length === 0) return {};
  const key: Record<string, unknown> = {};
  if (Array.isArray(row)) {
    const declaration = readDeclaredTableView(namespacePath, table);
    const order = declaration?.columns ?? [];
    for (const column of columns) {
      const index = order.indexOf(column);
      if (index >= 0 && index < row.length) key[column] = row[index];
    }
    return key;
  }
  if (typeof row === "object" && row !== null) {
    const record = row as Record<string, unknown>;
    for (const column of columns) {
      if (Object.prototype.hasOwnProperty.call(record, column)) {
        key[column] = record[column];
      }
    }
  }
  return key;
}

/** Declared key columns a row image does not carry at all. */
export function missingKeyColumns(
  namespacePath: string,
  table: string,
  row: unknown,
): string[] {
  const columns = declaredKeyColumns(namespacePath, table);
  if (columns.length === 0) return [];
  if (Array.isArray(row)) {
    const declaration = readDeclaredTableView(namespacePath, table);
    const order = declaration?.columns ?? [];
    return columns.filter((column) => {
      const index = order.indexOf(column);
      return index < 0 || index >= row.length || row[index] === undefined;
    });
  }
  if (typeof row !== "object" || row === null) return [...columns];
  const record = row as Record<string, unknown>;
  return columns.filter(
    (column) =>
      !Object.prototype.hasOwnProperty.call(record, column) ||
      record[column] === undefined,
  );
}

/**
 * A `targetPath` must stay inside the namespace: replay resolves it against
 * the committed tree, so an absolute path or a `..` segment is corrupt.
 */
export function isSafeRepoRelativePath(value: string): boolean {
  if (value === "" || value.startsWith("/")) return false;
  if (path.isAbsolute(value)) return false;
  return !value.split(/[\\/]/).includes("..");
}
