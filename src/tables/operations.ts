/**
 * Declared-table data operations (SURFACE-MCP-DATA-001)
 *
 * ONE implementation for the table verbs, shared by the REST routes
 * (src/http/routes/tables.ts) and the MCP tools (src/mcp/tools/tables.ts).
 *
 * Before this module the verbs lived inline in the Express handlers, so any
 * second transport that wanted table CRUD had to re-implement the declaration
 * resolution, the primary-key rules, the SUPA-2 writer path, the mutation
 * change records and the durability reporting — i.e. drift. The handlers are
 * now thin adapters over these functions; MCP calls the SAME functions, so a
 * refusal raised here is byte-identical on both transports.
 *
 * Semantics preserved verbatim (moved, not rewritten):
 *   - select: PostgREST filter vocabulary, hard row cap, json column
 *     round-trip, exact-count opt-in.
 *   - insert: SUPA-6 schema.json → NamespaceWriter (validation → ordered
 *     write → audit/change record → commit, DDL fence honoured); legacy
 *     `.table.json` → direct append. All rows validated before any write.
 *   - update/delete: pk=eq.<v> only, read-merge-rewrite under the namespace
 *     write lock, DB-SUPA-5 change record before the acknowledgement.
 */

import fs from "fs";
import path from "path";
import { ApiError } from "../http/middleware/errorHandler";
import { listTables, getTable, namespaceDir, type TableDeclaration } from "../schema/table-registry";
import { getDeclaredTable, assertNamespaceSchemaUsable } from "../serialization/schemaRegistry";
import type { RegisteredTableDeclaration } from "../serialization/registry";
import {
  buildSelectPlan,
  executeSelectPlan,
  coerceRowAgainstDeclaration,
  appendRowsToTable,
  findRowByPk,
  findRowLineByPk,
  patchRowsByPk,
  deleteRowsByPk,
  resolveTableFiles,
  serializeRowLine,
  deriveSyntheticFilePath,
  type MutationOutcome,
  type RowLineLocation,
} from "../duckdb/table-store";
import { getNamespaceWriter } from "../serialization/namespaceWriter";
import { acceptedTableMutationRecord, type AuditEntry } from "../serialization/audit";
import {
  acquireNamespaceWriteLock,
  releaseNamespaceWriteLock,
  type NamespaceWriteLock,
} from "../serialization/lock";
import { resolveNamespacesPath } from "../config";
import {
  barrierWrittenPaths,
  durabilityHeaderFor,
  type AchievedWriteMode,
  type WriteMode,
} from "../storage/durability";
import { assertNamespaceDdlUsable, partitionForStoragePath } from "../serialization/ddl";
import { storedRowFromApiRow } from "../serialization/schemaTypes";
import type { AuthPrincipal } from "../auth/middleware";
import {
  auditPolicyDenial,
  resolveRowPolicy,
  ROW_POLICY_REASON,
  rowPolicyDecision,
  type PolicyAuditSink,
} from "./policy";

/** Declared column types (schema.json) → legacy DuckDB column types. */
const DECLARED_TO_LEGACY: Record<string, string> = {
  string: "varchar",
  int64: "bigint",
  float64: "double",
  boolean: "boolean",
  timestamp: "timestamp",
  json: "json",
  bytes: "varchar",
};

/**
 * RLS-001: internal control-flow signal for "the row exists but this principal
 * may not touch it". The public verbs answer it as `updated: 0` / `deleted: 0`
 * (no existence oracle) and record the real reason in the namespace audit; it
 * is never returned to a caller as an error string.
 */
class PolicyRefusal extends Error {}

/** Namespace-relative POSIX path of a physical data file. */
export function namespaceRelativePath(nsDir: string, filePath: string): string {
  return path.relative(nsDir, filePath).split(path.sep).join("/");
}

/** Durability actually achieved vs configured for a table mutation. */
export interface TableDurability {
  configured: WriteMode;
  achieved: AchievedWriteMode;
}

/** View a schema.json declaration through the legacy TableDeclaration shape. */
export function asLegacyDeclaration(
  decl: RegisteredTableDeclaration,
): TableDeclaration {
  return {
    name: decl.table,
    format: "jsonl-objects" as const,
    columns: decl.columns.map((c) => ({
      name: c.name,
      type: (DECLARED_TO_LEGACY[c.type] ?? "varchar") as TableDeclaration["columns"][number]["type"],
      nullable: c.nullable,
      ...(c.references ? { references: { ...c.references } } : {}),
    })),
    primary: decl.keyColumns[0] ?? null,
    glob: decl.storagePath,
    source: "schema.json" as const,
  };
}

/**
 * Resolve a table declaration the way every table verb does: legacy
 * `.table.json` registry first, then the SUPA-6 declared registry (which
 * supersedes legacy on a naming collision).
 *
 * The not-found message is the one both REST and MCP return.
 */
export function resolveTableDeclaration(
  ns: string,
  table: string,
  options: { legacyOnly?: boolean } = {},
): TableDeclaration {
  const legacy = getTable(ns, table) as TableDeclaration | undefined;
  if (legacy) return legacy;
  if (options.legacyOnly) {
    throw new ApiError(
      `Table '${table}' not found in namespace '${ns}'`,
      404,
      "NOT_FOUND",
    );
  }
  const declared = getDeclaredTable(ns, table);
  if (declared) return asLegacyDeclaration(declared);
  throw new ApiError(
    `Table '${table}' not found in namespace '${ns}'`,
    404,
    "NOT_FOUND",
  );
}

/** Declared tables in a namespace, as the list surface reports them. */
export function listNamespaceTables(ns: string): Array<{
  name: string;
  format: string;
  columns: TableDeclaration["columns"];
  primary: string | null;
  glob: string;
}> {
  return listTables(ns).map((t) => ({
    name: t.name,
    format: t.format,
    columns: t.columns,
    primary: t.primary,
    glob: t.glob,
  }));
}

/** Resolve and validate a supplied primary-key equality filter. */
export function resolvePkFilter(
  declaration: TableDeclaration,
  raw: unknown,
  operation: string,
): { col: TableDeclaration["columns"][number]; value: string } {
  if (!declaration.primary) {
    throw new ApiError(
      `Table '${declaration.name}' declares no primary key; ${operation} are not available`,
      400,
      "VALIDATION_ERROR",
    );
  }
  const col = declaration.columns.find((c) => c.name === declaration.primary)!;
  const pkValue = Array.isArray(raw) ? raw[0] : raw;
  const pk = pkValue === undefined ? undefined : String(pkValue);
  if (pk === undefined) {
    throw new ApiError(
      `${operation} require a primary key filter: ?pk=eq.<value>`,
      400,
      "VALIDATION_ERROR",
    );
  }
  const m = pk.match(/^eq[.](.+)$/s) ?? (pk === "eq.null" ? null : null);
  if (!m) {
    throw new ApiError(
      `${operation} require an equality filter on the primary key: ?pk=eq.<value>`,
      400,
      "VALIDATION_ERROR",
    );
  }
  return { col, value: m[1]! };
}

/** Query keys that are not column filters. */
const RESERVED_QUERY_KEYS = new Set([
  "order",
  "limit",
  "offset",
  "count",
  "pk",
  "embed",
]);

/**
 * Extract only the querystring entries that look like column filters.
 *
 * Accepts a plain query object (Express `req.query` or an MCP argument map),
 * so both transports apply the same unknown-column rule.
 */
