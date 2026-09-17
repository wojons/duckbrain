/**
 * DB-SUPA-6 — admin-only DDL coordinator (`docs/specs/SUPA-6-ddl.md`).
 *
 * Every mutation of `namespaces/<ns>/schema.json` goes through here:
 * `createTable`, `addColumn`, `retypeColumn`, `declareView`, `redeclareView`.
 * Nothing else in the codebase writes that file (direct edits are unsupported
 * production DDL), which is what makes the migration orderings below true.
 *
 * Fencing. The exclusion primitive is the EXISTING cross-process namespace
 * write lock (`src/serialization/lock.ts`, used by `NamespaceWriter`) — DDL
 * does not invent a parallel lock. While an operation holds it, a concurrent
 * write from any process (or from this process's own serializer) fails the
 * lock acquisition and receives the defined retryable `SERIALIZER_LOCKED`
 * result, writing neither source nor replacement data. A writer never queues
 * work across the switch because it validates and writes inside the same
 * locked flush, so after DDL completion a write validates against exactly one
 * schema version.
 *
 * Durability + recovery. A `materialize` operation writes a fresh immutable
 * generation at a NEW path, fsyncs it, validates every row in it, and only
 * then atomically renames a temporary full replacement over `schema.json`
 * (the single reader-visible switch). The old generation is never renamed
 * over, truncated or deleted. Every operation journals its old/new schema
 * hash, paths and generation digest under `.duckbrain-ddl/<operation-id>.json`
 * so a crash can be classified:
 *   - crash before the switch  → recovery removes the unpublished generation
 *     (old schema + old path stay live);
 *   - crash after the switch   → recovery verifies the new path/digest and
 *     finalizes, or fails closed. It never rolls the schema back: that would
 *     create a second, ambiguous switch.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { commitNamespace } from "../git/autocommit.js";
import { resolveWriteMode } from "../storage/durability.js";
import { addPartition } from "../storage/manifest.js";
import { ApiError } from "../http/middleware/errorHandler.js";
import { authorizeResource, hasAnyRole } from "../auth/roles.js";
import type { AuthPrincipal } from "../auth/middleware.js";
import {
  acquireNamespaceWriteLock,
  releaseNamespaceWriteLock,
  type NamespaceWriteLock,
} from "./lock.js";
import {
  SCHEMA_FILE_NAME,
  assertNamespaceSchemaUsable,
  declaredRowValidator,
  invalidateNamespaceSchema,
  loadNamespaceSchema,
  resolveNamespacesRoot,
} from "./schemaRegistry.js";
import {
  formatSchemaDocument,
  sameCanonicalTable,
  schemaDocumentProblems,
  viewExposedColumns,
  type SchemaDocument,
  type SchemaTable,
  type SchemaView,
} from "./schemaJson.js";
import {
  assertGenericInferenceAllowed,
  resolveInferenceWindow,
  type InferenceWindowConfig,
  type InferenceWindowState,
} from "./inferenceCompat.js";
import {
  COLUMN_NAME_PATTERN,
  RESOURCE_NAME_PATTERN,
  ROW_SHAPES,
  isDeclaredColumnType,
  isReservedResourceName,
  normalizeDeclaredValue,
  type DeclaredColumn,
  type DeclaredColumnType,
  type RowShape,
} from "./schemaTypes.js";

export const DDL_DIR = ".duckbrain-ddl";
export const GENERATIONS_DIR = "generations";
/** Exit code used by the crash-injection seam (never reached in production). */
export const DDL_CRASH_EXIT_CODE = 97;

export type DdlOperationName =
  | "createTable"
  | "addColumn"
  | "retypeColumn"
  | "declareView"
  | "redeclareView";

export type BackfillPolicy = "null" | "default" | "materialize";

export type DdlJournalStatus =
  | "started"
  | "prepared"
  | "generation-written"
  | "switched"
  | "finalized"
  | "abandoned"
  | "failed"
  | "fail_closed";

export interface DdlJournal {
  operationId: string;
  operation: DdlOperationName;
  ns: string;
  table?: string;
  view?: string;
  status: DdlJournalStatus;
  policy?: BackfillPolicy;
  idempotencyKey?: string;
  requestHash: string;
  request: unknown;
  result?: DdlResult;
  oldSchemaHash: string | null;
  newSchemaHash: string | null;
  oldStoragePath?: string;
  newStoragePath?: string;
  newGenerationSha256?: string;
  detail?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DdlGenerationResult {
  /** Namespace-relative path of the new immutable generation. */
  path: string;
  /** Namespace-relative path that remains live until the switch. */
  previousPath: string;
  sha256: string;
  rows: number;
}

export interface DdlResult {
  ok: true;
  operation: DdlOperationName;
  ns: string;
  table?: string;
  view?: string;
  schemaVersion: number;
  documentHash: string;
  journalPath: string;
  idempotentReplay?: boolean;
  generation?: DdlGenerationResult;
  /** Parent partition added to manifest.json after the switch, if any. */
  partition?: string;
  /** Table declaration as persisted (createTable/addColumn/retypeColumn). */
  table_?: SchemaTable;
  /** View declaration as persisted (declareView/redeclareView). */
  viewDefinition?: SchemaView;
}

export interface InferenceConfirmationRequired {
  ok: false;
  status: "confirmation_required";
  operation: "createTable";
  ns: string;
  table: string;
  /** Canonical inferred declaration awaiting operator confirmation. */
  declaration: SchemaTable;
  sourceFile: string;
  sampleLines: number;
}

export interface DdlCallOptions {
  namespacesPath?: string;
  principal?: AuthPrincipal;
  idempotencyKey?: string;
  scheduleCommit?: (namespacePath: string) => void;
  now?: () => Date;
  /**
   * Durability test seam: hard-exit the process at a migration boundary so a
   * test can prove recovery in a fresh process. Never set in production.
   */
  crashAfter?: "generation-written" | "schema-switched" | "journal-finalized";
  /**
   * Runs while the namespace fence is held and before any write. Embedding
   * hook (metrics / operator pause); the acceptance tests use it to prove
   * cross-process exclusion deterministically.
   */
  onFenceAcquired?: (info: {
    ns: string;
    operation: DdlOperationName;
    operationId: string;
  }) => void | Promise<void>;
  /** Inference-window override (tests / embedders). */
  inferenceWindow?: Partial<InferenceWindowConfig>;
}

export interface CreateTableRequest {
  table: string;
  rowShape: RowShape;
  keyColumns: string[];
  columns: DeclaredColumn[];
  storagePath: string;
  /** Create-only inference from one existing JSONL file. */
  inferFrom?: string;
  /** Must be true to persist an inferred declaration (see AC-8). */
  confirm?: boolean;
}

export interface AddColumnRequest {
  table: string;
  column: DeclaredColumn;
  policy?: BackfillPolicy;
}

export interface RetypeColumnRequest {
  table: string;
  column: string;
  type: DeclaredColumnType;
  policy: BackfillPolicy;
}

export interface ViewRequest {
  view: string;
  dependsOn: string[];
  query: string;
}

// ---------------------------------------------------------------------------
// Authorization (SUPA-4)
// ---------------------------------------------------------------------------

/**
 * DDL requires the `admin` role for the namespace. A missing principal is the
 * `auth.mode = none` local deployment (same compatibility rule the rest of the
 * grant helpers use); an explicit non-admin role list is refused.
 */
export function authorizeDdl(
  principal: AuthPrincipal | undefined,
  ns: string,
): void {
  if (!principal) return;
  const scoped = authorizeResource(principal, ns, "tables.write");
  if (!scoped.allowed) throw new ApiError(scoped.message, 403, "FORBIDDEN");
  if (!hasAnyRole(principal, ["admin"]))
    throw new ApiError(
      `Forbidden: principal '${principal.name}' lacks the 'admin' role required for namespace DDL`,
      403,
      "FORBIDDEN",
    );
}

// ---------------------------------------------------------------------------
// Low-level durability helpers
// ---------------------------------------------------------------------------

function fsyncDir(dir: string): void {
  try {
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Directory fsync is a best-effort barrier on filesystems that refuse it.
  }
}

/** True when this namespace's configured durability mode requires barriers. */
function namespaceDurabilityRequiresFsync(ns: string): boolean {
  try {
    return resolveWriteMode(ns) !== "buffered";
  } catch {
    return false;
  }
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input !== null && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(input as Record<string, unknown>).sort())
        out[key] = sort((input as Record<string, unknown>)[key]);
      return out;
    }
    return input;
  };
  return JSON.stringify(sort(value));
}

