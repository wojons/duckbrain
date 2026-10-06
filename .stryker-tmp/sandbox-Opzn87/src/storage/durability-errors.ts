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
// @ts-nocheck
function stryNS_9fa48() {
  var g = typeof globalThis === 'object' && globalThis && globalThis.Math === Math && globalThis || new Function("return this")();
  var ns = g.__stryker__ || (g.__stryker__ = {});
  if (ns.activeMutant === undefined && g.process && g.process.env && g.process.env.__STRYKER_ACTIVE_MUTANT__) {
    ns.activeMutant = g.process.env.__STRYKER_ACTIVE_MUTANT__;
  }
  function retrieveNS() {
    return ns;
  }
  stryNS_9fa48 = retrieveNS;
  return retrieveNS();
}
stryNS_9fa48();
function stryCov_9fa48() {
  var ns = stryNS_9fa48();
  var cov = ns.mutantCoverage || (ns.mutantCoverage = {
    static: {},
    perTest: {}
  });
  function cover() {
    var c = cov.static;
    if (ns.currentTestId) {
      c = cov.perTest[ns.currentTestId] = cov.perTest[ns.currentTestId] || {};
    }
    var a = arguments;
    for (var i = 0; i < a.length; i++) {
      c[a[i]] = (c[a[i]] || 0) + 1;
    }
  }
  stryCov_9fa48 = cover;
  cover.apply(null, arguments);
}
function stryMutAct_9fa48(id) {
  var ns = stryNS_9fa48();
  function isActive(id) {
    if (ns.activeMutant === id) {
      if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) {
        throw new Error('Stryker: Hit count limit reached (' + ns.hitCount + ')');
      }
      return true;
    }
    return false;
  }
  stryMutAct_9fa48 = isActive;
  return isActive(id);
}
export type DurabilityErrorCode = /** The filesystem rejects O_DIRECT (EINVAL/EOPNOTSUPP — tmpfs, overlayfs) */
"DURABILITY_UNSUPPORTED"
/** A bare line append to a direct-mode namespace (SUPA-2 framing required) */ | "DURABILITY_DIRECT_FRAME_ERROR"
/** fdatasync/fsync on the data file failed (e.g. EIO) */ | "DURABILITY_FSYNC_FAILED"
/** Directory fsync unsupported (some NFS mounts return EINVAL) */ | "DURABILITY_DIR_FSYNC_UNSUPPORTED"
/** appendToJsonl (buffered path) called for an fsync/direct namespace */ | "DURABILITY_BYPASS";

/** errno codes that mean "this filesystem cannot do that operation" */
export const FS_UNSUPPORTED_OP_CODES: ReadonlySet<string> = new Set(stryMutAct_9fa48("0") ? [] : (stryCov_9fa48("0"), [stryMutAct_9fa48("1") ? "" : (stryCov_9fa48("1"), "EINVAL"), stryMutAct_9fa48("2") ? "" : (stryCov_9fa48("2"), "EOPNOTSUPP"), stryMutAct_9fa48("3") ? "" : (stryCov_9fa48("3"), "ENOTSUP"), stryMutAct_9fa48("4") ? "" : (stryCov_9fa48("4"), "ENOSYS")]));

/** Alias used when the operation in question is an O_DIRECT open/write. */
export const O_DIRECT_UNSUPPORTED_CODES: ReadonlySet<string> = FS_UNSUPPORTED_OP_CODES;

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
    super(stryMutAct_9fa48("5") ? `` : (stryCov_9fa48("5"), `${code}: ${message}`));
    this.name = stryMutAct_9fa48("6") ? "" : (stryCov_9fa48("6"), "DurabilityError");
    this.code = code;
  }
}

/**
 * Type guard for the durability error envelope.
 */
export function isDurabilityError(error: unknown): error is DurabilityError {
  if (stryMutAct_9fa48("7")) {
    {}
  } else {
    stryCov_9fa48("7");
    return stryMutAct_9fa48("10") ? error instanceof DurabilityError && typeof error === "object" && error !== null && (error as {
      name?: string;
    }).name === "DurabilityError" && typeof (error as {
      code?: string;
    }).code === "string" : stryMutAct_9fa48("9") ? false : stryMutAct_9fa48("8") ? true : (stryCov_9fa48("8", "9", "10"), error instanceof DurabilityError || (stryMutAct_9fa48("12") ? typeof error === "object" && error !== null && (error as {
      name?: string;
    }).name === "DurabilityError" || typeof (error as {
      code?: string;
    }).code === "string" : stryMutAct_9fa48("11") ? false : (stryCov_9fa48("11", "12"), (stryMutAct_9fa48("14") ? typeof error === "object" && error !== null || (error as {
      name?: string;
    }).name === "DurabilityError" : stryMutAct_9fa48("13") ? true : (stryCov_9fa48("13", "14"), (stryMutAct_9fa48("16") ? typeof error === "object" || error !== null : stryMutAct_9fa48("15") ? true : (stryCov_9fa48("15", "16"), (stryMutAct_9fa48("18") ? typeof error !== "object" : stryMutAct_9fa48("17") ? true : (stryCov_9fa48("17", "18"), typeof error === (stryMutAct_9fa48("19") ? "" : (stryCov_9fa48("19"), "object")))) && (stryMutAct_9fa48("21") ? error === null : stryMutAct_9fa48("20") ? true : (stryCov_9fa48("20", "21"), error !== null)))) && (stryMutAct_9fa48("23") ? (error as {
      name?: string;
    }).name !== "DurabilityError" : stryMutAct_9fa48("22") ? true : (stryCov_9fa48("22", "23"), (error as {
      name?: string;
    }).name === (stryMutAct_9fa48("24") ? "" : (stryCov_9fa48("24"), "DurabilityError")))))) && (stryMutAct_9fa48("26") ? typeof (error as {
      code?: string;
    }).code !== "string" : stryMutAct_9fa48("25") ? true : (stryCov_9fa48("25", "26"), typeof (error as {
      code?: string;
    }).code === (stryMutAct_9fa48("27") ? "" : (stryCov_9fa48("27"), "string")))))));
  }
}

/**
 * Short, human-readable detail for an errno-shaped error.
 */
export function errnoDetail(error: unknown): string {
  if (stryMutAct_9fa48("28")) {
    {}
  } else {
    stryCov_9fa48("28");
    const code = stryMutAct_9fa48("29") ? (error as {
      code?: string;
    } | null).code : (stryCov_9fa48("29"), (error as {
      code?: string;
    } | null)?.code);
    const message = error instanceof Error ? error.message : String(error);
    return code ? stryMutAct_9fa48("30") ? `` : (stryCov_9fa48("30"), `${code}: ${message}`) : message;
  }
}