export function filterParams(
  query: Record<string, unknown>,
  declaration: TableDeclaration,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(query)) {
    if (RESERVED_QUERY_KEYS.has(key)) continue;
    if (!declaration.columns.some((c) => c.name === key)) {
      const first = Array.isArray(value) ? String(value[0]) : String(value);
      if (/^[a-z]+\./.test(first)) {
        throw new ApiError(
          `Unknown filter column '${key}' (table '${declaration.name}' declares: ${declaration.columns.map((c) => c.name).join(", ")})`,
          400,
          "VALIDATION_ERROR",
        );
      }
      continue;
    }
    out[key] = Array.isArray(value)
      ? (value as unknown[]).map(String)
      : String(value);
  }
  if (query.pk !== undefined) {
    const { col, value } = resolvePkFilter(declaration, query.pk, "GET");
    out[col.name] = `eq.${value}`;
  }
  return out;
}

/** Select input shared by the REST querystring and the MCP arguments. */
export interface SelectTableInput {
  filters?: Record<string, string | string[]>;
  order?: string | string[] | undefined;
  limit?: unknown;
  offset?: unknown;
  wantCount?: boolean;
  /**
   * REST-ATOMICITY-001 AC-3: declared relations to EMBED, one level deep.
   * Each name must be the `references.table` of a column on this table.
   */
  embed?: string | string[] | undefined;
  /**
   * RLS-001: the authenticated principal whose declared ROW policy is graded.
   * Applied AFTER the caller's grant check (which happens on the transport)
   * and pushed into the SELECT's WHERE clause, so paging and X-Total-Count
   * count only visible rows.
   */
  principal?: AuthPrincipal | undefined;
  /** RLS-001: where a row-policy denial is recorded (namespace audit). */
  auditPolicyDenial?: PolicyAuditSink | undefined;
}

export interface SelectTableResult {
  declaration: TableDeclaration;
  rows: Record<string, unknown>[];
  totalCount: number | null;
}

/**
 * SELECT a declared table with the PostgREST vocabulary.
 *
 * Declared json columns arrive as VARCHAR text (DuckDB JSON→VARCHAR
 * projection); they are parsed back into real JSON values so responses carry
 * actual JSON, matching what was inserted.
 */
export async function selectTableRows(
  ns: string,
  table: string,
  input: SelectTableInput = {},
): Promise<SelectTableResult> {
  const declaration = resolveTableDeclaration(ns, table);
  // RLS-001: grant says "may touch this table"; policy says "which rows".
  const policy = resolveRowPolicy(declaration.policy, "read", input.principal);
  if (policy.kind === "deny") {
    await auditPolicyDenial(input.auditPolicyDenial, {
      ns,
      table: declaration.name,
      op: "tables.read",
      principal: input.principal?.name ?? null,
      reason: ROW_POLICY_REASON,
    });
    throw new ApiError(policy.message, 403, "FORBIDDEN");
  }
  const plan = buildSelectPlan(declaration, {
    filters: input.filters ?? {},
    order: input.order,
    limit: input.limit as never,
    offset: input.offset as never,
    wantCount: input.wantCount === true,
    ...(policy.kind === "filter" ? { rowPolicy: policy.filter } : {}),
  });
  const { rows: rawRows, totalCount } = await executeSelectPlan(
    namespaceDir(ns),
    declaration,
    plan,
  );
  // A read that the policy emptied out is a DENIAL when rows exist: record it
  // with the row_policy reason (distinct from table_grant) so an operator can
  // see it. The unfiltered count runs only in the empty case.
  if (policy.kind === "filter" && rawRows.length === 0) {
    const unfiltered = await executeSelectPlan(
      namespaceDir(ns),
      declaration,
      buildSelectPlan(declaration, {
        filters: input.filters ?? {},
        wantCount: true,
      }),
    );
    if ((unfiltered.totalCount ?? 0) > 0) {
      await auditPolicyDenial(input.auditPolicyDenial, {
        ns,
        table: declaration.name,
        op: "tables.read",
        principal: input.principal?.name ?? null,
        reason: ROW_POLICY_REASON,
      });
    }
  }
  const jsonCols = declaration.columns
    .filter((c) => c.type === "json")
    .map((c) => c.name);
  const rows = rawRows.map((row) => {
    if (jsonCols.length === 0) return row as Record<string, unknown>;
    const shaped: Record<string, unknown> = { ...(row as Record<string, unknown>) };
    for (const name of jsonCols) {
      const cell = shaped[name];
      if (typeof cell === "string") {
        try {
          shaped[name] = JSON.parse(cell) as unknown;
        } catch {
          // leave raw text when it isn't valid JSON
        }
      }
    }
    return shaped;
  });
  const embeds = normalizeEmbeds(input.embed);
  const withEmbeds =
    embeds.length > 0 ? embedDeclaredRelations(ns, declaration, rows, embeds) : rows;
  return { declaration, rows: withEmbeds, totalCount };
}