function requestHashFor(operation: DdlOperationName, request: unknown): string {
  return sha256(`${operation}\u0000${canonicalJson(request)}`);
}

/**
 * The single reader-visible schema switch: write a same-directory unique temp
 * file, fsync it (and the directory when the namespace's durability mode
 * requires barriers), then rename over `schema.json`. No reader ever observes
 * partial JSON, and the old document stays visible until the rename.
 *
 * The exact text can be supplied so the hash a journal records BEFORE the
 * switch provably equals the hash of what the switch publishes.
 */
export function writeSchemaTextAtomic(
  nsDir: string,
  text: string,
  options: { ns?: string } = {},
): { path: string; hash: string; text: string } {
  const target = path.join(nsDir, SCHEMA_FILE_NAME);
  const durable = options.ns
    ? namespaceDurabilityRequiresFsync(options.ns)
    : true;
  fs.mkdirSync(nsDir, { recursive: true });
  const tmp = path.join(
    nsDir,
    `${SCHEMA_FILE_NAME}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  const fd = fs.openSync(tmp, "w", 0o644);
  try {
    fs.writeSync(fd, text);
    if (durable) fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
  if (durable) fsyncDir(nsDir);
  return { path: target, hash: sha256(text), text };
}

export function writeSchemaAtomic(
  nsDir: string,
  document: SchemaDocument,
  options: { ns?: string } = {},
): { path: string; hash: string; text: string } {
  return writeSchemaTextAtomic(nsDir, formatSchemaDocument(document), options);
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  fsyncDir(path.dirname(file));
}

export function ddlJournalDir(nsDir: string): string {
  return path.join(nsDir, DDL_DIR);
}

export function ddlJournalPath(nsDir: string, operationId: string): string {
  return path.join(ddlJournalDir(nsDir), `${operationId}.json`);
}

/** Every journal on disk, newest last. Corrupt journals are reported, not ignored. */
export function readDdlJournals(nsDir: string): DdlJournal[] {
  const dir = ddlJournalDir(nsDir);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const journals: DdlJournal[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(dir, entry), "utf-8"),
      ) as DdlJournal;
      journals.push(parsed);
    } catch (error) {
      console.warn(
        `[duckbrain] unreadable DDL journal ${path.join(dir, entry)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return journals;
}

function currentSchemaHash(nsDir: string): string | null {
  try {
    return sha256(fs.readFileSync(path.join(nsDir, SCHEMA_FILE_NAME)));
  } catch {
    return null;
  }
}

function maybeCrash(
  stage: NonNullable<DdlCallOptions["crashAfter"]>,
  options: DdlCallOptions,
): void {
  if (options.crashAfter !== stage) return;
  // Durability seam: emulate a process crash exactly at this boundary. The
  // process dies with the fence lock still on disk and the journal
  // unfinalized — the state recovery must classify. Never set in production.
  process.exit(DDL_CRASH_EXIT_CODE);
}

// ---------------------------------------------------------------------------
// Fence
// ---------------------------------------------------------------------------

const FENCE_RETRY_MS = 25;

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire the namespace write lock (the existing cross-process fence),
 * waiting briefly for an in-flight serializer flush to release it.
 */
export async function acquireDdlFence(
  ns: string,
  root: string,
  timeoutMs = 30_000,
): Promise<NamespaceWriteLock> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lock = acquireNamespaceWriteLock(root, ns);
    if (lock) return lock;
    if (Date.now() >= deadline)
      throw new ApiError(
        `namespace '${ns}' is fenced: another writer or DDL operation holds the namespace lock`,
        503,
        "DDL_FENCED",
      );
    await sleep(FENCE_RETRY_MS);
  }
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

export type DdlRecoveryAction = "finalized" | "abandoned" | "fail-closed";

export interface DdlRecoveryOutcome {
  ns: string;
  operationId: string;
  operation: DdlOperationName;
  previousStatus: DdlJournalStatus;
  status: DdlJournalStatus;
  action: DdlRecoveryAction;
  detail: string;
}

function updateJournal(
  nsDir: string,
  journal: DdlJournal,
  patch: Partial<DdlJournal>,
): DdlJournal {
  const next: DdlJournal = {
    ...journal,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(ddlJournalPath(nsDir, journal.operationId), next);
  return next;
}

function removeFileIfPresent(file: string): boolean {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * The live schema document, parsed leniently — recovery must never throw on a
 * schema it is trying to classify.
 */
function currentSchemaDocument(nsDir: string): SchemaDocument | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(nsDir, SCHEMA_FILE_NAME), "utf-8"),
    ) as SchemaDocument;
  } catch {
    return null;
  }
}

/**
 * Generation files under `tables/<table>/generations/` that no live
 * declaration references. By definition those are unpublished: only
 * `schema.json` publishes a generation path.
 */
function unreferencedGenerations(
  nsDir: string,
  table: string,
  livePaths: Set<string>,
): string[] {
  const dir = path.join(nsDir, "tables", table, GENERATIONS_DIR);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(".jsonl"))
    .map((entry) => `tables/${table}/${GENERATIONS_DIR}/${entry}`)
    .filter((relative) => !livePaths.has(relative));
}

/** Remove stale temp files an interrupted process left behind. */
function removeStaleTemps(nsDir: string): void {
  const patterns = [SCHEMA_FILE_NAME, ""];
  for (const pattern of patterns) {
    const dir = pattern === "" ? ddlJournalDir(nsDir) : nsDir;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".tmp")) continue;
      if (pattern !== "" && !entry.startsWith(`${SCHEMA_FILE_NAME}.`)) continue;
      removeFileIfPresent(path.join(dir, entry));
    }
  }
}

