import fs from "fs";
import path from "path";
import { Mutex } from "async-mutex";
import {
  getConfig,
  resolveDuckbrainRoot,
  resolveNamespacesPath,
} from "../config";
import { commitNamespace } from "../git/autocommit";
import { addPartition } from "../storage/manifest";
import {
  appendJsonlDirect,
  frameJsonlRecord,
  registerDurabilityDrainHook,
  resolveWriteMode,
} from "../storage/durability";
import {
  DurabilityError,
  FS_UNSUPPORTED_OP_CODES,
  errnoDetail,
  isDurabilityError,
} from "../storage/durability-errors";
import {
  ensureJsonlDir,
  resolveJsonlTargetPath,
  serializeJsonlLine,
} from "../storage/jsonl";
import { AuditEntrySchema, type AuditEntry, type AuditSink } from "./audit";
import {
  AUDIT_DIR,
  appendAuditLedger,
  type AuditLedgerLimits,
} from "./auditLedger";
import { invalidateKeysCache } from "../keys/keyListCache";
import {
  declaredSchemaVersion,
  keyMaterialFor,
  missingKeyColumns,
} from "./changeRecord";
import {
  acquireNamespaceWriteLock,
  releaseNamespaceWriteLock,
  tokenStillCurrent,
  type NamespaceWriteLock,
} from "./lock";
import { runOutsideCommitGate } from "../git/autocommit";
import { tableSchemaRegistry, type TableSchemaRegistry } from "./registry";
import type {
  AuthorizationDecision,
  AuthorizationHook,
  WriteInput,
  WriteRequest,
  WriteResult,
} from "./types";

interface PendingWrite {
  request: WriteRequest;
  line: string;
  bytes: number;
  resolve: (result: WriteResult) => void;
}

interface PendingAudit {
  entry: AuditEntry;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface PreparedAppend {
  filePath: string;
  line: string;
  record: unknown;
  /**
   * Physical path the append actually landed in (rotation-aware). DB-SUPA-5
   * change records persist this as `targetPath` so replay can find the data
   * row at the same committed ref.
   */
  resolvedPath?: string;
}

export interface NamespaceWriterOptions {
  namespacesPath?: string;
  registry?: TableSchemaRegistry;
  authorization?: AuthorizationHook;
  maxPendingRows?: number;
  maxPendingBytes?: number;
  autoFlush?: boolean;
  scheduleCommit?: (namespacePath: string) => void;
  /** Deterministic fencing seam used by process/lock acceptance tests. */
  afterLockAcquired?: (lock: NamespaceWriteLock) => void | Promise<void>;
  /** DB-SUPA-5 audit-ledger segment line bound (config `storage.maxLinesPerChunk`). */
  auditMaxLinesPerChunk?: number;
  /** DB-SUPA-5 audit-ledger segment byte bound (config `storage.maxBytesPerChunk`). */
  auditMaxBytesPerChunk?: number;
}

const allowAll: AuthorizationHook = () => ({ allowed: true });
let serializerAuthorizationHook: AuthorizationHook = allowAll;
let serializerShuttingDown = false;
const writers = new Map<string, NamespaceWriter>();

function fieldsFromIssues(
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
) {
  const fields: Record<string, string> = {};
  for (const issue of issues) {
    fields[issue.path.map(String).join(".") || "general"] = issue.message;
  }
  return fields;
}

function failed(
  code: string,
  message: string,
  seq = 0,
  extras: Pick<
    Extract<WriteResult, { ok: false }>,
    "fields" | "retryAfter"
  > = {},
): WriteResult {
  return { seq, ok: false, code, message, ...extras };
}

function decisionOrDenied(value: AuthorizationDecision): AuthorizationDecision {
  return value && typeof value === "object" && "allowed" in value
    ? value
    : {
        allowed: false,
        reason: "role",
        message: "Authorization hook denied write",
      };
}

function principalName(
  request: Pick<WriteRequest, "principal">,
): string | null {
  return request.principal?.name ?? null;
}

function acceptedAudit(request: WriteRequest): AuditEntry {
  return {
    ts: new Date().toISOString(),
    ns: request.ns,
    table: request.table,
    op: request.op,
    principal: principalName(request),
    outcome: "accepted",
    seq: request.seq,
  };
}

function deniedAudit(
  request: Pick<WriteRequest, "ns" | "table" | "op" | "principal">,
  reason: string,
): AuditEntry {
  return {
    ts: new Date().toISOString(),
    ns: request.ns,
    table: request.table,
    op: request.op,
    principal: principalName(request as WriteRequest),
    outcome: "denied",
    reason,
  };
}

function safeTarget(namespacePath: string, relativeTarget?: string): string {
  const target = relativeTarget ?? "current.jsonl";
  const resolved = path.resolve(namespacePath, target);
  const rel = path.relative(namespacePath, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `VALIDATION_ERROR: target path escapes namespace: ${target}`,
    );
  }
  return resolved;
}