/** `?embed=a,b` / `?embed=a` / `["a","b"]` → names (order preserved). */
function normalizeEmbeds(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return [];
  const parts = Array.isArray(raw) ? raw : String(raw).split(",");
  const out: string[] = [];
  for (const part of parts) {
    const name = String(part).trim();
    if (name.length > 0 && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * REST-ATOMICITY-001 AC-3: one-level resource embedding over a DECLARED
 * relation.
 *
 * The relation comes from the SUPA-6 declaration (`columns[].references`) —
 * JSONL has no foreign key to introspect, and there is deliberately no second
 * declaration format. Each embedded row is resolved with the same key lookup
 * PATCH/DELETE use, so an embedded row is the row the API would serve for that
 * key (a missing target is `null`, never an omission).
 */
function embedDeclaredRelations(
  ns: string,
  declaration: TableDeclaration,
  rows: Record<string, unknown>[],
  embeds: string[],
): Record<string, unknown>[] {
  const nsDir = namespaceDir(ns);
  let current = rows;
  for (const name of embeds) {
    if (name.includes(".")) {
      throw new ApiError(
        `Only one level of embedding is supported: '${name}' names a nested relation`,
        400,
        "VALIDATION_ERROR",
      );
    }
    const referencing = declaration.columns.find(
      (column) => column.references?.table === name,
    );
    if (!referencing) {
      const declared = declaration.columns
        .filter((column) => column.references)
        .map((column) => column.references!.table);
      throw new ApiError(
        `Table '${declaration.name}' declares no reference to '${name}' (declared references: ${declared.length > 0 ? [...new Set(declared)].join(", ") : "none"})`,
        400,
        "VALIDATION_ERROR",
      );
    }
    const target = resolveTableDeclaration(ns, name);
    const targetKeyName = referencing.references!.column;
    const targetKey = target.columns.find((column) => column.name === targetKeyName);
    if (!targetKey) {
      throw new ApiError(
        `Table '${name}' has no column '${targetKeyName}' named by '${declaration.name}.${referencing.name}.references'`,
        500,
        "SCHEMA_INVALID",
      );
    }
    current = current.map((row) => {
      const value = row[referencing.name];
      const embedded =
        value === null || value === undefined
          ? null
          : findRowByPk(nsDir, target, targetKey, String(value));
      return { ...row, [name]: embedded };
    });
  }
  return current;
}

/** How long an accepted mutation's audit append waits out lock contention. */
const MUTATION_AUDIT_LOCK_DEADLINE_MS = 2_000;
const MUTATION_AUDIT_LOCK_RETRY_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Append an accepted mutation's change record, waiting out TRANSIENT
 * `SERIALIZER_LOCKED` (the serializer's flush and the commit chain hold the
 * namespace lock briefly; that is self-contention, not client contention).
 */
async function enqueueMutationAuditWithRetry(
  ns: string,
  entry: AuditEntry,
): Promise<void> {
  const deadline = Date.now() + MUTATION_AUDIT_LOCK_DEADLINE_MS;
  for (;;) {
    try {
      await getNamespaceWriter(ns).enqueueAudit(entry);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith("SERIALIZER_LOCKED") || Date.now() >= deadline) {
        throw error;
      }
      await sleep(MUTATION_AUDIT_LOCK_RETRY_MS);
    }
  }
}

/**
 * DB-SUPA-2: record an ACCEPTED table mutation in the namespace's audit
 * ledger through the SUPA-2 single writer, and resolve only once that append
 * is durable — a 2xx must never precede its audit record.
 */
async function recordTableMutationAudit(
  ns: string,
  table: string,
  op: "insert" | "update" | "delete",
  principal: string | null,
  location: { targetPath: string; dataLine: string; row: unknown },
): Promise<void> {
  let entry: AuditEntry;
  try {
    entry = acceptedTableMutationRecord({
      ns,
      namespacePath: namespaceDir(ns),
      table,
      op,
      principal,
      targetPath: location.targetPath,
      dataLine: location.dataLine,
      row: location.row,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ApiError(
      `mutation was applied but its change record could not be built: ${message}`,
      500,
      "AUDIT_APPEND_FAILED",
    );
  }
  try {
    await enqueueMutationAuditWithRetry(ns, entry);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const shuttingDown = message.startsWith("SERVER_SHUTTING_DOWN");
    throw new ApiError(
      `mutation was applied but its audit record could not be appended: ${message}`,
      shuttingDown ? 503 : 500,
      shuttingDown ? "SERVER_SHUTTING_DOWN" : "AUDIT_APPEND_FAILED",
    );
  }
}

/** How long a declared-table mutation waits for the namespace write lock. */
const LOCK_WAIT_RETRY_MS = 25;
const LOCK_WAIT_DEADLINE_MS = 2_000;

/** Acquire the namespace write lock, waiting (bounded) instead of failing fast. */
async function acquireNamespaceWriteLockWaiting(
  ns: string,
): Promise<NamespaceWriteLock | null> {
  const deadline = Date.now() + LOCK_WAIT_DEADLINE_MS;
  for (;;) {
    const lock = acquireNamespaceWriteLock(resolveNamespacesPath(), ns);
    if (lock) return lock;
    if (Date.now() >= deadline) return null;
    await sleep(LOCK_WAIT_RETRY_MS);
  }
}

/**
 * INSERT rows into a declared table.
 *
 * A DB-SUPA-6 `schema.json` declaration writes through the SUPA-2 serializer
 * (`NamespaceWriter.enqueue`) at the table's DECLARED storage path, so the
 * write rides the same validation → ordered write → audit/change-record →
 * commit path as every other durable row, and it observes the DDL fence: a
 * write attempted while a DDL operation holds the namespace lock receives the
 * retryable `SERIALIZER_LOCKED` result and writes nothing. Legacy
 * `tables/<table>.table.json` declarations keep the historical direct append,
 * which now honours the configured durability mode (DURABILITY-HONESTY-001)
 * and reports what it achieved.
 */
export async function insertTableRows(
  ns: string,
  table: string,
  rawRows: unknown[],
  principal?: AuthPrincipal,
  audit?: PolicyAuditSink,
): Promise<{ inserted: number; durability: TableDurability }> {
  const declaration = resolveTableDeclaration(ns, table);
  if (rawRows.length === 0) {
    throw new ApiError(
      "Insert body must contain at least one row",
      400,
      "VALIDATION_ERROR",
    );
  }
  const coerced = rawRows.map((row) =>
    coerceRowAgainstDeclaration(declaration, row),
  );
  // AUG-045: a row that omits (or nulls) the declared primary key would be
  // stored with id:null and become unreachable via the API — PATCH/DELETE both
  // require ?pk=eq.<value>. Validate ALL rows before any writer enqueue /
  // append so a bad batch inserts nothing (no partial inserts).
  if (declaration.primary) {
    for (const row of coerced) {
      const pkValue = row[declaration.primary];
      if (pkValue === undefined || pkValue === null || pkValue === "") {
        throw new ApiError(
          `Row is missing the required primary key '${declaration.primary}' for table '${declaration.name}'`,
          400,
          "VALIDATION_ERROR",
        );
      }
    }
  }
  // RLS-001: every row of the batch must satisfy the declared WRITE policy
  // before ANY row is written — a row the principal may not own is refused
  // whole-batch, never partially inserted.
  if (declaration.policy?.write) {
    for (const row of coerced) {
      const decision = rowPolicyDecision(
        declaration.policy,
        "write",
        row,
        principal,
      );
      if (!decision.allowed) {
        await auditPolicyDenial(audit, {
          ns,
          table: declaration.name,
          op: "tables.write",
          principal: principal?.name ?? null,
          reason: ROW_POLICY_REASON,
        });
        throw new ApiError(decision.message, 403, "FORBIDDEN");
      }
    }
  }
  if (declaration.source === "schema.json") {
    // Fail closed on a failed DDL recovery and on an invalid on-disk schema
    // before accepting new generic-table work.
    assertNamespaceDdlUsable(ns);
    assertNamespaceSchemaUsable(ns);
    const declaredColumns = declaration.columns.map((column) => ({
      name: column.name,
      type: column.declaredType!,
      nullable: column.nullable ?? true,
      ...(column.hasDefault ? { default: column.default } : {}),
    }));
    const writer = getNamespaceWriter(ns);
    const partition = partitionForStoragePath(declaration.glob);
    let inserted = 0;
    for (const row of coerced) {
      const record = storedRowFromApiRow(
        declaredColumns,
        declaration.format === "jsonl-positional" ? "positional" : "object",
        row,
      );
      const result = await writer.enqueue({
        ns,
        table: declaration.name,
        op: "insert",
        record,
        principal,
        targetPath: declaration.glob,
        ...(partition ? { partitionPath: partition } : {}),
      });
      if (!result.ok) {
        const status =
          result.code === "VALIDATION_ERROR"
            ? 422
            : result.code === "NOT_FOUND"
              ? 404
              : result.code === "FORBIDDEN"
                ? 403
                : result.code === "SERIALIZER_LOCKED" ||
                    result.code === "SERIALIZER_FENCED" ||
                    result.code === "SERVER_SHUTTING_DOWN"
                  ? 503
                  : 500;
        throw new ApiError(result.message, status, result.code);
      }
      inserted += 1;
    }
    const configured = durabilityHeaderFor(ns);
    return { inserted, durability: { configured, achieved: configured } };
  }
  // DURABILITY-HONESTY-001: the legacy `.table.json` insert used a bare
  // page-cache append while advertising the configured mode. The append now
  // honours the mode (fdatasync + directory fsync) and the response reports
  // what it achieved, not what was configured.
  const configured = durabilityHeaderFor(ns);
  const appended = appendRowsToTable(
    namespaceDir(ns),
    declaration,
    coerced,
    configured,
  );
  return {
    inserted: appended.inserted,
    durability: { configured, achieved: appended.achieved },
  };
}

/**
 * UPDATE rows by primary key.
 *
 * Rewrites the matching JSONL file rows and records the accepted mutation
 * through the NamespaceWriter as a DB-SUPA-5 change record, so the audit
 * ledger sees it before the acknowledgement and the change feed replays it.
 */
export async function updateTableRows(
  ns: string,
  table: string,
  pkRaw: unknown,
  patchBody: Record<string, unknown>,
  principal?: AuthPrincipal,
  audit?: PolicyAuditSink,
): Promise<{ updated: number; durability: TableDurability }> {
  const declaration = resolveTableDeclaration(ns, table);
  const { col, value } = resolvePkFilter(declaration, pkRaw, "PATCH/DELETE");
  const unknownKeys = Object.keys(patchBody).filter(
    (k) => !declaration.columns.some((c) => c.name === k),
  );
  if (unknownKeys.length > 0) {
    throw new ApiError(
      `Unknown column(s) in PATCH body: ${unknownKeys.join(", ")}`,
      400,
      "VALIDATION_ERROR",
    );
  }

  const nsDir = namespaceDir(ns);
  // DB-SUPA-2: the read-merge-rewrite runs under the namespace write lock —
  // the same lock the serializer's flush and the commit chain take — so two
  // writers (two processes on one namespace root included) cannot lose each
  // other's update. It is held for synchronous file work only; the audit
  // record below is enqueued AFTER it is released, so this request's own
  // awaited flush is never blocked behind its own critical section.
  const lock = await acquireNamespaceWriteLockWaiting(ns);
  if (!lock) {
    throw new ApiError(
      `Namespace '${ns}' is locked by another writer process`,
      503,
      "SERIALIZER_LOCKED",
    );
  }
  let coercedBody: Record<string, unknown> = {};
  let mutated = 0;
  const configured = durabilityHeaderFor(ns);
  let patchOutcome: MutationOutcome | null = null;
  let location: RowLineLocation | null = null;
  let policyDenial: string | null = null;
  try {
    const existing = findRowByPk(nsDir, declaration, col, value);
    if (existing !== null) {
      // RLS-001: BOTH the row on disk and the row the patch produces must
      // satisfy the write policy. Checking only the merged row would let a
      // principal legalize a theft in one request (`{owner: "me"}`); checking
      // only the existing row would let a patch move the row to somebody else.
      // The refusal is reported as `updated: 0`, the same shape as "no row
      // matched", so the verb is not an existence oracle; the REAL reason is
      // recorded in the namespace audit.
      const existingDecision = rowPolicyDecision(
        declaration.policy,
        "write",
        existing,
        principal,
      );
      const policyDecision = existingDecision.allowed
        ? rowPolicyDecision(
            declaration.policy,
            "write",
            { ...existing, ...patchBody },
            principal,
          )
        : existingDecision;
      if (!policyDecision.allowed) {
        policyDenial = policyDecision.message;
        throw new PolicyRefusal(policyDecision.message);
      }
      // Validate the MERGED row, not each body field in isolation: a partial
      // patch is legal (only the named columns change) while every declared
      // constraint is still enforced against the row the patch produces.
      const merged = coerceRowAgainstDeclaration(declaration, {
        ...existing,
        ...patchBody,
      });
      for (const key of Object.keys(patchBody)) coercedBody[key] = merged[key];
      patchOutcome = patchRowsByPk(nsDir, declaration, col, value, coercedBody, {
        mode: configured,
      });
      mutated = patchOutcome.mutated;
      if (mutated > 0) {
        // DB-SUPA-5: the change record's `contentHash` must name the row line
        // as it now exists on disk, so read it back instead of re-serializing.
        // Read INSIDE the lock so a concurrent writer in another process
        // cannot replace the line between the rewrite and the read. A patch
        // that moves the primary key is looked up under its NEW value.
        const lookupValue = Object.prototype.hasOwnProperty.call(
          coercedBody,
          col.name,
        )
          ? String(coercedBody[col.name])
          : value;
        location = findRowLineByPk(nsDir, declaration, col, lookupValue);
      }
    }
  } catch (error) {
    if (!(error instanceof PolicyRefusal)) throw error;
  } finally {
    releaseNamespaceWriteLock(lock);
  }
  if (policyDenial !== null) {
    await auditPolicyDenial(audit, {
      ns,
      table: declaration.name,
      op: "tables.write",
      principal: principal?.name ?? null,
      reason: ROW_POLICY_REASON,
    });
  }
  // No matching row: nothing was written and there is nothing to audit.
  if (mutated === 0) {
    return { updated: 0, durability: { configured, achieved: configured } };
  }
  if (location === null) {
    throw new ApiError(
      `mutation was applied but the updated row could not be located for its change record`,
      500,
      "AUDIT_APPEND_FAILED",
    );
  }
  await recordTableMutationAudit(
    ns,
    declaration.name,
    "update",
    principal?.name ?? null,
    {
      targetPath: namespaceRelativePath(nsDir, location.filePath),
      dataLine: location.line,
      row: location.row,
    },
  );
  return {
    updated: mutated,
    durability: {
      configured,
      achieved: patchOutcome?.achieved ?? configured,
    },
  };
}

/**
 * DELETE rows by primary key.
 *
 * Rewrites the matching JSONL files with the row dropped and records the
 * accepted delete through the NamespaceWriter as a tombstone change record
 * before the acknowledgement.
 */
export async function deleteTableRows(
  ns: string,
  table: string,
  pkRaw: unknown,
  principal?: AuthPrincipal,
  audit?: PolicyAuditSink,
): Promise<{ deleted: number; durability: TableDurability }> {
  const declaration = resolveTableDeclaration(ns, table);
  const { col, value } = resolvePkFilter(declaration, pkRaw, "PATCH/DELETE");

  const nsDir = namespaceDir(ns);
  // DB-SUPA-2: same namespace write lock as PATCH — the read-predicate-write
  // pair must not interleave with another writer process, and a same-process
  // holder (flush / commit) is waited on rather than reported as contention.
  const lock = await acquireNamespaceWriteLockWaiting(ns);
  if (!lock) {
    throw new ApiError(
      `Namespace '${ns}' is locked by another writer process`,
      503,
      "SERIALIZER_LOCKED",
    );
  }
  let removed = 0;
  const configured = durabilityHeaderFor(ns);
  let deleteOutcome: MutationOutcome | null = null;
  // DB-SUPA-5: capture the row BEFORE the rewrite — a physical delete removes
  // the line from the data file, so the tombstone record's `contentHash` must
  // name the last committed row image (resolved by replay against the parent
  // commit), not a line the child no longer has.
  const location = findRowLineByPk(nsDir, declaration, col, value);
  // RLS-001: a row outside the principal's write policy is not deleted, and
  // the answer is the same `deleted: 0` a missing row gets (no oracle). The
  // row image the tombstone would have named is never read for the caller.
  if (location !== null) {
    const policyDecision = rowPolicyDecision(
      declaration.policy,
      "write",
      location.row,
      principal,
    );
    if (!policyDecision.allowed) {
      releaseNamespaceWriteLock(lock);
      await auditPolicyDenial(audit, {
        ns,
        table: declaration.name,
        op: "tables.write",
        principal: principal?.name ?? null,
        reason: ROW_POLICY_REASON,
      });
      return { deleted: 0, durability: { configured, achieved: configured } };
    }
  }
  try {
    deleteOutcome = deleteRowsByPk(nsDir, declaration, col, value, configured);
    removed = deleteOutcome.mutated;
  } finally {
    releaseNamespaceWriteLock(lock);
  }
  // Nothing matched: no tombstone to record, nothing was deleted.
  if (removed === 0) {
    return { deleted: 0, durability: { configured, achieved: configured } };
  }
  if (location === null) {
    throw new ApiError(
      `mutation was applied but the deleted row could not be located for its tombstone record`,
      500,
      "AUDIT_APPEND_FAILED",
    );
  }
  await recordTableMutationAudit(
    ns,
    declaration.name,
    "delete",
    principal?.name ?? null,
    {
      targetPath: namespaceRelativePath(nsDir, location.filePath),
      dataLine: location.line,
      row: location.row,
    },
  );
  return {
    deleted: removed,
    durability: { configured, achieved: deleteOutcome?.achieved ?? configured },
  };
}

// ---------------------------------------------------------------------------
// REST-ATOMICITY-001 — upsert by primary key + a transaction envelope
// ---------------------------------------------------------------------------
//
// Both verbs exist because an app built on the store could not be atomic:
// PATCH answers `{updated:0}` for a missing row (a read-then-write by the
// client is a lost-update race), and N independent requests have no unit of
// work. Both therefore run the READ and the WRITE inside ONE namespace write
// lock — the same lock the serializer's flush and the commit chain take — so
// the decision cannot interleave with another writer process.
//
// Why the in-lock writes are the store's own primitives rather than
// `NamespaceWriter.enqueue`: the serializer is asynchronous and takes this very
// lock to flush, so an `await enqueue()` while holding the lock would deadlock
// against its own flush. Validation still runs through the SUPA-6 validator
// (`coerceRowAgainstDeclaration`), the DDL/schema fences are asserted before
// the lock is taken, and every accepted action's change record is appended
// through the serializer AFTER the lock is released — one record per action,
// which is also one change-feed entry per action.

/** Default bound on the actions one envelope may carry. */
export const TRANSACTION_MAX_ACTIONS = 100;
/** Bound on the bytes an envelope may snapshot for rollback. */
export const TRANSACTION_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;

/** Type a URL-supplied primary key into the column's API representation. */
function typedPkValue(
  col: TableDeclaration["columns"][number],
  value: string,
): unknown {
  // Declared v1 (SUPA-6) representations are canonical STRINGS for int64 /
  // timestamp / bytes — hand them through and let the declared validator
  // normalise; legacy `.table.json` declarations take real JSON primitives.
  if (col.declaredType !== undefined) return value;
  switch (col.type) {
    case "integer":
    case "bigint": {
      if (!/^-?\d+$/.test(value)) {
        throw new ApiError(
          `Primary key '${col.name}' requires an integer, got ${JSON.stringify(value)}`,
          400,
          "VALIDATION_ERROR",
        );
      }
      const numeric = Number(value);
      if (!Number.isSafeInteger(numeric)) {
        throw new ApiError(
          `Primary key '${col.name}' value ${JSON.stringify(value)} is outside the safe integer range`,
          400,
          "VALIDATION_ERROR",
        );
      }
      return numeric;
    }
    case "double": {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        throw new ApiError(
          `Primary key '${col.name}' requires a finite number, got ${JSON.stringify(value)}`,
          400,
          "VALIDATION_ERROR",
        );
      }
      return numeric;
    }
    case "boolean": {
      if (value === "true") return true;
      if (value === "false") return false;
      throw new ApiError(
        `Primary key '${col.name}' requires true|false, got ${JSON.stringify(value)}`,
        400,
        "VALIDATION_ERROR",
      );
    }
    default:
      return value;
  }
}

/** Which branch of an upsert ran, the resulting row, and durability achieved. */
export interface UpsertTableResult {
  outcome: "inserted" | "updated";
  row: Record<string, unknown>;
  durability: TableDurability;
}

/**
 * PUT semantics: insert-or-replace one row by primary key, atomically.
 *
 * One serialized operation under the namespace write lock: the row lookup and
 * the write that follows it cannot be split by another writer, so two
 * concurrent upserts of one key produce exactly one row (the falsifier the
 * row's acceptance criteria name). Returns which branch ran plus the resulting
 * row image, so a client never has to follow up with a GET.
 */
export async function upsertTableRow(
  ns: string,
  table: string,
  pkRaw: unknown,
  body: Record<string, unknown>,
  principal?: AuthPrincipal,
  audit?: PolicyAuditSink,
): Promise<UpsertTableResult> {
  const declaration = resolveTableDeclaration(ns, table);
  const { col, value } = resolvePkFilter(declaration, pkRaw, "PUT");
  const unknownKeys = Object.keys(body).filter(
    (key) => !declaration.columns.some((column) => column.name === key),
  );
  if (unknownKeys.length > 0) {
    throw new ApiError(
      `Unknown column(s) in PUT body: ${unknownKeys.join(", ")}`,
      400,
      "VALIDATION_ERROR",
    );
  }
  if (declaration.source === "schema.json") {
    assertNamespaceDdlUsable(ns);
    assertNamespaceSchemaUsable(ns);
  }

  const pkTyped = typedPkValue(col, String(value));
  if (Object.prototype.hasOwnProperty.call(body, col.name)) {
    const supplied = body[col.name];
    if (supplied !== null && String(supplied) !== String(pkTyped)) {
      throw new ApiError(
        `PUT body carries '${col.name}: ${JSON.stringify(supplied)}' which does not match the resource key '${value}'`,
        409,
        "PRIMARY_KEY_CONFLICT",
      );
    }
  }

  const nsDir = namespaceDir(ns);
  const configured = durabilityHeaderFor(ns);
  const lock = await acquireNamespaceWriteLockWaiting(ns);
  if (!lock) {
    throw new ApiError(
      `Namespace '${ns}' is locked by another writer process`,
      503,
      "SERIALIZER_LOCKED",
    );
  }

  let outcome: "inserted" | "updated" = "updated";
  let resultRow: Record<string, unknown> = {};
  let achieved: AchievedWriteMode = configured;
  let policyDenial: string | null = null;
  let record:
    | { op: "insert" | "update"; targetPath: string; dataLine: string; row: unknown }
    | null = null;
  try {
    const existing = findRowByPk(nsDir, declaration, col, value);
    if (existing !== null) {
      // RLS-001: replacing a row is a WRITE on it — a row another principal
      // owns is refused, and so is a replacement that moves ownership away.
      // Unlike PATCH this verb answers 403 (see below), so the refusal is
      // named rather than shaped as a zero-match.
      const existingDecision = rowPolicyDecision(
        declaration.policy,
        "write",
        existing,
        principal,
      );
      const policyDecision = existingDecision.allowed
        ? rowPolicyDecision(
            declaration.policy,
            "write",
            { ...existing, ...body },
            principal,
          )
        : existingDecision;
      if (!policyDecision.allowed) {
        policyDenial = policyDecision.message;
        throw new PolicyRefusal(policyDecision.message);
      }
      // The path key wins over the stored row's key: a PUT replaces the
      // resource the URL names, it does not move it.
      const merged = coerceRowAgainstDeclaration(declaration, {
        ...existing,
        ...body,
        [col.name]: existing[col.name],
      });
      const patched = patchRowsByPk(nsDir, declaration, col, value, merged, {
        mode: configured,
      });
      if (patched.mutated === 0) {
        throw new ApiError(
          `PUT could not replace '${declaration.name}' row ${col.name}=${value}: the row changed under the write lock`,
          409,
          "CONFLICT",
        );
      }
      achieved = patched.achieved;
      resultRow = merged;
      const location = findRowLineByPk(
        nsDir,
        declaration,
        col,
        String(merged[col.name] ?? value),
      );
      if (location === null) {
        throw new ApiError(
          "mutation was applied but the replaced row could not be located for its change record",
          500,
          "AUDIT_APPEND_FAILED",
        );
      }
      record = {
        op: "update",
        targetPath: namespaceRelativePath(nsDir, location.filePath),
        dataLine: location.line,
        row: location.row,
      };
    } else {
      outcome = "inserted";
      const candidate = coerceRowAgainstDeclaration(declaration, {
        ...body,
        [col.name]: pkTyped,
      });
      const policyDecision = rowPolicyDecision(
        declaration.policy,
        "write",
        candidate,
        principal,
      );
      if (!policyDecision.allowed) {
        policyDenial = policyDecision.message;
        throw new PolicyRefusal(policyDecision.message);
      }
      const appended = appendRowsToTable(nsDir, declaration, [candidate], configured);
      achieved = appended.achieved;
      resultRow = candidate;
      const files = resolveTableFiles(nsDir, declaration);
      const targetPath =
        files.length > 0
          ? files[files.length - 1]!.absPath
          : deriveSyntheticFilePath(nsDir, declaration);
      record = {
        op: "insert",
        targetPath: namespaceRelativePath(nsDir, targetPath),
        dataLine: serializeRowLine(declaration, candidate),
        row: candidate,
      };
    }
  } catch (error) {
    if (!(error instanceof PolicyRefusal)) throw error;
  } finally {
    releaseNamespaceWriteLock(lock);
  }

  if (policyDenial !== null) {
    await auditPolicyDenial(audit, {
      ns,
      table: declaration.name,
      op: "tables.write",
      principal: principal?.name ?? null,
      reason: ROW_POLICY_REASON,
    });
    // PUT is replace-or-create: refusing it cannot be shaped as a silent
    // zero-match without inviting a retry loop, so it names the refusal. The
    // PATCH/DELETE verbs above keep the no-oracle shape.
    throw new ApiError(policyDenial, 403, "FORBIDDEN");
  }

  if (record === null) {
    throw new ApiError(
      "upsert produced no change record",
      500,
      "AUDIT_APPEND_FAILED",
    );
  }
  await recordTableMutationAudit(ns, declaration.name, record.op, principal?.name ?? null, {
    targetPath: record.targetPath,
    dataLine: record.dataLine,
    row: record.row,
  });
  return { outcome, row: resultRow, durability: { configured, achieved } };
}

/** One action of a transaction envelope. */
export interface TableTransactionAction {
  op: "insert" | "update" | "upsert" | "delete";
  table: string;
  /** Full row (insert), replacement row (upsert). */
  row?: Record<string, unknown>;
  /** Partial row (update). */
  patch?: Record<string, unknown>;
  /** Primary-key equality filter: `eq.<v>` or the bare value. */
  pk?: unknown;
}

export interface TableTransactionActionResult {
  index: number;
  op: TableTransactionAction["op"];
  table: string;
  outcome: "inserted" | "updated" | "deleted";
  affected: number;
  row: Record<string, unknown> | null;
}

export interface TableTransactionSuccess {
  ok: true;
  applied: number;
  results: TableTransactionActionResult[];
  durability: TableDurability;
}

/**
 * Every action failed: NOTHING from the envelope is on disk. `applied: 0` is a
 * claim the envelope proves by restoring the pre-transaction bytes of every
 * file it could have touched (and deleting any file it created).
 */
export interface TableTransactionFailure {
  ok: false;
  applied: 0;
  failedAction: number;
  action: TableTransactionAction | null;
  status: number;
  code: string;
  message: string;
  rolledBack: true;
}

export type TableTransactionOutcome =
  | TableTransactionSuccess
  | TableTransactionFailure;

/**
 * Fault-injection seam. Production callers never pass hooks; the rollback
 * falsifier needs a throw BETWEEN two actions, which no request body can
 * produce on its own.
 */
export interface TableTransactionOptions {
  /** RLS-001: where a row-policy denial is recorded (namespace audit). */
  auditPolicyDenial?: PolicyAuditSink;
  hooks?: {
    afterAction?: (index: number) => void;
    afterBarrier?: () => void;
  };
}

interface PreparedTransactionAction {
  action: TableTransactionAction;
  declaration: TableDeclaration;
  pkCol: TableDeclaration["columns"][number] | null;
  pkValue: string | null;
  row: Record<string, unknown> | null;
  patch: Record<string, unknown> | null;
}

/** Structural + per-action validation. Throws `ApiError` before any write. */
function prepareTransactionActions(
  ns: string,
  rawActions: unknown,
  principal?: AuthPrincipal,
  audit?: PolicyAuditSink,
): PreparedTransactionAction[] {
  if (!Array.isArray(rawActions) || rawActions.length === 0) {
    throw new ApiError(
      "Transaction body must be { actions: [...] } with at least one action",
      400,
      "VALIDATION_ERROR",
    );
  }
  if (rawActions.length > TRANSACTION_MAX_ACTIONS) {
    throw new ApiError(
      `Transaction carries ${rawActions.length} actions; the envelope limit is ${TRANSACTION_MAX_ACTIONS}`,
      400,
      "VALIDATION_ERROR",
    );
  }
  const prepared: PreparedTransactionAction[] = [];
  for (const [index, raw] of rawActions.entries()) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new ApiError(
        `Transaction action ${index} must be an object`,
        400,
        "VALIDATION_ERROR",
      );
    }
    const action = raw as TableTransactionAction;
    if (
      action.op !== "insert" &&
      action.op !== "update" &&
      action.op !== "upsert" &&
      action.op !== "delete"
    ) {
      throw new ApiError(
        `Transaction action ${index} has unknown op ${JSON.stringify(action.op)}; expected insert|update|upsert|delete`,
        400,
        "VALIDATION_ERROR",
      );
    }
    if (typeof action.table !== "string" || action.table.length === 0) {
      throw new ApiError(
        `Transaction action ${index} requires a table name`,
        400,
        "VALIDATION_ERROR",
      );
    }
    const declaration = resolveTableDeclaration(ns, action.table);
    let pkCol: PreparedTransactionAction["pkCol"] = null;
    let pkValue: string | null = null;
    if (action.op !== "insert") {
      const filter = resolvePkFilter(declaration, action.pk, action.op.toUpperCase());
      pkCol = filter.col;
      pkValue = filter.value;
    }
    let row: Record<string, unknown> | null = null;
    let patch: Record<string, unknown> | null = null;
    const objectBody = (value: unknown, what: string): Record<string, unknown> => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ApiError(
          `Transaction action ${index} (${action.op} ${action.table}): ${what} must be a JSON object`,
          400,
          "VALIDATION_ERROR",
        );
      }
      return value as Record<string, unknown>;
    };
    if (action.op === "insert" || action.op === "upsert") {
      row = objectBody(action.row, "row");
      // Validate the FULL row now (SUPA-6 canonical rules included) so a bad
      // action fails before the envelope has written anything.
      const seeded =
        action.op === "upsert" && pkCol !== null && pkValue !== null
          ? { ...row, [pkCol.name]: typedPkValue(pkCol, pkValue) }
          : row;
      row = coerceRowAgainstDeclaration(declaration, seeded);
      if (declaration.primary !== null) {
        const pk = row[declaration.primary];
        if (pk === undefined || pk === null || pk === "") {
          throw new ApiError(
            `Transaction action ${index} is missing the primary key '${declaration.primary}' for table '${declaration.name}'`,
            400,
            "VALIDATION_ERROR",
          );
        }
      }
      // RLS-001: the row a transaction wants to write must satisfy the
      // table's declared WRITE policy, exactly like the single-row verbs.
      if (declaration.policy?.write) {
        const policyDecision = rowPolicyDecision(
          declaration.policy,
          "write",
          row,
          principal,
        );
        if (!policyDecision.allowed) {
          void auditPolicyDenial(audit, {
            ns,
            table: declaration.name,
            op: "tables.write",
            principal: principal?.name ?? null,
            reason: ROW_POLICY_REASON,
          });
          throw new ApiError(
            `Transaction action ${index} (${action.op} ${action.table}): ${policyDecision.message}`,
            403,
            "FORBIDDEN",
          );
        }
      }
    }
    if (action.op === "update") {
      patch = objectBody(action.patch, "patch");
      const unknown = Object.keys(patch).filter(
        (key) => !declaration.columns.some((column) => column.name === key),
      );
      if (unknown.length > 0) {
        throw new ApiError(
          `Transaction action ${index} (update ${action.table}): unknown column(s) ${unknown.join(", ")}`,
          400,
          "VALIDATION_ERROR",
        );
      }
    }
    prepared.push({ action, declaration, pkCol, pkValue, row, patch });
  }
  return prepared;
}

