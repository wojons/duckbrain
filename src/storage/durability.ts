/**
 * DuckBrain durability layer (SUPA-1) — write path v2 contract.
 *
 * DuckBrain's historical write path acknowledged before any durability
 * barrier: `appendToJsonl` (`src/storage/jsonl.ts`) hands the bytes to the
 * kernel page cache via `fs.appendFileSync` and returns; the HTTP 2xx goes out
 * with no `fdatasync`, and git commits are debounced by
 * `gitBatching.maxSeconds` (default 30, `src/git/autocommit.ts`). The
 * resulting contract is CORRUPTION-RESISTANT BUT NOT ACK-DURABLE. This module
 * makes the contract explicit, per namespace, and enforceable.
 *
 * ── The contract, stated honestly ────────────────────────────────────────────
 *
 * | mode       | append mechanism                             |
 * | barrier before ack                    | RPO for acked writes (single node) |
 * |------------|----------------------------------------------|
 * |---------------------------------------|------------------------------------|
 * | `buffered` | `appendFileSync` (page cache) — the historical path |
 * | none                                  | process-kill safe; **OS-crash / power-loss window is UNBOUNDED** — recent acked writes can be lost |
 * | `fsync`    | open/write/`fdatasync`/close, + `fsync` on the parent directory when a file or directory was created | file `fdatasync` **and** directory `fsync` complete before the ack | **0** — on stable storage before the 2xx; survives process kill, OS crash and power loss |
 * | `direct`   | `O_DIRECT` append (page cache bypassed) over SUPA-2 block-framed records, same commit protocol as `fsync` | same as `fsync` | **0** |
 *
 * What is NOT covered, by design (`docs/specs/SUPA-1-write-durability.md`
 * non-goals):
 *
 * - **buffered mode is not OS-crash durable.** Its loss window is documented,
 *   not engineered away. It IS process-kill safe: the page cache outlives the
 *   process.
 * - **The git/S3 boundary stays debounced in every mode.** In fsync/direct mode
 *   the commit is history transport, not the durability mechanism; the
 *   exposure to git (and, with `s3.pushOnCommit`, to the S3 remote) remains
 *   ≤ `gitBatching.maxSeconds` (default 30s) / the S3 push window. RPO = 0 is a
 *   SINGLE-NODE claim: no synchronous cross-machine replication.
 * - **Tombstone appends** (`forgetTool` → `insertMemoryToPartition`,
 *   `src/duckdb/queries.ts`) still take the buffered append path; unifying all
 *   filesystem writes behind the serializer is DB-SUPA-2.
 *
 * ── Mode selection ───────────────────────────────────────────────────────────
 *
 * Per namespace, in `duckbrain.config.json`:
 *
 * ```json
 * { "durability": { "defaultMode": "buffered", "overrides": { "coding-hermes": "fsync" } } }
 * ```
 *
 * `DUCKBRAIN_DURABILITY_MODE=buffered|fsync|direct` overrides the runtime
 * default (never persisted). Precedence:
 * `overrides[ns] > DUCKBRAIN_DURABILITY_MODE > defaultMode > "buffered"`.
 * A malformed env value or an invalid config value fails config load with a
 * zod error — there is no silent fallback to buffered, because a silently
 * buffered namespace means acknowledged writes that are not durable while the
 * operator believes they are.
 *
 * @see docs/specs/SUPA-1-write-durability.md
 * @see docs/api/http-api.md (X-Durability header, /health durability block, RPO)
 */

import fs from "fs";
import path from "path";
import { MemorySchema, type MemoryType } from "../schema/memory";
import {
  getConfig,
  resolveDurabilityMode,
  type DuckBrainConfig,
  type WriteMode,
} from "../config";
import {
  ensureJsonlDir,
  resolveJsonlTargetPath,
  serializeJsonlLine,
} from "./jsonl";
import {
  DurabilityError,
  isDurabilityError,
  errnoDetail,
  FS_UNSUPPORTED_OP_CODES,
} from "./durability-errors";

export type { WriteMode };
export { DurabilityError, isDurabilityError };

/** Block size for O_DIRECT framing / alignment (4 KiB sectors). */
export const DURABILITY_BLOCK_SIZE = 4096;

/**
 * A SUPA-2 block-framed record: a block-aligned byte payload.
 *
 * `O_DIRECT` requires sector-aligned buffers and offsets, so a record must be
 * framed into block-sized I/O units before it can be written on a direct-mode
 * namespace. The framing is the SUPA-2 serializer's responsibility; this type
 * and `frameJsonlRecord` are the primitive it uses (and what makes direct mode
 * testable before SUPA-2 lands).
 */