function recoverLocked(
  ns: string,
  nsDir: string,
  options: DdlCallOptions,
): DdlRecoveryOutcome[] {
  const outcomes: DdlRecoveryOutcome[] = [];
  const liveHash = currentSchemaHash(nsDir);
  for (const journal of readDdlJournals(nsDir)) {
    if (
      journal.status === "finalized" ||
      journal.status === "abandoned" ||
      journal.status === "failed" ||
      journal.status === "fail_closed"
    )
      continue;

    const matchesNew =
      journal.newSchemaHash !== null && liveHash === journal.newSchemaHash;
    const matchesOld =
      journal.oldSchemaHash === null
        ? liveHash === null
        : liveHash === journal.oldSchemaHash;

    if (matchesNew) {
      // Post-switch: the schema already points at the new state. When the
      // operation published an immutable generation, verify its path and
      // digest; then finalize. Never roll back — that would be a second,
      // ambiguous switch.
      const publishesGeneration =
        journal.newStoragePath !== undefined ||
        journal.newGenerationSha256 !== undefined;
      const generationAbs = journal.newStoragePath
        ? path.join(nsDir, journal.newStoragePath)
        : null;
      if (
        publishesGeneration &&
        (!generationAbs || !fs.existsSync(generationAbs))
      ) {
        const failed = updateJournal(nsDir, journal, {
          status: "fail_closed",
          detail: `post-switch recovery: generation '${journal.newStoragePath ?? "<none>"}' is missing`,
        });
        outcomes.push({
          ns,
          operationId: failed.operationId,
          operation: failed.operation,
          previousStatus: journal.status,
          status: failed.status,
          action: "fail-closed",
          detail: failed.detail ?? "",
        });
        continue;
      }
      if (generationAbs) {
        const digest = sha256(fs.readFileSync(generationAbs));
        if (
          journal.newGenerationSha256 &&
          digest !== journal.newGenerationSha256
        ) {
          const failed = updateJournal(nsDir, journal, {
            status: "fail_closed",
            detail: `post-switch recovery: generation digest ${digest} does not match journaled ${journal.newGenerationSha256}`,
          });
          outcomes.push({
            ns,
            operationId: failed.operationId,
            operation: failed.operation,
            previousStatus: journal.status,
            status: failed.status,
            action: "fail-closed",
            detail: failed.detail ?? "",
          });
          continue;
        }
      }
      const finalized = updateJournal(nsDir, journal, {
        status: "finalized",
        detail: publishesGeneration
          ? "post-switch recovery verified the immutable generation and finalized"
          : "post-switch recovery verified the published schema and finalized",
      });
      options.scheduleCommit?.(nsDir);
      outcomes.push({
        ns,
        operationId: finalized.operationId,
        operation: finalized.operation,
        previousStatus: journal.status,
        status: finalized.status,
        action: "finalized",
        detail: finalized.detail ?? "",
      });
      continue;
    }

    if (matchesOld) {
      // Pre-switch: the live schema is still the old one. Only the
      // UNPUBLISHED generation may be removed — never the live one.
      const liveDocument = currentSchemaDocument(nsDir);
      const livePaths = new Set(
        Object.values(liveDocument?.tables ?? {}).map(
          (table) => table.storage.path,
        ),
      );
      const candidates = new Set<string>();
      if (journal.newStoragePath) candidates.add(journal.newStoragePath);
      // A crash before the journal recorded the generation path is still
      // recoverable: any generation file this namespace does not reference is
      // by definition unpublished.
      if (journal.table) {
        for (const unreferenced of unreferencedGenerations(
          nsDir,
          journal.table,
          livePaths,
        ))
          candidates.add(unreferenced);
      }
      const removed: string[] = [];
      for (const candidate of candidates) {
        const abs = path.join(nsDir, candidate);
        if (livePaths.has(candidate)) continue;
        if (!fs.existsSync(abs)) continue;
        if (removeFileIfPresent(abs)) removed.push(candidate);
      }
      const detail =
        removed.length > 0
          ? `pre-switch recovery removed the unpublished generation(s) ${removed.join(", ")}`
          : "pre-switch recovery: no unpublished generation present";
      const abandoned = updateJournal(nsDir, journal, {
        status: "abandoned",
        detail,
      });
      outcomes.push({
        ns,
        operationId: abandoned.operationId,
        operation: abandoned.operation,
        previousStatus: journal.status,
        status: abandoned.status,
        action: "abandoned",
        detail,
      });
      continue;
    }

    const failed = updateJournal(nsDir, journal, {
      status: "fail_closed",
      detail: `recovery evidence mismatch: live schema hash ${liveHash ?? "<absent>"} matches neither the journaled old hash ${journal.oldSchemaHash ?? "<absent>"} nor the new hash ${journal.newSchemaHash ?? "<absent>"}`,
    });
    outcomes.push({
      ns,
      operationId: failed.operationId,
      operation: failed.operation,
      previousStatus: journal.status,
      status: failed.status,
      action: "fail-closed",
      detail: failed.detail ?? "",
    });
  }
  removeStaleTemps(nsDir);
  return outcomes;
}

/**
 * Recover an interrupted DDL operation. Acquires the namespace fence first, so
 * it never races a live operation (a live fenced operation yields
 * `503 DDL_FENCED`).
 */
export async function recoverNamespaceDdl(
  ns: string,
  options: DdlCallOptions = {},
): Promise<DdlRecoveryOutcome[]> {
  const root = resolveNamespacesRoot(options.namespacesPath);
  const nsDir = path.join(root, ns);
  if (!fs.existsSync(nsDir)) return [];
  const fence = await acquireDdlFence(ns, root, 5_000);
  try {
    const outcomes = recoverLocked(ns, nsDir, options);
    if (outcomes.length > 0) {
      invalidateNamespaceSchema(ns);
      loadNamespaceSchema(ns, {
        namespacesPath: options.namespacesPath,
        force: true,
      });
    }
    return outcomes;
  } finally {
    releaseNamespaceWriteLock(fence);
  }
}

/** True when an interrupted operation left unrecoverable evidence. */
export function namespaceDdlFailClosed(
  ns: string,
  options: DdlCallOptions = {},
): boolean {
  const nsDir = path.join(resolveNamespacesRoot(options.namespacesPath), ns);
  return readDdlJournals(nsDir).some(
    (journal) => journal.status === "fail_closed",
  );
}

/**
 * Gate for NEW generic-table operations: while an operation is fail-closed
 * (evidence for the visibility switch is missing) new generic work is
 * refused rather than guessed. Reads of already-validated generations stay
 * available — only work that would write or introduce new declarations is
 * refused.
 */
export function assertNamespaceDdlUsable(
  ns: string,
  options: DdlCallOptions = {},
): void {
  if (!namespaceDdlFailClosed(ns, options)) return;
  throw new ApiError(
    `namespace '${ns}' has a failed DDL recovery: generic table operations are refused until an operator resolves the journal under ${DDL_DIR}`,
    503,
    "DDL_RECOVERY_REQUIRED",
  );
}

// ---------------------------------------------------------------------------
// Inference (bounded, create-only)
// ---------------------------------------------------------------------------

export interface InferenceOutcome {
  declaration: SchemaTable;
  sourceFile: string;
  sampleLines: number;
  window: InferenceWindowState;
}

const MAX_INFERENCE_LINES = 1000;
const MAX_INFERENCE_COLUMNS = 64;

function safeRelativeJsonlPath(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new ApiError(
      `${field} must be a non-empty path`,
      400,
      "VALIDATION_ERROR",
    );
  if (value.startsWith("/") || path.isAbsolute(value) || value.includes(".."))
    throw new ApiError(
      `${field} must be a namespace-relative path without '..'`,
      400,
      "VALIDATION_ERROR",
    );
  if (!value.endsWith(".jsonl"))
    throw new ApiError(
      `${field} must end in '.jsonl'`,
      400,
      "VALIDATION_ERROR",
    );
  return value;
}