interface SnapshotFile {
  path: string;
  bytes: Buffer | null;
}

/** Pre-image of every file the envelope could touch, or a 413 when too large. */
function snapshotCandidateFiles(
  nsDir: string,
  declarations: TableDeclaration[],
): Map<string, SnapshotFile> {
  const snapshot = new Map<string, SnapshotFile>();
  let total = 0;
  for (const declaration of declarations) {
    const candidates = new Set<string>(
      resolveTableFiles(nsDir, declaration).map((file) => file.absPath),
    );
    candidates.add(deriveSyntheticFilePath(nsDir, declaration));
    for (const candidate of candidates) {
      if (snapshot.has(candidate)) continue;
      let bytes: Buffer | null = null;
      try {
        bytes = fs.readFileSync(candidate);
      } catch {
        bytes = null;
      }
      total += bytes?.length ?? 0;
      if (total > TRANSACTION_SNAPSHOT_MAX_BYTES) {
        throw new ApiError(
          `Transaction would snapshot ${total} bytes; the envelope cap is ${TRANSACTION_SNAPSHOT_MAX_BYTES} bytes — split it into smaller envelopes`,
          413,
          "PAYLOAD_TOO_LARGE",
        );
      }
      snapshot.set(candidate, { path: candidate, bytes });
    }
  }
  return snapshot;
}

