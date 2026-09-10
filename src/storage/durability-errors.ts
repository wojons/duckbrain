/**
 * SUPA-1 durability error types.
 *
 * Kept in their own module (no dependency on `src/storage/jsonl.ts` or
 * `src/storage/durability.ts`) so both can throw/recognize them without a
 * module cycle.
 *
 * Every code maps to HTTP 500 with the code verbatim in the error envelope —
 * the point is that a durability mechanism that cannot honor its contract
 * fails the request LOUDLY instead of silently degrading to buffered
 * semantics while still returning 2xx.
 */

export type DurabilityErrorCode =
  /** The filesystem rejects O_DIRECT (EINVAL/EOPNOTSUPP — tmpfs, overlayfs) */
  | "DURABILITY_UNSUPPORTED"
  /** A bare line append to a direct-mode namespace (SUPA-2 framing required) */
  | "DURABILITY_DIRECT_FRAME_ERROR"
  /** fdatasync/fsync on the data file failed (e.g. EIO) */
  | "DURABILITY_FSYNC_FAILED"
  /** Directory fsync unsupported (some NFS mounts return EINVAL) */
  | "DURABILITY_DIR_FSYNC_UNSUPPORTED"
  /** appendToJsonl (buffered path) called for an fsync/direct namespace */
  | "DURABILITY_BYPASS";

/** errno codes that mean "this filesystem cannot do that operation" */
export const FS_UNSUPPORTED_OP_CODES: ReadonlySet<string> = new Set([
  "EINVAL",
  "EOPNOTSUPP",
  "ENOTSUP",
  "ENOSYS",
]);

/** Alias used when the operation in question is an O_DIRECT open/write. */
export const O_DIRECT_UNSUPPORTED_CODES: ReadonlySet<string> =
  FS_UNSUPPORTED_OP_CODES;

/**
 * A durability-contract violation. Carries the stable machine-readable code
 * surfaced to HTTP callers and `status: 500` so routes can wrap it in the
 * shared ApiError envelope without losing the code.
 */
export class DurabilityError extends Error {
  readonly code: DurabilityErrorCode;
  readonly status = 500;

  constructor(code: DurabilityErrorCode, message: string) {
    // The code leads the message so operator logs and API error strings both
    // carry the machine-readable identifier even outside the JSON envelope.
    super(`${code}: ${message}`);
    this.name = "DurabilityError";
    this.code = code;
  }
}

/**
 * Type guard for the durability error envelope.
 */
export function isDurabilityError(error: unknown): error is DurabilityError {
  return (
    error instanceof DurabilityError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: string }).name === "DurabilityError" &&
      typeof (error as { code?: string }).code === "string")
  );
}

/**
 * Short, human-readable detail for an errno-shaped error.
 */
export function errnoDetail(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return code ? `${code}: ${message}` : message;
}