function inferColumnType(values: unknown[]): DeclaredColumnType | null {
  const kinds = new Set<DeclaredColumnType>();
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string") {
      kinds.add("string");
      continue;
    }
    if (typeof value === "boolean") {
      kinds.add("boolean");
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) && Number.isInteger(value))
        throw new ApiError(
          "inference found a JSON integer beyond the JavaScript safe-integer range; declare the column explicitly as int64 and store canonical decimal strings",
          400,
          "INFERENCE_AMBIGUOUS",
        );
      kinds.add("float64");
      continue;
    }
    if (typeof value === "object") {
      kinds.add("json");
      continue;
    }
    throw new ApiError(
      `inference found a value of type ${typeof value} that no declared v1 type represents`,
      400,
      "INFERENCE_AMBIGUOUS",
    );
  }
  if (kinds.size === 0) return null; // all-null column: no type evidence
  if (kinds.size > 1)
    // A column whose rows disagree on the JSON kind cannot be declared
    // faithfully (any single choice would coerce or silently null the others).
    throw new ApiError(
      `inference found mixed JSON kinds (${[...kinds].sort().join(", ")}) in one column; declare the table explicitly`,
      400,
      "INFERENCE_AMBIGUOUS",
    );
  return [...kinds][0]!;
}

/**
 * Infer a table declaration from ONE existing JSONL file, bounded to
 * `MAX_INFERENCE_LINES` lines and `MAX_INFERENCE_COLUMNS` columns.
 *
 * Deliberately literal: JSON strings map to `string`, booleans to `boolean`,
 * numbers to `float64` (a JSON number cannot satisfy the canonical `int64`
 * string representation, and coercing it would violate the no-coercion rule),
 * objects/arrays to `json`, null-only columns to nullable `json`. Mixed or
 * unrepresentable columns are rejected rather than guessed.
 */