/** Restore every snapshotted file to its pre-envelope bytes. */
function restoreSnapshot(
  snapshot: Map<string, SnapshotFile>,
  mode: WriteMode,
): void {
  const touched: string[] = [];
  for (const entry of snapshot.values()) {
    if (entry.bytes === null) {
      // Did not exist before: anything there now was created by this envelope.
      if (fs.existsSync(entry.path)) {
        fs.unlinkSync(entry.path);
        touched.push(path.dirname(entry.path));
      }
      continue;
    }
    const current = fs.existsSync(entry.path)
      ? fs.readFileSync(entry.path)
      : null;
    if (current !== null && entry.bytes.equals(current)) continue;
    fs.mkdirSync(path.dirname(entry.path), { recursive: true });
    fs.writeFileSync(entry.path, entry.bytes);
    touched.push(entry.path);
  }
  if (touched.length > 0) {
    // Rollback is not acknowledged as a write, but a restored file must still
    // be on stable storage before the failure response claims "nothing applied".
    barrierWrittenPaths(touched, mode);
  }
}

interface AppliedAction {
  summary: TableTransactionActionResult;
  record: {
    op: "insert" | "update" | "delete";
    table: string;
    targetPath: string;
    dataLine: string;
    row: unknown;
  };
}

/**
 * Apply ONE action against the store primitives, with the namespace write lock
 * already held. Buffered writes: the envelope bars everything once at commit.
 */