export interface FramedJsonlWrite {
  readonly framed: "supa2-block";
  /** Payload padded to a multiple of DURABILITY_BLOCK_SIZE */
  readonly buffer: Buffer;
  /** Original record the payload encodes (used for chunk-rotation sizing) */
  readonly record: unknown;
}

/**
 * Type guard for a framed write payload.
 */
export function isFramedJsonlWrite(value: unknown): value is FramedJsonlWrite {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { framed?: unknown }).framed === "supa2-block" &&
    Buffer.isBuffer((value as { buffer?: unknown }).buffer)
  );
}

/**
 * Frame a record into a block-aligned O_DIRECT write unit.
 *
 * The payload is the record's JSONL line plus a trailing newline, padded with
 * newline bytes to the block boundary — padding that every JSONL reader
 * already skips (`readFromJsonl`/`readPartition` filter blank lines), so a
 * direct-mode partition stays readable by the same readers as buffered mode.
 *
 * @param record - Memory record to frame
 * @throws Error when the record cannot be serialized (never a silent skip:
 *   fsync/direct mode cannot drop a write it acknowledged)
 */
export function frameJsonlRecord(record: MemoryType): FramedJsonlWrite {
  const line = serializeJsonlLine(record);
  if (line === null) {
    throw new Error(
      "[durability] refusing to frame an unserializable record — direct mode " +
        "cannot drop an acknowledged write",
    );
  }
  const payload = Buffer.from(line + "\n", "utf-8");
  const blocks = Math.max(
    1,
    Math.ceil(payload.length / DURABILITY_BLOCK_SIZE),
  );
  // 0x0a (newline) padding keeps the framed unit valid JSONL for every reader.
  const buffer = Buffer.alloc(blocks * DURABILITY_BLOCK_SIZE, 0x0a);
  payload.copy(buffer, 0);
  return { framed: "supa2-block", buffer, record };
}

/**
 * Resolve the effective write mode for a namespace (SUPA-1).
 *
 * Precedence: `durability.overrides[ns]` > `DUCKBRAIN_DURABILITY_MODE` (when
 * set and valid) > `durability.defaultMode` > `"buffered"`.
 *
 * @param ns - Namespace name (the namespace actually written)
 * @param config - Config override for tests/embedders (defaults to getConfig())
 * @throws z.ZodError when DUCKBRAIN_DURABILITY_MODE is malformed
 */
export function resolveWriteMode(
  ns: string,
  config?: DuckBrainConfig,
): WriteMode {
  return resolveDurabilityMode(ns, config);
}

/**
 * The value of the `X-Durability` response header for a namespace.
 *
 * Set on 2xx write responses only (a denied or failed write never emits it).
 * Never throws: if config resolution itself fails the request has already
 * failed elsewhere; the header falls back to the safe historical claim.
 *
 * @param ns - Namespace actually written
 */
export function durabilityHeaderFor(
  ns: string,
  config?: DuckBrainConfig,
): WriteMode {
  try {
    return resolveWriteMode(ns, config);
  } catch {
    return "buffered";
  }
}

/** Shape of the `durability` block in the `/health` payload. */
export interface DurabilityHealth {
  defaultMode: WriteMode;
  overrides: Record<string, WriteMode>;
}

/**
 * Config-derived durability health for `GET /health`.
 *
 * Lists the effective default mode plus the non-default namespace overrides
 * only (bounded payload). Derived from config alone — no filesystem probe, so
 * `/health` can never fail or stall over durability reporting.
 *
 * @param config - Config override for tests (defaults to getConfig())
 */
export function getDurabilityHealth(config?: DuckBrainConfig): DurabilityHealth {
  try {
    const cfg = config ?? getConfig(".");
    const defaultMode = cfg.durability?.defaultMode ?? "buffered";
    const overrides: Record<string, WriteMode> = {};
    for (const [ns, mode] of Object.entries(cfg.durability?.overrides ?? {})) {
      if (mode !== defaultMode) {
        overrides[ns] = mode;
      }
    }
    return { defaultMode, overrides };
  } catch {
    return { defaultMode: "buffered", overrides: {} };
  }
}

// ── Durable appenders ────────────────────────────────────────────────────────

/**
 * fdatasync the data fd. Throws (before any ack) when the barrier fails —
 * the record may or may not be on disk, but it is NEVER acknowledged.
 */
function barrierFile(fd: number, filePath: string): void {
  try {
    fs.fdatasyncSync(fd);
  } catch (error) {
    throw new DurabilityError(
      "DURABILITY_FSYNC_FAILED",
      `fdatasync failed for ${filePath} — write NOT acknowledged: ${errnoDetail(error)}`,
    );
  }
}