/** Namespace-relative POSIX path (the form a committed git path takes). */
function namespaceRelative(targetPath: string, namespacePath: string): string {
  return path.relative(namespacePath, targetPath).split(path.sep).join("/");
}

/**
 * DB-SUPA-5 post-commit notifier seam.
 *
 * The serializer appends and then merely SCHEDULES a debounced namespace
 * commit, so it cannot know when the commit lands. The notifier therefore only
 * wakes the change feed, which confirms every published change against a
 * successful reachable `HEAD` — never against timer execution.
 */
export type CommitNotifier = (namespace: string) => void;

let commitNotifier: CommitNotifier | undefined;

export function setCommitNotifier(notifier: CommitNotifier | undefined): void {
  commitNotifier = notifier;
}

function notifyCommit(namespace: string): void {
  if (!commitNotifier) return;
  try {
    commitNotifier(namespace);
  } catch (error) {
    console.warn(
      `[serialization] commit notifier failed for ${namespace}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Build the DB-SUPA-5 accepted change record: the SUPA-2 audit row plus the
 * operation, table, row image/tombstone, declared key material, physical
 * `targetPath`, and declared `schemaVersion` a later replay needs.
 */
function changeRecordFor(
  namespacePath: string,
  request: WriteRequest,
  audit: AuditEntry,
  targetPath: string,
): AuditEntry {
  return {
    ...audit,
    row: request.record,
    key: keyMaterialFor(namespacePath, request.table, request.record),
    targetPath,
    tombstone: request.op === "delete",
    schemaVersion: declaredSchemaVersion(namespacePath, request.table),
  };
}

function fsyncDirectory(dir: string): void {
  let fd: number;
  try {
    fd = fs.openSync(dir, "r");
  } catch (error) {
    throw new DurabilityError(
      "DURABILITY_DIR_FSYNC_UNSUPPORTED",
      `cannot open directory ${dir} for serializer fsync: ${errnoDetail(error)}`,
    );
  }
  try {
    fs.fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new DurabilityError(
      code && FS_UNSUPPORTED_OP_CODES.has(code)
        ? "DURABILITY_DIR_FSYNC_UNSUPPORTED"
        : "DURABILITY_FSYNC_FAILED",
      `serializer directory fsync failed for ${dir}: ${errnoDetail(error)}`,
    );
  } finally {
    fs.closeSync(fd);
  }
}

/** One fdatasync per touched file for the whole fan-in flush batch. */
function appendFsyncBatch(
  entries: PreparedAppend[],
  assertCurrent: () => void,
): void {
  const handles = new Map<
    string,
    { fd: number; fileExisted: boolean; createdDirs: string[] }
  >();
  let writeError: unknown;
  try {
    for (const entry of entries) {
      assertCurrent();
      const createdDirs = ensureJsonlDir(path.dirname(entry.filePath));
      const targetPath = resolveJsonlTargetPath(entry.filePath, entry.line);
      entry.resolvedPath = targetPath;
      let handle = handles.get(targetPath);
      if (!handle) {
        const fileExisted = fs.existsSync(targetPath);
        handle = {
          fd: fs.openSync(targetPath, "a"),
          fileExisted,
          createdDirs,
        };
        handles.set(targetPath, handle);
      } else if (createdDirs.length > 0) {
        handle.createdDirs.push(...createdDirs);
      }
      fs.writeSync(handle.fd, entry.line + "\n");
    }
    assertCurrent();
    for (const [targetPath, handle] of handles) {
      try {
        fs.fdatasyncSync(handle.fd);
      } catch (error) {
        throw new DurabilityError(
          "DURABILITY_FSYNC_FAILED",
          `serializer fdatasync failed for ${targetPath}: ${errnoDetail(error)}`,
        );
      }
    }
  } catch (error) {
    writeError = error;
    throw error;
  } finally {
    for (const handle of handles.values()) {
      try {
        fs.closeSync(handle.fd);
      } catch (error) {
        if (!writeError) throw error;
      }
    }
  }

  const dirs = new Set<string>();
  for (const [targetPath, handle] of handles) {
    if (!handle.fileExisted || handle.createdDirs.length > 0) {
      dirs.add(path.dirname(targetPath));
    }
    if (handle.createdDirs.length > 0) {
      dirs.add(path.dirname(handle.createdDirs[handle.createdDirs.length - 1]));
    }
  }
  for (const dir of dirs) fsyncDirectory(dir);
}

function appendBufferedBatch(
  entries: PreparedAppend[],
  assertCurrent: () => void,
): void {
  for (const entry of entries) {
    assertCurrent();
    ensureJsonlDir(path.dirname(entry.filePath));
    const targetPath = resolveJsonlTargetPath(entry.filePath, entry.line);
    entry.resolvedPath = targetPath;
    fs.appendFileSync(targetPath, entry.line + "\n", "utf-8");
  }
}

function appendDirectBatch(
  entries: PreparedAppend[],
  assertCurrent: () => void,
): void {
  for (const entry of entries) {
    assertCurrent();
    // appendJsonlDirect resolves chunk rotation itself from the same line;
    // resolving it here first records the physical path a DB-SUPA-5 change
    // record must point at (the file state cannot change between the two).
    entry.resolvedPath = resolveJsonlTargetPath(entry.filePath, entry.line);
    appendJsonlDirect(entry.filePath, frameJsonlRecord(entry.record as never));
  }
}

const FLUSH_FAN_IN_MS = 5;

export class NamespaceWriter implements AuditSink {
  readonly ns: string;
  readonly namespacesPath: string;
  readonly namespacePath: string;
  readonly registry: TableSchemaRegistry;
  readonly authorization: AuthorizationHook;
  readonly maxPendingRows: number;
  readonly maxPendingBytes: number;
  readonly autoFlush: boolean;
  /** DB-SUPA-5 audit-ledger segment bounds (immutable-segment invariant). */
  readonly auditLimits: AuditLedgerLimits;

  private readonly enqueueMutex = new Mutex();
  private readonly scheduleCommit: (namespacePath: string) => void;
  private readonly afterLockAcquired?: NamespaceWriterOptions["afterLockAcquired"];
  private queue: PendingWrite[] = [];
  private auditQueue: PendingAudit[] = [];
  private nextSeq = 0;
  private queuedRows = 0;
  private queuedBytes = 0;
  private scheduled: NodeJS.Timeout | null = null;
  private flushPromise: Promise<void> | null = null;
  private registrationsInProgress = 0;
  private shuttingDown = false;
  private isFenced = false;

  constructor(ns: string, options: NamespaceWriterOptions = {}) {
    this.ns = ns;
    // GAP-062: the write root is the config file's own directory, never cwd.
    const config = getConfig(resolveDuckbrainRoot());
    this.namespacesPath = path.resolve(
      options.namespacesPath ?? resolveNamespacesPath(),
    );
    this.namespacePath = path.join(this.namespacesPath, ns);
    this.registry = options.registry ?? tableSchemaRegistry;
    this.authorization = options.authorization ?? serializerAuthorizationHook;
    this.maxPendingRows =
      options.maxPendingRows ?? config.serialization.maxPendingRows;
    this.maxPendingBytes =
      options.maxPendingBytes ?? config.serialization.maxPendingBytes;
    this.autoFlush = options.autoFlush ?? true;
    this.scheduleCommit = options.scheduleCommit ?? commitNamespace;
    this.afterLockAcquired = options.afterLockAcquired;
    this.auditLimits = {
      maxLines:
        options.auditMaxLinesPerChunk ?? config.storage.maxLinesPerChunk,
      maxBytes:
        options.auditMaxBytesPerChunk ?? config.storage.maxBytesPerChunk,
    };
  }

  get pendingRows(): number {
    return this.queuedRows;
  }

  get pendingBytes(): number {
    return this.queuedBytes;
  }

  get fenced(): boolean {
    return this.isFenced;
  }

  async enqueue(input: WriteInput): Promise<WriteResult> {
    if (serializerShuttingDown || this.shuttingDown) {
      return failed("SERVER_SHUTTING_DOWN", "Server is shutting down");
    }
    this.registrationsInProgress += 1;
    let outcome: { completion: Promise<WriteResult> };
    try {
      outcome = await this.enqueueMutex.runExclusive(async () => {
        if (this.isFenced) {
          return {
            completion: Promise.resolve(
              failed(
                "SERIALIZER_FENCED",
                `Serializer for namespace '${this.ns}' is fenced until restart`,
              ),
            ),
          };
        }

        const validation = this.validateInput(input);
        if (!validation.ok) {
          return { completion: Promise.resolve(validation.result) };
        }

        const provisional: WriteRequest = {
          ...input,
          record: validation.record,
          seq: this.nextSeq + 1,
        };
        const authorization = await this.checkAuthorization(
          provisional,
          "enqueue",
        );
        if (!authorization.allowed) {
          const auditDone = this.enqueueAuditUnsafe(
            deniedAudit(provisional, authorization.reason),
          );
          this.scheduleFlush();
          return {
            completion: auditDone
              .catch(() => undefined)
              .then(() =>
                failed(
                  "FORBIDDEN",
                  authorization.message ?? "Write is not authorized",
                ),
              ),
          };
        }

        if (
          this.queuedRows >= this.maxPendingRows ||
          this.queuedBytes + validation.bytes > this.maxPendingBytes
        ) {
          return {
            completion: Promise.resolve(
              failed(
                "SERIALIZER_QUEUE_FULL",
                `Serializer queue for namespace '${this.ns}' is full`,
                0,
                { retryAfter: 1 },
              ),
            ),
          };
        }

        provisional.seq = ++this.nextSeq;
        const completion = new Promise<WriteResult>((resolve) => {
          this.queue.push({
            request: provisional,
            line: validation.line,
            bytes: validation.bytes,
            resolve,
          });
          this.queuedRows += 1;
          this.queuedBytes += validation.bytes;
        });
        this.scheduleFlush();
        return { completion };
      });
    } finally {
      this.registrationsInProgress -= 1;
    }
    return outcome.completion;
  }

  async enqueueBatch(inputs: WriteInput[]): Promise<WriteResult[]> {
    if (inputs.length === 0) return [];
    if (serializerShuttingDown || this.shuttingDown) {
      return inputs.map(() =>
        failed("SERVER_SHUTTING_DOWN", "Server is shutting down"),
      );
    }
    this.registrationsInProgress += 1;
    let outcome: { completion: Promise<WriteResult[]> };
    try {
      outcome = await this.enqueueMutex.runExclusive(async () => {
        if (this.isFenced) {
          return {
            completion: Promise.resolve(
              inputs.map(() =>
                failed(
                  "SERIALIZER_FENCED",
                  `Serializer for '${this.ns}' is fenced`,
                ),
              ),
            ),
          };
        }

        const validated = inputs.map((item) => this.validateInput(item));
        const invalid = validated.find((item) => !item.ok);
        if (invalid && !invalid.ok) {
          return {
            completion: Promise.resolve(inputs.map(() => invalid.result)),
          };
        }
        const prepared = validated.filter(
          (item): item is Extract<(typeof validated)[number], { ok: true }> =>
            item.ok,
        );
        const totalBytes = prepared.reduce((sum, item) => sum + item.bytes, 0);
        if (
          this.queuedRows + inputs.length > this.maxPendingRows ||
          this.queuedBytes + totalBytes > this.maxPendingBytes
        ) {
          return {
            completion: Promise.resolve(
              inputs.map(() =>
                failed(
                  "SERIALIZER_QUEUE_FULL",
                  `Serializer queue for namespace '${this.ns}' is full`,
                  0,
                  { retryAfter: 1 },
                ),
              ),
            ),
          };
        }

        const requests: WriteRequest[] = inputs.map((item, index) => ({
          ...item,
          record: prepared[index].record,
          seq: this.nextSeq + index + 1,
        }));
        for (const request of requests) {
          const authorization = await this.checkAuthorization(
            request,
            "enqueue",
          );
          if (!authorization.allowed) {
            const auditDone = this.enqueueAuditUnsafe(
              deniedAudit(request, authorization.reason),
            );
            this.scheduleFlush();
            return {
              completion: auditDone
                .catch(() => undefined)
                .then(() =>
                  inputs.map(() =>
                    failed(
                      "FORBIDDEN",
                      authorization.message ?? "Write is not authorized",
                    ),
                  ),
                ),
            };
          }
        }

        const completions = requests.map(
          (request, index) =>
            new Promise<WriteResult>((resolve) => {
              request.seq = ++this.nextSeq;
              this.queue.push({
                request,
                line: prepared[index].line,
                bytes: prepared[index].bytes,
                resolve,
              });
              this.queuedRows += 1;
              this.queuedBytes += prepared[index].bytes;
            }),
        );
        this.scheduleFlush();
        return { completion: Promise.all(completions) };
      });
    } finally {
      this.registrationsInProgress -= 1;
    }
    return outcome.completion;
  }

  async enqueueAudit(entry: AuditEntry): Promise<void> {
    if (serializerShuttingDown || this.shuttingDown) {
      throw new Error("SERVER_SHUTTING_DOWN: audit writer is draining");
    }
    const validated = AuditEntrySchema.parse({ ...entry, ns: this.ns });
    this.registrationsInProgress += 1;
    let outcome: { completion: Promise<void> };
    try {
      outcome = await this.enqueueMutex.runExclusive(() => {
        const completion = this.enqueueAuditUnsafe(validated);
        this.scheduleFlush();
        return { completion };
      });
    } finally {
      this.registrationsInProgress -= 1;
    }
    return outcome.completion;
  }

  async flush(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = this.flushOnce().finally(() => {
      this.flushPromise = null;
      if (this.queue.length > 0 || this.auditQueue.length > 0)
        this.scheduleFlush();
    });
    return this.flushPromise;
  }

  async drain(): Promise<void> {
    this.shuttingDown = true;
    if (this.scheduled) {
      clearTimeout(this.scheduled);
      this.scheduled = null;
    }
    while (this.registrationsInProgress > 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    while (
      this.queue.length > 0 ||
      this.auditQueue.length > 0 ||
      this.flushPromise
    ) {
      await this.flush();
    }
  }

  cancelScheduledFlush(): void {
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = null;
  }

  private validateInput(
    input: WriteInput,
  ):
    | { ok: true; record: unknown; line: string; bytes: number }
    | { ok: false; result: WriteResult } {
    if (input.ns !== this.ns) {
      return {
        ok: false,
        result: failed(
          "VALIDATION_ERROR",
          "Namespace does not match writer",
          0,
          {
            fields: { ns: "namespace does not match writer" },
          },
        ),
      };
    }
    const schema = this.registry.get(input.ns, input.table);
    if (!schema) {
      return {
        ok: false,
        result: failed(
          "VALIDATION_ERROR",
          `No schema registered for table '${input.table}' in namespace '${input.ns}'`,
          0,
          { fields: { table: "schema is not registered" } },
        ),
      };
    }
    const parsed = schema.safeParse(input.record);
    if (!parsed.success) {
      return {
        ok: false,
        result: failed("VALIDATION_ERROR", "Record validation failed", 0, {
          fields: fieldsFromIssues(parsed.error.issues),
        }),
      };
    }
    const line = serializeJsonlLine(parsed.data);
    if (line === null) {
      return {
        ok: false,
        result: failed(
          "VALIDATION_ERROR",
          "Record is not JSON serializable",
          0,
          {
            fields: { general: "record is not JSON serializable" },
          },
        ),
      };
    }
    try {
      safeTarget(this.namespacePath, input.targetPath);
    } catch (error) {
      return {
        ok: false,
        result: failed("VALIDATION_ERROR", (error as Error).message, 0, {
          fields: { targetPath: "path escapes namespace" },
        }),
      };
    }
    // DB-SUPA-5: a delete that lacks all declared key columns fails BEFORE
    // enqueue — it could never generate an addressable deletion event.
    if (input.op === "delete") {
      const missing = missingKeyColumns(
        this.namespacePath,
        input.table,
        parsed.data,
      );
      if (missing.length > 0) {
        return {
          ok: false,
          result: failed(
            "VALIDATION_ERROR",
            `delete requires the declared key column(s) ${missing.join(", ")}`,
            0,
            {
              fields: Object.fromEntries(
                missing.map((column) => [column, "key column is required"]),
              ),
            },
          ),
        };
      }
    }
    return {
      ok: true,
      record: parsed.data,
      line,
      bytes: Buffer.byteLength(line + "\n"),
    };
  }

  private async checkAuthorization(
    request: WriteRequest,
    phase: "enqueue" | "flush",
  ): Promise<AuthorizationDecision> {
    try {
      return decisionOrDenied(await this.authorization(request, phase));
    } catch (error) {
      return {
        allowed: false,
        reason: "role",
        message: `Authorization check failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private enqueueAuditUnsafe(entry: AuditEntry): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.auditQueue.push({
        entry: AuditEntrySchema.parse(entry),
        resolve,
        reject,
      });
    });
  }

  private scheduleFlush(): void {
    if (!this.autoFlush || this.scheduled || this.flushPromise) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      void this.flush();
    }, FLUSH_FAN_IN_MS);
  }

  /**
   * DF-0925-02 — the flush runs OUTSIDE the same-process commit gate: an
   * in-flight commit chain (scheduled by an earlier flush) completes its
   * stage→commit under the file lock first, then this flush takes the lock
   * with its whole data+audit batch. Waiting on the gate instead of racing
   * the commit to the fail-fast file lock is what keeps a burst from failing
   * SERIALIZER_LOCKED once commits are fenced (autocommit `withCommitGate`).
   * Cross-process exclusion stays with the file lock itself.
   */
  private async flushOnce(): Promise<void> {
    return runOutsideCommitGate(this.namespacePath, () =>
      this.flushOnceLocked(),
    );
  }

  private async flushOnceLocked(): Promise<void> {
    if (this.scheduled) {
      clearTimeout(this.scheduled);
      this.scheduled = null;
    }
    const batch = await this.enqueueMutex.runExclusive(() => {
      const writes = this.queue
        .splice(0)
        .sort((left, right) => left.request.seq - right.request.seq);
      const audits = this.auditQueue.splice(0);
      return { writes, audits };
    });
    if (batch.writes.length === 0 && batch.audits.length === 0) return;

    const settle = (pending: PendingWrite, result: WriteResult) => {
      this.queuedRows -= 1;
      this.queuedBytes -= pending.bytes;
      pending.resolve(result);
    };

    if (!fs.existsSync(this.namespacePath)) {
      for (const pending of batch.writes) {
        settle(
          pending,
          failed(
            "NOT_FOUND",
            `Namespace '${this.ns}' was deleted before the write flushed`,
            pending.request.seq,
          ),
        );
      }
      const error = new Error(`Namespace '${this.ns}' not found`);
      for (const audit of batch.audits) audit.reject(error);
      return;
    }

    const lock = acquireNamespaceWriteLock(this.namespacesPath, this.ns);
    if (!lock) {
      for (const pending of batch.writes) {
        settle(
          pending,
          failed(
            "SERIALIZER_LOCKED",
            `Namespace '${this.ns}' is locked by another writer process`,
            pending.request.seq,
            { retryAfter: 1 },
          ),
        );
      }
      const error = new Error(`SERIALIZER_LOCKED: namespace '${this.ns}'`);
      for (const audit of batch.audits) audit.reject(error);
      return;
    }

    const assertCurrent = () => {
      if (!tokenStillCurrent(this.namespacesPath, this.ns, lock.token)) {
        this.isFenced = true;
        console.error(`[serialization] fenced writer for ns ${this.ns}`);
        throw new Error("SERIALIZER_FENCED");
      }
    };

    const resolved = new Map<PendingWrite, WriteResult>();
    const dataEntries: Array<PreparedAppend & { pending: PendingWrite }> = [];
    /**
     * Ordered audit plan. Accepted writes become DB-SUPA-5 change records only
     * AFTER the data append, so the plan is materialized once the physical
     * target of each accepted row is known; the row order is exactly the
     * order the audit ledger would have had without the change fields.
     */
    const auditPlan: Array<
      | { kind: "entry"; entry: AuditEntry }
      | { kind: "change"; pending: PendingWrite; audit: AuditEntry }
    > = [];
    const accepted: PendingWrite[] = [];
    try {
      await this.afterLockAcquired?.(lock);
      assertCurrent();

      for (const pending of batch.writes) {
        const authorization = await this.checkAuthorization(
          pending.request,
          "flush",
        );
        if (!authorization.allowed) {
          resolved.set(
            pending,
            failed(
              "FORBIDDEN",
              authorization.message ?? "Write authorization was revoked",
              pending.request.seq,
            ),
          );
          auditPlan.push({
            kind: "entry",
            entry: deniedAudit(pending.request, authorization.reason),
          });
          continue;
        }

        const dataPath = safeTarget(
          this.namespacePath,
          pending.request.targetPath,
        );
        dataEntries.push({
          filePath: dataPath,
          line: pending.line,
          record: pending.request.record,
          pending,
        });
        auditPlan.push({
          kind: "change",
          pending,
          audit: acceptedAudit(pending.request),
        });
        accepted.push(pending);
      }

      for (const audit of batch.audits) {
        auditPlan.push({ kind: "entry", entry: audit.entry });
      }

      const mode = resolveWriteMode(this.ns);
      if (mode === "fsync") appendFsyncBatch(dataEntries, assertCurrent);
      else if (mode === "direct") appendDirectBatch(dataEntries, assertCurrent);
      else appendBufferedBatch(dataEntries, assertCurrent);

      // Audit rows follow their accepted data writes but intentionally use the
      // buffered path. SUPA-2 documents a bounded crash window for audit tails;
      // syncing the separate audit file here would add a second fdatasync per
      // batch and violate SUPA-1's fan-in amortization contract.
      //
      // DB-SUPA-5: `_audit/` is an append-only segmented ledger. Sealing a
      // segment is permanent — `appendAuditLedger` starts the next zero-padded
      // numeric segment and never reopens, shortens, renames, or reorders one.
      const auditLines: string[] = [];
      for (const item of auditPlan) {
        if (item.kind === "entry") {
          const line = serializeJsonlLine(item.entry);
          if (line !== null) auditLines.push(line);
          continue;
        }
        const physical = item.pending.request;
        const dataEntry = dataEntries.find(
          (entry) => entry.pending === item.pending,
        );
        const targetPath = namespaceRelative(
          dataEntry?.resolvedPath ??
            safeTarget(this.namespacePath, physical.targetPath),
          this.namespacePath,
        );
        const change = changeRecordFor(
          this.namespacePath,
          physical,
          item.audit,
          targetPath,
        );
        const line = serializeJsonlLine(change);
        if (line !== null) auditLines.push(line);
      }
      appendAuditLedger(
        path.join(this.namespacePath, AUDIT_DIR),
        auditLines,
        this.auditLimits,
      );
      assertCurrent();

      const partitions = new Set(
        accepted
          .map((pending) => pending.request.partitionPath)
          .filter((value): value is string => Boolean(value)),
      );
      for (const partition of partitions)
        addPartition(this.namespacePath, partition);
      // PERF-001: accepted data writes change the key list (remember adds,
      // forget tombstones) — drop the key-list cache entry so the next
      // list_keys read rebuilds. Best-effort (never throws); the read path's
      // fingerprint signal is the safety net.
      if (dataEntries.length > 0) invalidateKeysCache(this.namespacePath);
      if (dataEntries.length > 0 || auditLines.length > 0) {
        this.scheduleCommit(this.namespacePath);
        // DB-SUPA-5: wake the change feed. The feed still publishes only what
        // a successful reachable HEAD proves.
        notifyCommit(this.ns);
      }

      for (const pending of accepted) {
        resolved.set(pending, { seq: pending.request.seq, ok: true });
      }
      for (const audit of batch.audits) audit.resolve();
    } catch (error) {
      const fenced =
        this.isFenced ||
        (error instanceof Error && error.message === "SERIALIZER_FENCED");
      const code = fenced
        ? "SERIALIZER_FENCED"
        : isDurabilityError(error)
          ? error.code
          : "INTERNAL_ERROR";
      for (const audit of batch.audits) audit.reject(error as Error);
      for (const pending of batch.writes) {
        if (!resolved.has(pending)) {
          resolved.set(
            pending,
            failed(
              code,
              error instanceof Error ? error.message : String(error),
              pending.request.seq,
            ),
          );
        }
      }
    } finally {
      releaseNamespaceWriteLock(lock);
      for (const pending of batch.writes) {
        settle(
          pending,
          resolved.get(pending) ??
            failed(
              "INTERNAL_ERROR",
              "Serializer did not resolve write",
              pending.request.seq,
            ),
        );
      }
    }
  }
}

export function setSerializerAuthorizationHook(hook: AuthorizationHook): void {
  serializerAuthorizationHook = hook;
}

export function getNamespaceWriter(
  ns: string,
  options: NamespaceWriterOptions = {},
): NamespaceWriter {
  // GAP-062: write root = the config file's own directory, never cwd.
  const root = path.resolve(options.namespacesPath ?? resolveNamespacesPath());
  const key = `${root}\u0000${ns}`;
  let writer = writers.get(key);
  if (!writer) {
    writer = new NamespaceWriter(ns, { ...options, namespacesPath: root });
    writers.set(key, writer);
  }
  return writer;
}

export async function drainAllNamespaceWriters(): Promise<void> {
  serializerShuttingDown = true;
  await Promise.all([...writers.values()].map((writer) => writer.drain()));
}

export function resetSerializerStateForTests(): void {
  for (const writer of writers.values()) writer.cancelScheduledFlush();
  writers.clear();
  serializerAuthorizationHook = allowAll;
  serializerShuttingDown = false;
}

registerDurabilityDrainHook(drainAllNamespaceWriters);