function applyTransactionActionLocked(
  nsDir: string,
  prepared: PreparedTransactionAction,
  index: number,
  principal?: AuthPrincipal,
  audit?: PolicyAuditSink,
): AppliedAction {
  const { action, declaration } = prepared;
  const table = declaration.name;
  if (action.op === "insert") {
    if (declaration.primary !== null) {
      const pk = prepared.row![declaration.primary];
      const pkCol = declaration.columns.find(
        (column) => column.name === declaration.primary,
      )!;
      if (findRowByPk(nsDir, declaration, pkCol, String(pk)) !== null) {
        throw new ApiError(
          `insert '${table}' would create a duplicate primary key ${declaration.primary}=${String(pk)}`,
          409,
          "PRIMARY_KEY_CONFLICT",
        );
      }
    }
    appendRowsToTable(nsDir, declaration, [prepared.row!], "buffered");
    const files = resolveTableFiles(nsDir, declaration);
    const targetPath =
      files.length > 0
        ? files[files.length - 1]!.absPath
        : deriveSyntheticFilePath(nsDir, declaration);
    return {
      summary: {
        index,
        op: action.op,
        table,
        outcome: "inserted",
        affected: 1,
        row: prepared.row,
      },
      record: {
        op: "insert",
        table,
        targetPath: namespaceRelativePath(nsDir, targetPath),
        dataLine: serializeRowLine(declaration, prepared.row!),
        row: prepared.row,
      },
    };
  }

  const pkCol = prepared.pkCol!;
  const pkValue = prepared.pkValue!;
  if (action.op === "update") {
    // RLS-001: the merged row must satisfy the write policy — the envelope
    // cannot silently rewrite a row another principal owns.
    const existing = findRowByPk(nsDir, declaration, pkCol, pkValue);
    if (existing !== null) {
      const policyDecision = rowPolicyDecision(
        declaration.policy,
        "write",
        { ...existing, ...prepared.patch! },
        principal,
      );
      if (!policyDecision.allowed) {
        void auditPolicyDenial(audit, {
          ns: path.basename(nsDir),
          table,
          op: "tables.write",
          principal: principal?.name ?? null,
          reason: ROW_POLICY_REASON,
        });
        throw new ApiError(policyDecision.message, 403, "FORBIDDEN");
      }
    }
    const mutated = patchRowsByPk(nsDir, declaration, pkCol, pkValue, prepared.patch!, {
      mode: "buffered",
    });
    if (mutated.mutated === 0) {
      throw new ApiError(
        `update '${table}' matched no row for ?pk=eq.${pkValue}`,
        404,
        "NOT_FOUND",
      );
    }
    const location = findRowLineByPk(nsDir, declaration, pkCol, pkValue);
    if (location === null) {
      throw new ApiError(
        `update '${table}' applied but the updated row could not be located for its change record`,
        500,
        "AUDIT_APPEND_FAILED",
      );
    }
    return {
      summary: {
        index,
        op: action.op,
        table,
        outcome: "updated",
        affected: mutated.mutated,
        row: location.row as Record<string, unknown>,
      },
      record: {
        op: "update",
        table,
        targetPath: namespaceRelativePath(nsDir, location.filePath),
        dataLine: location.line,
        row: location.row,
      },
    };
  }

  if (action.op === "delete") {
    const location = findRowLineByPk(nsDir, declaration, pkCol, pkValue);
    if (location === null) {
      throw new ApiError(
        `delete '${table}' matched no row for ?pk=eq.${pkValue}`,
        404,
        "NOT_FOUND",
      );
    }
    const policyDecision = rowPolicyDecision(
      declaration.policy,
      "write",
      location.row,
      principal,
    );
    if (!policyDecision.allowed) {
      void auditPolicyDenial(audit, {
        ns: path.basename(nsDir),
        table,
        op: "tables.write",
        principal: principal?.name ?? null,
        reason: ROW_POLICY_REASON,
      });
      throw new ApiError(policyDecision.message, 403, "FORBIDDEN");
    }
    const removed = deleteRowsByPk(nsDir, declaration, pkCol, pkValue, "buffered");
    if (removed.mutated === 0) {
      throw new ApiError(
        `delete '${table}' matched no row for ?pk=eq.${pkValue}`,
        404,
        "NOT_FOUND",
      );
    }
    return {
      summary: {
        index,
        op: action.op,
        table,
        outcome: "deleted",
        affected: removed.mutated,
        row: null,
      },
      record: {
        op: "delete",
        table,
        targetPath: namespaceRelativePath(nsDir, location.filePath),
        dataLine: location.line,
        row: location.row,
      },
    };
  }

  // upsert: the same decision `upsertTableRow` makes, inside the envelope.
  const existing = findRowByPk(nsDir, declaration, pkCol, pkValue);
  if (existing !== null) {
    const merged = coerceRowAgainstDeclaration(declaration, {
      ...existing,
      ...prepared.row!,
      [pkCol.name]: existing[pkCol.name],
    });
    const patched = patchRowsByPk(nsDir, declaration, pkCol, pkValue, merged, {
      mode: "buffered",
    });
    if (patched.mutated === 0) {
      throw new ApiError(
        `upsert '${table}' could not replace ?pk=eq.${pkValue}`,
        409,
        "CONFLICT",
      );
    }
    const location = findRowLineByPk(nsDir, declaration, pkCol, pkValue);
    if (location === null) {
      throw new ApiError(
        `upsert '${table}' applied but the replaced row could not be located for its change record`,
        500,
        "AUDIT_APPEND_FAILED",
      );
    }
    return {
      summary: {
        index,
        op: action.op,
        table,
        outcome: "updated",
        affected: patched.mutated,
        row: location.row as Record<string, unknown>,
      },
      record: {
        op: "update",
        table,
        targetPath: namespaceRelativePath(nsDir, location.filePath),
        dataLine: location.line,
        row: location.row,
      },
    };
  }
  appendRowsToTable(nsDir, declaration, [prepared.row!], "buffered");
  const files = resolveTableFiles(nsDir, declaration);
  const targetPath =
    files.length > 0
      ? files[files.length - 1]!.absPath
      : deriveSyntheticFilePath(nsDir, declaration);
  return {
    summary: {
      index,
      op: action.op,
      table,
      outcome: "inserted",
      affected: 1,
      row: prepared.row,
    },
    record: {
      op: "insert",
      table,
      targetPath: namespaceRelativePath(nsDir, targetPath),
      dataLine: serializeRowLine(declaration, prepared.row!),
      row: prepared.row,
    },
  };
}