/**
 * fsync a directory fd so a newly-created file/directory NAME reaches stable
 * storage (data fsync alone does not persist the directory entry).
 *
 * Directory fsync unsupported (some NFS mounts return EINVAL) is treated as a
 * durability failure — skipping it would silently weaken the RPO = 0 claim.
 */
function fsyncDirectory(dir: string, reason: string): void {
  let dirFd: number;
  try {
    dirFd = fs.openSync(dir, "r");
  } catch (error) {
    throw new DurabilityError(
      "DURABILITY_DIR_FSYNC_UNSUPPORTED",
      `cannot open directory ${dir} to fsync it (${reason}) — write NOT acknowledged: ${errnoDetail(error)}`,
    );
  }
  try {
    fs.fsyncSync(dirFd);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code && FS_UNSUPPORTED_OP_CODES.has(code)) {
      throw new DurabilityError(
        "DURABILITY_DIR_FSYNC_UNSUPPORTED",
        `directory fsync unsupported on ${dir} (${code}, ${reason}) — write NOT acknowledged`,
      );
    }
    throw new DurabilityError(
      "DURABILITY_FSYNC_FAILED",
      `directory fsync failed for ${dir} (${reason}) — write NOT acknowledged: ${errnoDetail(error)}`,
    );
  } finally {
    fs.closeSync(dirFd);
  }
}

/**
 * Directory fsync inventory for fsync/direct mode.
 *
 * Per `docs/specs/SUPA-1-write-durability.md`:
 * (a) the append created the file itself (first write to a partition),
 * (b) the append rotated to a new chunk file,
 * (c) the append created directories — then the parent of the DEEPEST newly
 *     created directory is fsynced in addition to the file's parent.
 */
function fsyncParentsForCreate(
  targetPath: string,
  fileExisted: boolean,
  createdDirs: string[],
): void {
  if (fileExisted && createdDirs.length === 0) {
    return;
  }
  const fileParent = path.dirname(targetPath);
  fsyncDirectory(fileParent, fileExisted ? "new chunk file" : "new file");

  if (createdDirs.length > 0) {
    const deepest = createdDirs[createdDirs.length - 1];
    const deepestParent = path.dirname(deepest);
    if (path.resolve(deepestParent) !== path.resolve(fileParent)) {
      fsyncDirectory(deepestParent, "new directory created");
    }
  }
}

/**
 * fsync-mode append: `openSync(path, "a")` → `writeSync` →
 * `fdatasyncSync(fd)` → `closeSync(fd)`, then a directory `fsync` when this
 * append created the file or any directory. The barrier completes BEFORE this
 * function returns, i.e. before the caller can acknowledge the write.
 *
 * The line is byte-identical to the buffered path (`serializeJsonlLine`), so
 * readers cannot tell which mode wrote a partition.
 *
 * @param filePath - Full path to the JSONL file (e.g. .../current.jsonl)
 * @param record - Memory record to append
 * @returns 1 on a durable append
 * @throws DurabilityError DURABILITY_FSYNC_FAILED / DURABILITY_DIR_FSYNC_UNSUPPORTED
 */
export function appendJsonlDurable(
  filePath: string,
  record: MemoryType,
): number {
  MemorySchema.parse(record);

  const line = serializeJsonlLine(record);
  if (line === null) {
    // Buffered mode skips (DB-GAP-035) — the durable path cannot: skipping
    // while the caller acks would be silent data loss.
    throw new Error(
      `[durability] refusing to append unserializable record to ${filePath} — fsync mode cannot drop an acknowledged write`,
    );
  }

  const dir = path.dirname(filePath);
  const createdDirs = ensureJsonlDir(dir);
  const targetPath = resolveJsonlTargetPath(filePath, line);
  const fileExisted = fs.existsSync(targetPath);

  const fd = fs.openSync(targetPath, "a");
  try {
    fs.writeSync(fd, line + "\n");
    barrierFile(fd, targetPath);
  } finally {
    fs.closeSync(fd);
  }

  fsyncParentsForCreate(targetPath, fileExisted, createdDirs);
  return 1;
}

/**
 * direct-mode append: the same commit protocol as fsync mode, but the append
 * itself goes through an `O_DIRECT` fd (page cache bypassed).
 *
 * Requires a SUPA-2 block-framed payload (`frameJsonlRecord`); a bare line
 * append to a direct-mode namespace is a programming error and throws
 * DURABILITY_DIRECT_FRAME_ERROR rather than handing the kernel an unaligned
 * buffer it would reject mid-write. A filesystem that cannot do O_DIRECT
 * (tmpfs, overlayfs) fails LOUD (DURABILITY_UNSUPPORTED) — no byte is ever
 * silently written under buffered semantics.
 *
 * @param filePath - Full path to the JSONL file
 * @param record - Framed payload (see `frameJsonlRecord`)
 * @returns 1 on a durable append
 * @throws DurabilityError DURABILITY_DIRECT_FRAME_ERROR / DURABILITY_UNSUPPORTED /
 *         DURABILITY_FSYNC_FAILED / DURABILITY_DIR_FSYNC_UNSUPPORTED
 */
