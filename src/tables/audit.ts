/**
 * Read-only table primary-key audit (TABLES-AUDIT-KEYS-001).
 *
 * This deliberately reads the declared JSONL files directly instead of going
 * through a repair, writer, or query path. An audit must be safe to run in CI
 * against a damaged store and must never normalize the evidence it reports.
 *
 * ch:trace row=TABLES-AUDIT-KEYS-001 spec=.coding-hermes/board/tasks.jsonl#acceptance_criteria wave=.coding-hermes/waves/duckbrain-foreman-2026-11-11-10-16-08.json test=src/ evidence=none:worker-commit-will-be-bound-by-foreman witness=none:ephemeral-worker-verification verdict=none:foreman-will-run commit=none:foreman-will-bind memory=none:foreman-will-write
 */

import fs from "fs";
import path from "path";
import {
  listTables,
  namespaceDir,
  type TableDeclaration,
} from "../schema/table-registry";
import { resolveTableFiles } from "../duckdb/table-store";

export interface DuplicatePrimaryKey {
  /** Values keyed by the declaration's primary-key columns. */
  key: Record<string, unknown>;
  count: number;
}

export interface TableKeyAudit {
  table: string;
  primary: string[];
  status: "ok" | "duplicates" | "no-primary-key";
  duplicates: DuplicatePrimaryKey[];
  /** Number of non-empty data lines that were not valid JSON rows. */
  malformedRows: number;
}

export interface NamespaceKeyAudit {
  namespace: string;
  tables: TableKeyAudit[];
  duplicateTables: number;
  duplicateKeys: number;
}

function rowFromLine(
  declaration: TableDeclaration,
  parsed: unknown,
): Record<string, unknown> | null {
  if (declaration.format === "jsonl-positional") {
    if (!Array.isArray(parsed)) return null;
    return Object.fromEntries(
      declaration.columns.map((column, index) => [column.name, parsed[index]]),
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function keyFingerprint(values: unknown[]): string {
  return JSON.stringify(values);
}

function primaryColumns(declaration: TableDeclaration): string[] {
  return declaration.declaredKeyColumns?.length
    ? [...declaration.declaredKeyColumns]
    : declaration.primary
      ? [declaration.primary]
      : [];
}

function auditTable(
  nsDir: string,
  declaration: TableDeclaration,
): TableKeyAudit {
  const primary = primaryColumns(declaration);
  if (primary.length === 0) {
    return {
      table: declaration.name,
      primary,
      status: "no-primary-key",
      duplicates: [],
      malformedRows: 0,
    };
  }

  const counts = new Map<
    string,
    { key: Record<string, unknown>; count: number }
  >();
  let malformedRows = 0;
  for (const file of resolveTableFiles(nsDir, declaration)) {
    let content: string;
    try {
      content = fs.readFileSync(file.absPath, "utf-8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        malformedRows += 1;
        continue;
      }
      const row = rowFromLine(declaration, parsed);
      if (!row) {
        malformedRows += 1;
        continue;
      }
      const key: Record<string, unknown> = {};
      for (const column of primary) key[column] = row[column];
      const fingerprint = keyFingerprint(primary.map((column) => row[column]));
      const existing = counts.get(fingerprint);
      if (existing) existing.count += 1;
      else counts.set(fingerprint, { key, count: 1 });
    }
  }

  const duplicates = [...counts.values()]
    .filter((entry) => entry.count > 1)
    .sort((left, right) =>
      keyFingerprint(Object.values(left.key)).localeCompare(
        keyFingerprint(Object.values(right.key)),
      ),
    );
  return {
    table: declaration.name,
    primary,
    status: duplicates.length > 0 ? "duplicates" : "ok",
    duplicates,
    malformedRows,
  };
}

/** Audit every declared table in a namespace without taking a write lock. */
export function auditNamespaceTableKeys(namespace: string): NamespaceKeyAudit {
  const nsDir = path.resolve(namespaceDir(namespace));
  const tables = listTables(namespace).map((declaration) =>
    auditTable(nsDir, declaration),
  );
  const duplicateTables = tables.filter(
    (table) => table.duplicates.length > 0,
  ).length;
  return {
    namespace,
    tables,
    duplicateTables,
    duplicateKeys: tables.reduce(
      (total, table) => total + table.duplicates.length,
      0,
    ),
  };
}