/**
 * Run an ordered envelope of mutations as a UNIT.
 *
 * Contract (REST-ATOMICITY-001 AC-2):
 *   - all-or-nothing: on any failure every file the envelope could have
 *     touched is restored to its pre-envelope bytes (and any file it created
 *     is removed), so the failure response's `applied: 0` is true;
 *   - one durability barrier at commit (not one per action);
 *   - one audit record — and therefore one change-feed entry — per action;
 *   - the failure names the action that failed (`failedAction`).
 *
 * Validation of the whole envelope happens BEFORE any write, so a malformed
 * action never gets as far as the rollback path.
 */
export async function runTableTransaction(
  ns: string,
  rawActions: unknown,
  principal?: AuthPrincipal,
  options: TableTransactionOptions = {},
): Promise<TableTransactionOutcome> {
  const prepared = prepareTransactionActions(ns, rawActions, principal, options.auditPolicyDenial);
  const declarations = [...new Map(
    prepared.map((entry) => [entry.declaration.name, entry.declaration]),
  ).values()];
  if (declarations.some((declaration) => declaration.source === "schema.json")) {
    assertNamespaceDdlUsable(ns);
    assertNamespaceSchemaUsable(ns);
  }
  const nsDir = namespaceDir(ns);
  const configured = durabilityHeaderFor(ns);

  const lock = await acquireNamespaceWriteLockWaiting(ns);
  if (!lock) {
    throw new ApiError(
      `Namespace '${ns}' is locked by another writer process`,
      503,
      "SERIALIZER_LOCKED",
    );
  }

  const results: TableTransactionActionResult[] = [];
  const records: AppliedAction["record"][] = [];
  let achieved: AchievedWriteMode = configured;
  try {
    const snapshot = snapshotCandidateFiles(nsDir, declarations);
    try {
      for (const [index, entry] of prepared.entries()) {
        const applied = applyTransactionActionLocked(
          nsDir,
          entry,
          index,
          principal,
          options.auditPolicyDenial,
        );
        results.push(applied.summary);
        records.push(applied.record);
        options.hooks?.afterAction?.(index);
      }
      // ONE barrier for the whole envelope.
      achieved = barrierWrittenPaths(
        [...snapshot.values()]
          .map((entry) => entry.path)
          .filter((file) => fs.existsSync(file)),
        configured,
      );
      options.hooks?.afterBarrier?.();
    } catch (error) {
      try {
        restoreSnapshot(snapshot, configured);
      } catch (rollbackError) {
        // Never report "rolled back" when the rollback itself failed.
        throw new ApiError(
          `Transaction failed AND the rollback could not restore the pre-envelope bytes: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)} — inspect the namespace before retrying`,
          500,
          "ROLLBACK_FAILED",
        );
      }
      const status = error instanceof ApiError ? error.status : 500;
      const code = error instanceof ApiError ? error.code ?? "TRANSACTION_FAILED" : "TRANSACTION_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      const failedAction = results.length;
      const failedEntry = prepared[failedAction];
      const where = failedEntry
        ? `${failedEntry.action.op} ${failedEntry.action.table}`
        : "commit barrier";
      return {
        ok: false,
        applied: 0,
        failedAction,
        action: failedEntry?.action ?? null,
        status,
        code,
        message: `Transaction failed at action ${failedAction} (${where}): ${message}. Nothing from this envelope was applied — every touched file was restored.`,
        rolledBack: true,
      };
    }
  } finally {
    releaseNamespaceWriteLock(lock);
  }

  // One change record per action, appended through the serializer AFTER the
  // lock is released (its flush takes the same lock).
  for (const record of records) {
    await recordTableMutationAudit(ns, record.table, record.op, principal?.name ?? null, {
      targetPath: record.targetPath,
      dataLine: record.dataLine,
      row: record.row,
    });
  }

  return {
    ok: true,
    applied: results.length,
    results,
    durability: { configured, achieved },
  };
}