export function appendJsonlDirect(
  filePath: string,
  record: FramedJsonlWrite | MemoryType,
): number {
  if (!isFramedJsonlWrite(record)) {
    throw new DurabilityError(
      "DURABILITY_DIRECT_FRAME_ERROR",
      `direct mode requires a block-framed record (frameJsonlRecord / SUPA-2 ` +
        `serializer) — refusing an unframed append to ${filePath}`,
    );
  }
  if (
    record.buffer.length === 0 ||
    record.buffer.length % DURABILITY_BLOCK_SIZE !== 0
  ) {
    throw new DurabilityError(
      "DURABILITY_DIRECT_FRAME_ERROR",
      `direct mode requires a ${DURABILITY_BLOCK_SIZE}-byte-aligned payload — ` +
        `got ${record.buffer.length} bytes for ${filePath}`,
    );
  }

  const dir = path.dirname(filePath);
  const createdDirs = ensureJsonlDir(dir);

  // Chunk rotation sizes off the record's JSONL line, exactly like the other
  // two modes, so a direct-mode partition rotates identically.
  const line = isMemoryShaped(record.record)
    ? serializeJsonlLine(record.record)
    : null;
  const targetPath =
    line === null ? filePath : resolveJsonlTargetPath(filePath, line);
  const fileExisted = fs.existsSync(targetPath);

  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    // O_APPEND keeps every write at end-of-file, which stays block-aligned
    // because every framed payload is a whole number of blocks.
    fs.constants.O_APPEND |
    fs.constants.O_DIRECT;

  let fd: number;
  try {
    fd = fs.openSync(targetPath, flags, 0o644);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code && FS_UNSUPPORTED_OP_CODES.has(code)) {
      throw new DurabilityError(
        "DURABILITY_UNSUPPORTED",
        `O_DIRECT is not supported on this filesystem for ${targetPath} — ` +
          `write NOT acknowledged, no bytes written: ${errnoDetail(error)}`,
      );
    }
    throw new DurabilityError(
      "DURABILITY_FSYNC_FAILED",
      `cannot open ${targetPath} for direct-mode append — write NOT acknowledged: ${errnoDetail(error)}`,
    );
  }

  try {
    try {
      fs.writeSync(fd, record.buffer, 0, record.buffer.length, null);
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code && FS_UNSUPPORTED_OP_CODES.has(code)) {
        throw new DurabilityError(
          "DURABILITY_UNSUPPORTED",
          `O_DIRECT write rejected on ${targetPath} (${errnoDetail(error)}) — ` +
            "write NOT acknowledged, no buffered fallback taken",
        );
      }
      throw new DurabilityError(
        "DURABILITY_FSYNC_FAILED",
        `direct-mode write failed for ${targetPath} — write NOT acknowledged: ${errnoDetail(error)}`,
      );
    }
    barrierFile(fd, targetPath);
  } finally {
    fs.closeSync(fd);
  }

  fsyncParentsForCreate(targetPath, fileExisted, createdDirs);
  return 1;
}

/**
 * Does this value look like a memory record (used only for rotation sizing)?
 */
function isMemoryShaped(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { key?: unknown }).key === "string"
  );
}

// ── Shutdown barrier (AC-7) ──────────────────────────────────────────────────

type DurabilityDrainHook = () => Promise<void> | void;

const drainHooks: DurabilityDrainHook[] = [];

/**
 * Register a drain hook that must complete before the graceful-shutdown commit
 * flush (SUPA-2's per-namespace `flush()` joins this barrier).
 */
export function registerDurabilityDrainHook(hook: DurabilityDrainHook): void {
  drainHooks.push(hook);
}

/**
 * Drain pending durable work before shutdown.
 *
 * SUPA-1 appends are synchronous: by the time a write is acknowledged its
 * `fdatasync` + directory `fsync` have already completed, so there is no
 * queued durability work to drain here. That is the honest state today — the
 * hooks exist so the SUPA-2 serializer's queued appends drain through the same
 * barrier before `flushAllCommits()` runs.
 */
export async function drainDurableWrites(): Promise<void> {
  for (const hook of [...drainHooks]) {
    await hook();
  }
}