export function inferDeclarationFromJsonl(
  nsDir: string,
  relativePath: string,
  options: {
    table: string;
    keyColumns?: string[];
    now?: Date;
    window?: Partial<InferenceWindowConfig>;
    ns: string;
  },
): InferenceOutcome {
  const sourceFile = safeRelativeJsonlPath(relativePath, "inferFrom");
  const abs = path.join(nsDir, sourceFile);
  if (!fs.existsSync(abs))
    throw new ApiError(
      `inferFrom path '${sourceFile}' does not exist in the namespace`,
      400,
      "VALIDATION_ERROR",
    );
  const window = resolveInferenceWindow(
    options.window,
    options.now ?? new Date(),
  );
  assertGenericInferenceAllowed(options.ns, sourceFile, {
    now: options.now,
    window: options.window,
    detail: `create-only inference for table '${options.table}'`,
  });

  const rawLines = fs
    .readFileSync(abs, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(0, MAX_INFERENCE_LINES);
  if (rawLines.length === 0)
    throw new ApiError(
      `inferFrom path '${sourceFile}' has no data lines to infer from`,
      400,
      "VALIDATION_ERROR",
    );

  const parsedLines: unknown[] = [];
  for (const [index, line] of rawLines.entries()) {
    try {
      parsedLines.push(JSON.parse(line));
    } catch (error) {
      throw new ApiError(
        `inferFrom path '${sourceFile}' line ${index + 1} is not valid JSON (malformed JSONL is never repaired): ${
          error instanceof Error ? error.message : String(error)
        }`,
        400,
        "VALIDATION_ERROR",
      );
    }
  }

  const allArrays = parsedLines.every((line) => Array.isArray(line));
  const allObjects = parsedLines.every(
    (line) => typeof line === "object" && line !== null && !Array.isArray(line),
  );
  if (!allArrays && !allObjects)
    throw new ApiError(
      `inferFrom path '${sourceFile}' mixes positional (array) and object rows; declare the table explicitly`,
      400,
      "INFERENCE_AMBIGUOUS",
    );

  let columns: DeclaredColumn[];
  if (allObjects) {
    const names: string[] = [];
    for (const line of parsedLines) {
      for (const key of Object.keys(line as Record<string, unknown>)) {
        if (!names.includes(key)) names.push(key);
      }
    }
    if (names.length > MAX_INFERENCE_COLUMNS)
      throw new ApiError(
        `inferFrom found ${names.length} columns (bound: ${MAX_INFERENCE_COLUMNS}); declare the table explicitly`,
        400,
        "INFERENCE_AMBIGUOUS",
      );
    columns = names.map((name) => {
      const values = parsedLines.map(
        (line) => (line as Record<string, unknown>)[name] ?? null,
      );
      const type = inferColumnType(values);
      if (type === null)
        return { name, type: "json" as DeclaredColumnType, nullable: true };
      const present = values.filter((value) => value !== null).length;
      return { name, type, nullable: present < values.length };
    });
  } else {
    const width = Math.max(
      ...parsedLines.map((line) => (line as unknown[]).length),
    );
    if (width > MAX_INFERENCE_COLUMNS)
      throw new ApiError(
        `inferFrom found ${width} positional columns (bound: ${MAX_INFERENCE_COLUMNS}); declare the table explicitly`,
        400,
        "INFERENCE_AMBIGUOUS",
      );
    columns = Array.from({ length: width }, (_unused, index) => {
      const values = parsedLines.map(
        (line) => (line as unknown[])[index] ?? null,
      );
      const type = inferColumnType(values);
      const present = values.filter((value) => value !== null).length;
      if (type === null)
        return {
          name: `column_${index + 1}`,
          type: "json" as DeclaredColumnType,
          nullable: true,
        };
      return {
        name: `column_${index + 1}`,
        type,
        nullable: present < values.length,
      };
    });
  }

  const keyColumns =
    options.keyColumns && options.keyColumns.length > 0
      ? options.keyColumns
      : columns.some((column) => column.name === "id")
        ? ["id"]
        : [];
  if (keyColumns.length === 0)
    throw new ApiError(
      "createTable with inferFrom requires explicit keyColumns (no stable key column could be inferred): a declared table needs non-nullable key column(s)",
      400,
      "KEY_COLUMNS_REQUIRED",
    );

  return {
    declaration: {
      schemaVersion: 1,
      storage: { path: sourceFile },
      rowShape: allObjects ? "object" : "positional",
      keyColumns,
      columns,
    },
    sourceFile,
    sampleLines: parsedLines.length,
    window,
  };
}

// ---------------------------------------------------------------------------
// Shared operation machinery
// ---------------------------------------------------------------------------

interface OperationContext {
  ns: string;
  nsDir: string;
  root: string;
  document: SchemaDocument;
  options: DdlCallOptions;
  operationId: string;
  journal: DdlJournal;
  journalFile: string;
}

interface OperationWork {
  nextDocument: SchemaDocument;
  result: Partial<DdlResult>;
}

interface OperationHooks {
  operation: DdlOperationName;
  table?: string;
  view?: string;
  request: unknown;
  policy?: BackfillPolicy;
  /** Runs before the fence (cheap read-only validation / inference). */
  preflight?: () => void;
  work: (ctx: OperationContext) => Promise<OperationWork> | OperationWork;
}

function validateResourceName(kind: "table" | "view", name: unknown): string {
  if (typeof name !== "string" || name.length === 0)
    throw new ApiError(`${kind} name is required`, 400, "VALIDATION_ERROR");
  if (isReservedResourceName(name))
    throw new ApiError(
      `'${name}' is a reserved resource name`,
      409,
      "RESERVED_RESOURCE",
    );
  if (!RESOURCE_NAME_PATTERN.test(name))
    throw new ApiError(
      `${kind} name '${name}' must match ${RESOURCE_NAME_PATTERN.source}`,
      400,
      "VALIDATION_ERROR",
    );
  return name;
}

function validateColumnShape(column: DeclaredColumn): DeclaredColumn {
  if (typeof column !== "object" || column === null)
    throw new ApiError("column must be an object", 400, "VALIDATION_ERROR");
  if (!COLUMN_NAME_PATTERN.test(column.name))
    throw new ApiError(
      `column name ${JSON.stringify(column.name)} is not a valid identifier`,
      400,
      "VALIDATION_ERROR",
    );
  if (!isDeclaredColumnType(column.type))
    throw new ApiError(
      `column '${column.name}' has unsupported type ${JSON.stringify(column.type)}; declared v1 types are string|int64|float64|boolean|timestamp|json|bytes`,
      400,
      "VALIDATION_ERROR",
    );
  if (typeof column.nullable !== "boolean")
    throw new ApiError(
      `column '${column.name}' requires an explicit nullable flag`,
      400,
      "VALIDATION_ERROR",
    );
  return column;
}

function assertDocumentValid(document: SchemaDocument, where: string): void {
  const problems = schemaDocumentProblems(document);
  if (problems.length > 0)
    throw new ApiError(
      `${where}: ${problems.join("; ")}`,
      400,
      "VALIDATION_ERROR",
    );
}

function generationPathFor(table: string, operationId: string): string {
  return `tables/${table}/${GENERATIONS_DIR}/${operationId}.jsonl`;
}

/**
 * Partition index entry for a table path, when (and only when) it conforms to
 * the storage partition layout `<domain>/<YYYY-MM>/<file>.jsonl`.
 */
export function partitionForStoragePath(storagePath: string): string | null {
  const segments = storagePath
    .split("/")
    .filter((segment) => segment.length > 0);
  if (segments.length !== 3) return null;
  const [domain, partition, file] = segments as [string, string, string];
  if (!/^[a-z0-9_-]+$/.test(domain)) return null;
  if (!/^\d{4}-\d{2}$/.test(partition)) return null;
  if (!file.endsWith(".jsonl")) return null;
  return `${domain}/${partition}/`;
}

function addManifestPartitionIfConforming(
  nsDir: string,
  storagePath: string,
): string | null {
  const partition = partitionForStoragePath(storagePath);
  if (!partition) return null;
  if (!fs.existsSync(path.join(nsDir, storagePath))) return null;
  addPartition(nsDir, partition);
  return partition;
}

async function runOperation(
  ns: string,
  hooks: OperationHooks,
  options: DdlCallOptions,
): Promise<DdlResult> {
  const root = resolveNamespacesRoot(options.namespacesPath);
  const nsDir = path.join(root, ns);
  authorizeDdl(options.principal, ns);
  hooks.preflight?.();
  assertNamespaceSchemaUsable(ns, { namespacesPath: options.namespacesPath });

  const requestHash = requestHashFor(hooks.operation, hooks.request);
  const fence = await acquireDdlFence(ns, root);
  const operationId = `${hooks.operation}-${Date.now().toString(36)}-${crypto
    .randomBytes(4)
    .toString("hex")}`;
  try {
    if (!fs.existsSync(nsDir)) fs.mkdirSync(nsDir, { recursive: true });
    recoverLocked(ns, nsDir, options);

    // Idempotency AFTER recovery, so a completed retry is recognized even
    // when the original process died between the switch and finalization.
    if (options.idempotencyKey) {
      const existing = readDdlJournals(nsDir).find(
        (journal) => journal.idempotencyKey === options.idempotencyKey,
      );
      if (existing) {
        if (existing.requestHash !== requestHash)
          throw new ApiError(
            `Idempotency-Key '${options.idempotencyKey}' was already used for a different ${existing.operation} request`,
            409,
            "IDEMPOTENCY_CONFLICT",
          );
        if (existing.status === "finalized" || existing.status === "switched") {
          if (!existing.result)
            throw new ApiError(
              `Idempotency-Key '${options.idempotencyKey}' replay has no recorded result`,
              500,
              "IDEMPOTENCY_REPLAY_INCOMPLETE",
            );
          return {
            ...existing.result,
            idempotentReplay: true,
            journalPath: ddlJournalPath(nsDir, existing.operationId),
          };
        }
        if (existing.status === "fail_closed")
          throw new ApiError(
            `Idempotency-Key '${options.idempotencyKey}' maps to a fail-closed operation; an operator must resolve it`,
            503,
            "DDL_RECOVERY_REQUIRED",
          );
      }
    }

    const loaded = loadNamespaceSchema(ns, {
      namespacesPath: options.namespacesPath,
      force: true,
    });
    const journalFile = ddlJournalPath(nsDir, operationId);
    let journal: DdlJournal = {
      operationId,
      operation: hooks.operation,
      ns,
      ...(hooks.table ? { table: hooks.table } : {}),
      ...(hooks.view ? { view: hooks.view } : {}),
      ...(hooks.policy ? { policy: hooks.policy } : {}),
      ...(options.idempotencyKey
        ? { idempotencyKey: options.idempotencyKey }
        : {}),
      status: "started",
      requestHash,
      request: hooks.request,
      oldSchemaHash: loaded.present ? loaded.hash : null,
      newSchemaHash: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeJsonAtomic(journalFile, journal);

    await options.onFenceAcquired?.({
      ns,
      operation: hooks.operation,
      operationId,
    });

    const ctx: OperationContext = {
      ns,
      nsDir,
      root,
      document: loaded.document,
      options,
      operationId,
      journal,
      journalFile,
    };
    let switched = false;
    try {
      const work = await hooks.work(ctx);
      // The candidate document is validated BEFORE anything is written, so an
      // invalid evolution cannot leave an unpublished generation behind.
      assertDocumentValid(work.nextDocument, `DDL ${hooks.operation} rejected`);

      const candidateText = formatSchemaDocument(work.nextDocument);
      const candidateHash = sha256(candidateText);

      journal = updateJournal(nsDir, journal, {
        ...(work.result.generation
          ? {
              newStoragePath: work.result.generation.path,
              newGenerationSha256: work.result.generation.sha256,
            }
          : {}),
        // The hash this operation INTENDS to publish is journaled BEFORE the
        // switch, so a crash between the rename and the journal update is still
        // classifiable (post-switch by hash) on recovery.
        newSchemaHash: candidateHash,
        status: work.result.generation ? "generation-written" : "prepared",
      });
      maybeCrash("generation-written", options);

      const switchedSchema = writeSchemaTextAtomic(nsDir, candidateText, {
        ns,
      });
      switched = true;
      maybeCrash("schema-switched", options);
      journal = updateJournal(nsDir, journal, {
        status: "switched",
        newSchemaHash: switchedSchema.hash,
      });

      // Post-switch bookkeeping only: manifest gains the parent partition when
      // the new path conforms to the storage layout, and one namespace commit
      // is scheduled. Neither is a reader-visible switch.
      let partition: string | undefined;
      const postSwitchPath =
        work.result.generation?.path ?? work.result.table_?.storage.path;
      if (postSwitchPath) {
        const added = addManifestPartitionIfConforming(nsDir, postSwitchPath);
        if (added) partition = added;
      }

      const result: DdlResult = {
        ok: true,
        operation: hooks.operation,
        ns,
        ...(hooks.table ? { table: hooks.table } : {}),
        ...(hooks.view ? { view: hooks.view } : {}),
        schemaVersion: work.result.schemaVersion ?? 1,
        documentHash: switchedSchema.hash,
        journalPath: journalFile,
        ...(work.result.idempotentReplay ? { idempotentReplay: true } : {}),
        ...(work.result.generation
          ? { generation: work.result.generation }
          : {}),
        ...(partition ? { partition } : {}),
        ...(work.result.table_ ? { table_: work.result.table_ } : {}),
        ...(work.result.viewDefinition
          ? { viewDefinition: work.result.viewDefinition }
          : {}),
      };

      journal = updateJournal(nsDir, journal, {
        status: "finalized",
        result,
        newSchemaHash: switchedSchema.hash,
        detail: "schema switch committed",
      });
      maybeCrash("journal-finalized", options);
      (options.scheduleCommit ?? commitNamespace)(nsDir);
      return result;
    } catch (error) {
      // A failure BEFORE the visibility switch leaves old schema, old path and
      // old data live; mark the journal failed instead of leaving it dangling.
      if (!switched) {
        try {
          updateJournal(nsDir, journal, {
            status: "failed",
            detail: `${
              error instanceof Error ? error.message : String(error)
            } (no schema switch happened: previous schema and generation remain live)`,
          });
        } catch {
          // Best effort: the original failure is what matters.
        }
      }
      throw error;
    }
  } finally {
    releaseNamespaceWriteLock(fence);
    // Drop the cached document so the next read/write in ANY surface sees the
    // new declaration (a new file identity also invalidates it; this makes the
    // in-process transition immediate and explicit).
    invalidateNamespaceSchema(ns);
    loadNamespaceSchema(ns, {
      namespacesPath: options.namespacesPath,
      force: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Generation materialization
// ---------------------------------------------------------------------------

const RETYPE_ALLOWED: ReadonlyArray<`${DeclaredColumnType}->${DeclaredColumnType}`> =
  ["int64->float64", "string->json", "string->timestamp"];

export function retypeAllowed(
  from: DeclaredColumnType,
  to: DeclaredColumnType,
): boolean {
  return (RETYPE_ALLOWED as readonly string[]).includes(`${from}->${to}`);
}

function retypeValue(
  from: DeclaredColumnType,
  to: DeclaredColumnType,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (value === null) return { ok: true, value: null };
  if (from === "int64" && to === "float64") {
    const text = String(value);
    const parsed = Number(text);
    if (!Number.isFinite(parsed))
      return { ok: false, reason: `'${text}' is not a finite number` };
    if (!Number.isSafeInteger(parsed) && Number.isInteger(parsed))
      return {
        ok: false,
        reason: `'${text}' does not survive a lossless conversion to float64`,
      };
    return { ok: true, value: parsed === 0 ? 0 : parsed };
  }
  if (from === "string" && to === "json") {
    try {
      return { ok: true, value: JSON.parse(String(value)) };
    } catch (error) {
      return {
        ok: false,
        reason: `not parseable as JSON (${error instanceof Error ? error.message : String(error)})`,
      };
    }
  }
  if (from === "string" && to === "timestamp") {
    try {
      return {
        ok: true,
        value: normalizeDeclaredValue(
          { name: "conversion", type: "timestamp", nullable: false },
          value,
        ),
      };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return {
    ok: false,
    reason: `conversion ${from} -> ${to} is not permitted in v1`,
  };
}

interface GenerationRow {
  values: Record<string, unknown>;
}

function readRowsForGeneration(
  nsDir: string,
  table: SchemaTable,
  storagePath: string,
): { rows: GenerationRow[]; problem: string | null } {
  const abs = path.join(nsDir, storagePath);
  if (!fs.existsSync(abs)) return { rows: [], problem: null };
  const lines = fs
    .readFileSync(abs, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const rows: GenerationRow[] = [];
  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      return {
        rows: [],
        problem: `line ${index + 1} of '${storagePath}' is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      };
    }
    if (table.rowShape === "positional") {
      if (!Array.isArray(parsed))
        return {
          rows: [],
          problem: `line ${index + 1} of '${storagePath}' is not a positional array row`,
        };
      const values: Record<string, unknown> = {};
      table.columns.forEach((column, ordinal) => {
        values[column.name] = ordinal < parsed.length ? parsed[ordinal] : null;
      });
      rows.push({ values });
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return {
        rows: [],
        problem: `line ${index + 1} of '${storagePath}' is not an object row`,
      };
    const values: Record<string, unknown> = {};
    for (const column of table.columns)
      values[column.name] = Object.prototype.hasOwnProperty.call(
        parsed,
        column.name,
      )
        ? (parsed as Record<string, unknown>)[column.name]
        : null;
    rows.push({ values });
  }
  return { rows, problem: null };
}

function validateGenerationRows(
  next: SchemaTable,
  rows: GenerationRow[],
): string | null {
  const seenKeys = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const canonical: Record<string, unknown> = {};
    for (const column of next.columns) {
      const value = row.values[column.name];
      if (value === undefined || value === null) {
        if (!column.nullable && column.default === undefined)
          return `row ${index + 1} has no value for required column '${column.name}'`;
        canonical[column.name] = column.default ?? null;
        continue;
      }
      try {
        canonical[column.name] = normalizeDeclaredValue(column, value);
      } catch (error) {
        return `row ${index + 1} column '${column.name}': ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
    const key = next.keyColumns
      .map((column) => JSON.stringify(canonical[column] ?? null))
      .join("\u0000");
    if (seenKeys.has(key))
      return `duplicate key ${next.keyColumns.map((column) => `${column}=${JSON.stringify(canonical[column] ?? null)}`).join(", ")} in the migrated generation`;
    seenKeys.add(key);
    row.values = canonical;
  }
  return null;
}

function generationLines(next: SchemaTable, rows: GenerationRow[]): string[] {
  return rows.map((row) =>
    next.rowShape === "positional"
      ? JSON.stringify(
          next.columns.map((column) => row.values[column.name] ?? null),
        )
      : JSON.stringify(
          Object.fromEntries(
            next.columns.map((column) => [
              column.name,
              row.values[column.name] ?? null,
            ]),
          ),
        ),
  );
}

interface MaterializeOutcome {
  generation: DdlGenerationResult;
}

function materializeGeneration(
  ctx: OperationContext,
  tableName: string,
  previous: SchemaTable,
  next: SchemaTable,
): MaterializeOutcome {
  const { rows, problem } = readRowsForGeneration(
    ctx.nsDir,
    previous,
    previous.storage.path,
  );
  if (problem)
    throw new ApiError(
      `materialized migration aborted before any write: ${problem}`,
      400,
      "CONVERSION_FAILED",
    );

  const validationProblem = validateGenerationRows(next, rows);
  if (validationProblem)
    throw new ApiError(
      `materialized migration aborted before any write: ${validationProblem}`,
      400,
      "CONVERSION_FAILED",
    );

  return materializeConvertedRows(ctx, tableName, previous, next, rows);
}

// ---------------------------------------------------------------------------
// createTable
// ---------------------------------------------------------------------------

function tableEntry(
  request: {
    rowShape: RowShape;
    keyColumns: string[];
    columns: DeclaredColumn[];
    storagePath: string;
  },
  schemaVersion = 1,
): SchemaTable {
  return {
    schemaVersion,
    storage: { path: request.storagePath },
    rowShape: request.rowShape,
    keyColumns: [...request.keyColumns],
    columns: request.columns.map((column) => ({ ...column })),
  };
}

export async function createTable(
  ns: string,
  request: CreateTableRequest,
  options: DdlCallOptions = {},
): Promise<DdlResult | InferenceConfirmationRequired> {
  const root = resolveNamespacesRoot(options.namespacesPath);
  const nsDir = path.join(root, ns);
  const table = validateResourceName("table", request.table);

  // ---- create-only inference (bounded compatibility window) --------------
  if (request.inferFrom !== undefined) {
    if (request.columns && request.columns.length > 0)
      throw new ApiError(
        "createTable accepts either explicit columns or inferFrom, never both",
        400,
        "VALIDATION_ERROR",
      );
    const inferred = inferDeclarationFromJsonl(nsDir, request.inferFrom, {
      table,
      keyColumns: request.keyColumns,
      now: options.now?.() ?? new Date(),
      window: options.inferenceWindow,
      ns,
    });
    if (request.confirm !== true) {
      return {
        ok: false,
        status: "confirmation_required",
        operation: "createTable",
        ns,
        table,
        declaration: inferred.declaration,
        sourceFile: inferred.sourceFile,
        sampleLines: inferred.sampleLines,
      };
    }
    return createDeclaredTable(ns, table, inferred.declaration, options);
  }

  if (!isRowShapeSafe(request.rowShape))
    throw new ApiError(
      `rowShape must be one of ${ROW_SHAPES.join("|")}`,
      400,
      "VALIDATION_ERROR",
    );
  if (!Array.isArray(request.keyColumns) || request.keyColumns.length === 0)
    throw new ApiError(
      "keyColumns must be a non-empty array (a table without a stable key is outside this v1 DDL surface)",
      400,
      "VALIDATION_ERROR",
    );
  if (!Array.isArray(request.columns) || request.columns.length === 0)
    throw new ApiError(
      "columns must be a non-empty array",
      400,
      "VALIDATION_ERROR",
    );
  const candidate = tableEntry({
    rowShape: request.rowShape,
    keyColumns: request.keyColumns,
    columns: request.columns.map(validateColumnShape),
    storagePath: safeRelativeJsonlPath(request.storagePath, "storagePath"),
  });
  return createDeclaredTable(ns, table, candidate, options);
}

/**
 * Persist one fully-formed v1 table declaration. Idempotent for a
 * byte-equivalent-after-canonicalization re-request; any different contract
 * for an existing name is `409 TABLE_ALREADY_DECLARED`. Creates no data row.
 */
async function createDeclaredTable(
  ns: string,
  table: string,
  candidate: SchemaTable,
  options: DdlCallOptions,
): Promise<DdlResult> {
  return runOperation(
    ns,
    {
      operation: "createTable",
      table,
      request: {
        table,
        rowShape: candidate.rowShape,
        keyColumns: candidate.keyColumns,
        columns: candidate.columns,
        storagePath: candidate.storage.path,
      },
      work: (ctx) => {
        const existing = ctx.document.tables[table];
        if (existing) {
          if (sameCanonicalTable(existing, candidate))
            return {
              nextDocument: ctx.document,
              result: {
                schemaVersion: existing.schemaVersion,
                table_: existing,
                idempotentReplay: true,
              },
            };
          throw new ApiError(
            `table '${table}' is already declared with a different contract; choose an explicit evolution operation`,
            409,
            "TABLE_ALREADY_DECLARED",
          );
        }
        const nextDocument: SchemaDocument = {
          ...ctx.document,
          tables: { ...ctx.document.tables, [table]: candidate },
        };
        return {
          nextDocument,
          result: { schemaVersion: candidate.schemaVersion, table_: candidate },
        };
      },
    },
    options,
  );
}

function isRowShapeSafe(value: unknown): value is RowShape {
  return (
    typeof value === "string" &&
    (ROW_SHAPES as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// addColumn / retypeColumn
// ---------------------------------------------------------------------------

function resolveBackfillPolicy(
  column: DeclaredColumn,
  requested: BackfillPolicy | undefined,
): BackfillPolicy {
  if (requested === "materialize") {
    if (!column.nullable && column.default === undefined)
      throw new ApiError(
        `addColumn '${column.name}' cannot be materialized without a default: a required column needs a value for every existing row`,
        400,
        "BACKFILL_POLICY_REQUIRED",
      );
    return "materialize";
  }
  if (requested === "default") {
    if (column.default === undefined)
      throw new ApiError(
        `addColumn '${column.name}' requested the 'default' policy without a declared default`,
        400,
        "BACKFILL_POLICY_REQUIRED",
      );
    return "default";
  }
  if (requested === "null") {
    if (!column.nullable)
      throw new ApiError(
        `addColumn '${column.name}' requested the 'null' policy on a non-nullable column`,
        400,
        "VALIDATION_ERROR",
      );
    return "null";
  }
  if (column.default !== undefined) return "default";
  if (column.nullable) return "null";
  throw new ApiError(
    `addColumn '${column.name}' requires a backfill policy: a required column without a default cannot be added logically (use a default, or declare it nullable, or request 'materialize' with a default)`,
    400,
    "BACKFILL_POLICY_REQUIRED",
  );
}

export async function addColumn(
  ns: string,
  request: AddColumnRequest,
  options: DdlCallOptions = {},
): Promise<DdlResult> {
  const table = validateResourceName("table", request.table);
  const column = validateColumnShape(request.column);
  const policy = resolveBackfillPolicy(column, request.policy);
  return runOperation(
    ns,
    {
      operation: "addColumn",
      table,
      policy,
      request: { table, column, policy },
      work: (ctx) => {
        const existing = ctx.document.tables[table];
        if (!existing)
          throw new ApiError(
            `table '${table}' is not declared`,
            404,
            "TABLE_NOT_FOUND",
          );
        if (
          existing.columns.some((candidate) => candidate.name === column.name)
        )
          throw new ApiError(
            `column '${column.name}' already exists on table '${table}'`,
            409,
            "COLUMN_ALREADY_DECLARED",
          );
        const nextTable: SchemaTable = {
          ...existing,
          schemaVersion: existing.schemaVersion + 1,
          columns: [...existing.columns, column],
        };
        const nextDocument: SchemaDocument = {
          ...ctx.document,
          tables: { ...ctx.document.tables, [table]: nextTable },
        };
        assertDocumentValid(
          nextDocument,
          `addColumn '${column.name}' rejected`,
        );

        if (policy !== "materialize")
          return {
            nextDocument,
            result: {
              schemaVersion: nextTable.schemaVersion,
              table_: nextTable,
            },
          };

        const { generation } = materializeGeneration(
          ctx,
          table,
          existing,
          nextTable,
        );
        const switchedTable: SchemaTable = {
          ...nextTable,
          storage: { path: generation.path },
        };
        return {
          nextDocument: {
            ...ctx.document,
            tables: { ...ctx.document.tables, [table]: switchedTable },
          },
          result: {
            schemaVersion: switchedTable.schemaVersion,
            table_: switchedTable,
            generation,
          },
        };
      },
    },
    options,
  );
}

export async function retypeColumn(
  ns: string,
  request: RetypeColumnRequest,
  options: DdlCallOptions = {},
): Promise<DdlResult> {
  const table = validateResourceName("table", request.table);
  if (request.policy !== "materialize")
    throw new ApiError(
      "retypeColumn requires policy 'materialize': a retype is never interpreted against old data",
      400,
      "BACKFILL_POLICY_REQUIRED",
    );
  if (!isDeclaredColumnType(request.type))
    throw new ApiError(
      `unsupported target type ${JSON.stringify(request.type)}`,
      400,
      "VALIDATION_ERROR",
    );
  return runOperation(
    ns,
    {
      operation: "retypeColumn",
      table,
      policy: "materialize",
      request: {
        table,
        column: request.column,
        type: request.type,
        policy: "materialize",
      },
      work: (ctx) => {
        const existing = ctx.document.tables[table];
        if (!existing)
          throw new ApiError(
            `table '${table}' is not declared`,
            404,
            "TABLE_NOT_FOUND",
          );
        const target = existing.columns.find(
          (candidate) => candidate.name === request.column,
        );
        if (!target)
          throw new ApiError(
            `column '${request.column}' is not declared on table '${table}'`,
            404,
            "COLUMN_NOT_FOUND",
          );
        if (existing.keyColumns.includes(target.name))
          throw new ApiError(
            `column '${target.name}' is a key column and cannot be retyped in v1`,
            400,
            "RETYPE_NOT_PERMITTED",
          );
        if (target.type === request.type)
          throw new ApiError(
            `column '${target.name}' is already ${request.type}`,
            400,
            "VALIDATION_ERROR",
          );
        if (!retypeAllowed(target.type, request.type))
          throw new ApiError(
            `retype ${target.type} -> ${request.type} is not permitted in v1 (allowed: ${RETYPE_ALLOWED.join(", ")})`,
            400,
            "RETYPE_NOT_PERMITTED",
          );

        const retyped: DeclaredColumn = { ...target, type: request.type };
        const nextTable: SchemaTable = {
          ...existing,
          schemaVersion: existing.schemaVersion + 1,
          columns: existing.columns.map((candidate) =>
            candidate.name === target.name ? retyped : candidate,
          ),
        };
        const nextDocument: SchemaDocument = {
          ...ctx.document,
          tables: { ...ctx.document.tables, [table]: nextTable },
        };
        assertDocumentValid(
          nextDocument,
          `retypeColumn '${target.name}' rejected`,
        );

        // Convert a copy of the rows first: a lossy or unparseable row aborts
        // before a single byte is written (old state stays live).
        const { rows, problem } = readRowsForGeneration(
          ctx.nsDir,
          existing,
          existing.storage.path,
        );
        if (problem)
          throw new ApiError(
            `retype aborted before any write: ${problem}`,
            400,
            "CONVERSION_FAILED",
          );
        for (const [index, row] of rows.entries()) {
          const value = row.values[target.name];
          if (value === undefined || value === null) {
            row.values[target.name] = null;
            continue;
          }
          const converted = retypeValue(target.type, request.type, value);
          if (!converted.ok)
            throw new ApiError(
              `retype aborted before any write: row ${index + 1} column '${target.name}' value ${JSON.stringify(value)} ${converted.reason}`,
              400,
              "CONVERSION_FAILED",
            );
          row.values[target.name] = converted.value;
        }
        const materializable: SchemaTable = { ...nextTable };
        const validationProblem = validateGenerationRows(materializable, rows);
        if (validationProblem)
          throw new ApiError(
            `retype aborted before any write: ${validationProblem}`,
            400,
            "CONVERSION_FAILED",
          );

        const { generation } = materializeConvertedRows(
          ctx,
          table,
          existing,
          materializable,
          rows,
        );
        const switchedTable: SchemaTable = {
          ...materializable,
          storage: { path: generation.path },
        };
        return {
          nextDocument: {
            ...ctx.document,
            tables: { ...ctx.document.tables, [table]: switchedTable },
          },
          result: {
            schemaVersion: switchedTable.schemaVersion,
            table_: switchedTable,
            generation,
          },
        };
      },
    },
    options,
  );
}

function materializeConvertedRows(
  ctx: OperationContext,
  tableName: string,
  previous: SchemaTable,
  next: SchemaTable,
  rows: GenerationRow[],
): MaterializeOutcome {
  const { nsDir, operationId } = ctx;
  const lines = generationLines(next, rows);
  const newPath = generationPathFor(tableName, operationId);
  const abs = path.join(nsDir, newPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const body = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  const fd = fs.openSync(abs, "w", 0o644);
  try {
    fs.writeSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDir(path.dirname(abs));

  const onDisk = fs.readFileSync(abs, "utf-8");
  const validator = declaredRowValidator(next);
  for (const [index, line] of onDisk
    .split("\n")
    .filter((entry) => entry.trim().length > 0)
    .entries()) {
    const parsed = validator.safeParse(JSON.parse(line));
    if (!parsed.success)
      throw new ApiError(
        `materialized generation '${newPath}' line ${index + 1} failed declared validation: ${parsed.error.issues
          .map((issue) => issue.message)
          .join("; ")}`,
        400,
        "CONVERSION_FAILED",
      );
  }
  return {
    generation: {
      path: newPath,
      previousPath: previous.storage.path,
      sha256: sha256(onDisk),
      rows: lines.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export async function declareView(
  ns: string,
  request: ViewRequest,
  options: DdlCallOptions = {},
): Promise<DdlResult> {
  const view = validateResourceName("view", request.view);
  return runOperation(
    ns,
    {
      operation: "declareView",
      view,
      request: { view, dependsOn: request.dependsOn, query: request.query },
      work: (ctx) => {
        if (ctx.document.views[view])
          throw new ApiError(
            `view '${view}' is already declared; use redeclareView`,
            409,
            "VIEW_ALREADY_DECLARED",
          );
        const definition: SchemaView = {
          schemaVersion: 1,
          dependsOn: [...request.dependsOn],
          query: request.query,
        };
        const nextDocument: SchemaDocument = {
          ...ctx.document,
          views: { ...ctx.document.views, [view]: definition },
        };
        assertDocumentValid(nextDocument, `declareView '${view}' rejected`);
        return {
          nextDocument,
          result: {
            schemaVersion: definition.schemaVersion,
            viewDefinition: definition,
          },
        };
      },
    },
    options,
  );
}

export async function redeclareView(
  ns: string,
  request: ViewRequest,
  options: DdlCallOptions = {},
): Promise<DdlResult> {
  const view = validateResourceName("view", request.view);
  return runOperation(
    ns,
    {
      operation: "redeclareView",
      view,
      request: { view, dependsOn: request.dependsOn, query: request.query },
      work: (ctx) => {
        const existing = ctx.document.views[view];
        if (!existing)
          throw new ApiError(
            `view '${view}' is not declared`,
            404,
            "VIEW_NOT_FOUND",
          );
        const before = viewExposedColumns(ctx.document, view);
        const definition: SchemaView = {
          schemaVersion: existing.schemaVersion + 1,
          dependsOn: [...request.dependsOn],
          query: request.query,
        };
        const candidateDocument: SchemaDocument = {
          ...ctx.document,
          views: { ...ctx.document.views, [view]: definition },
        };
        const after = viewExposedColumns(candidateDocument, view);
        const shape = (columns: DeclaredColumn[]): string =>
          columns.map((column) => `${column.name}:${column.type}`).join(",");
        // Exposed-shape drift is the FIRST thing that must be refused: a view
        // has no automatic compatibility layer, because consumers depend on its
        // columns. (An unparseable new query yields no shape here, so document
        // validation below still reports the precise query problem.)
        if (after.length > 0 && shape(before) !== shape(after))
          throw new ApiError(
            `redeclareView '${view}' changes its exposed shape (${shape(before) || "<unresolvable>"} -> ${shape(after)}); a view has no automatic compatibility layer, so the change is refused`,
            409,
            "VIEW_SHAPE_CHANGED",
          );
        assertDocumentValid(
          candidateDocument,
          `redeclareView '${view}' rejected`,
        );
        if (shape(before) !== shape(after))
          throw new ApiError(
            `redeclareView '${view}' changes its exposed shape (${shape(before) || "<unresolvable>"} -> ${shape(after) || "<unresolvable>"}); a view has no automatic compatibility layer, so the change is refused`,
            409,
            "VIEW_SHAPE_CHANGED",
          );
        return {
          nextDocument: candidateDocument,
          result: {
            schemaVersion: definition.schemaVersion,
            viewDefinition: definition,
          },
        };
      },
    },
    options,
  );
}
