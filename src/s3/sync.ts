/**
 * Native S3 sync engine.
 *
 * Deltas only: raw JSONL + manifest files are mirrored to
 * `s3://<bucket>/<prefix>/<namespace>/<relPath>` — .git, DuckDB index files
 * (*.db, *.parquet) and local caches are NEVER synced (they are rebuildable
 * or versioned separately). The engine never opens the namespace DuckDB file,
 * so it cannot fight the MCP/HTTP servers over the single-writer lock.
 *
 * Push  = upload local files that are new/changed since the last sync.
 * Pull  = download remote files missing or different locally (no deletions —
 *         S3 is treated as a backup accumulation mirror, mirroring the
 *         no-`--delete` policy of the shell scripts).
 */

import fs from "fs";
import path from "path";
// PERF-004 — lazy ./client: it pulls in @aws-sdk/client-s3. This module is
// loaded statically by lifecycle (which the CLI + MCP namespace tools load),
// so the client (SDK) is deferred to the sync functions that need it.
async function loadClient(): Promise<typeof import("./client.js")> {
  return (await import("./client.js")) as typeof import("./client.js");
}
import type { RemoteObject } from "./client.js";
import type { S3Client } from "@aws-sdk/client-s3";
import {
  loadManifest,
  saveManifest,
  makeManifest,
  type S3SyncManifest,
  type FileMeta,
} from "./manifest";
import type { S3Config } from "./config";
import { isPidAlive } from "../utils/pidfile";
import { createHash } from "crypto";

/**
 * S3-GIT-008 — content identity.
 *
 * Chosen approach (why this shape):
 *  - LOCAL identity is always sha256 of the file bytes. Weak hashes were the
 *    root cause of S3-GIT-008 (size+mtimeMs alone silently equated two
 *    different payloads), so identity is cryptographic, not heuristic.
 *  - The sha256 is PERSISTED per file in the sync manifest at upload time and
 *    compared on later passes — this is the primary remote comparison and
 *    needs no network round-trips.
 *  - Remote objects are NOT fetched+hashed speculatively. The ETag serves at
 *    two strengths: (a) a single-part ETag IS the object's md5, so the md5
 *    comparison is authoritative in BOTH directions — a match against the
 *    local md5 proves byte equality, a mismatch proves divergence; (b) a
 *    multipart ETag (`<hex>-<parts>` — the dash means the hex prefix is a
 *    per-part md5 composite, NOT the object checksum) carries no comparable
 *    checksum, so it is only matched against the ETag our own manifest
 *    recorded at the last successful transfer (a version token): unchanged
 *    listed ETag + intact local identity ⇒ remote untouched; changed ETag ⇒
 *    the object was rewritten server-side and must be repaired even though
 *    we can never compare its checksum. A dash-containing ETag is therefore
 *    NEVER treated as a content checksum — equality is only ever judged
 *    against a value we recorded ourselves from the same server.
 *  - When no evidence tier can decide (no identity record, no usable ETag),
 *    the caller downloads (pull) or re-uploads (push) — a redundant transfer
 *    is the accepted cost of never equating different payloads.
 */

/** sha256 (hex) of a buffer — the local content-identity function. */
export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** ETag is a usable md5 checksum only when single-part (no '-') and hex. */
function etagChecksum(etag: string | undefined): string | null {
  if (!etag) return null;
  const hex = etag.replace(/"/g, "").trim();
  if (hex.length !== 32) return null;
  if (hex.includes("-")) return null; // multipart ETag — NOT a checksum
  return /^[0-9a-fA-F]{32}$/.test(hex) ? hex.toLowerCase() : null;
}

/** md5 (hex, lowercase) of a buffer — matches a single-part S3 ETag. */
function md5Hex(buf: Buffer): string {
  return createHash("md5").update(buf).digest("hex");
}

/**
 * S3-PULL-INTEGRITY-001 — verify the bytes we just DOWNLOADED.
 *
 * The delta layer decides what to transfer from content identity; nothing
 * verified what arrived. A remote object overwritten with same-length garbage
 * was written to disk, the pull reported success, and a restore into an empty
 * root served the corrupt bytes. Every downloaded body is now checked before
 * it is allowed on disk, strongest evidence first:
 *
 *  1. LISTING SIZE — a body whose length differs from the object's listed size
 *     was truncated/extended in transit. Always available, always decisive.
 *  2. LEDGER sha256 — the hash our own push published for this path. Content
 *     authority: it is the ONLY tier that catches an object rewritten
 *     server-side, because such an object carries a self-consistent ETag
 *     (the bucket derives it from whatever bytes it now holds) and passes any
 *     md5 check. Checked FIRST, so a matching ETag can never short-circuit it.
 *  3. SINGLE-PART ETag — an ETag without a '-' is the object's md5, so the
 *     downloaded bytes' md5 must equal it. Transport/at-rest integrity for
 *     objects we have no ledger entry for.
 *  4. MANIFEST sha256 — our own local record of the bytes last synced for this
 *     path, usable only while the listing's ETag still EQUALS the ETag
 *     recorded with it: that version token is what proves the hash describes
 *     the object we just fetched. A changed token means the remote was
 *     rewritten since, so the recorded hash describes DIFFERENT bytes.
 *  5. Nothing — no ledger entry, no usable ETag and no still-valid manifest
 *     hash (fresh machine with pre-ledger data, multipart ETag, legacy
 *     record). The bytes are accepted but REPORTED as unverified: a restore
 *     that silently trusts them is how corruption becomes live memory, and a
 *     restore that refuses them cannot run on a fresh machine at all.
 */
export interface DownloadEvidence {
  /** ETag from the remote listing of the object being downloaded. */
  etag?: string;
  /** Size from the remote listing (the remote object's authoritative length). */
  size?: number;
  /**
   * sha256 published in the namespace's checksum LEDGER (`<prefix>/<ns>/
   * .s3state/checksums.json`, written by the push that uploaded the objects).
   * This is the only evidence that survives a fresh machine: the listing ETag
   * is recomputed from whatever bytes are stored now, so an object overwritten
   * server-side carries a self-consistent ETag and passes the md5 tier.
   */
  ledgerSha256?: string;
  /** sha256 recorded in our manifest at the last successful sync of this path. */
  manifestSha256?: string;
  /** ETag recorded in our manifest at that same sync (a version token). */
  manifestEtag?: string;
}

export type DownloadVerdict =
  | {
      kind: "verified";
      evidence: "etag-md5" | "ledger-sha256" | "manifest-sha256";
    }
  | { kind: "unverified"; reason: string }
  | {
      kind: "mismatch";
      evidence: "listing-size" | "etag-md5" | "ledger-sha256" | "manifest-sha256";
      expected: string;
      actual: string;
      detail: string;
    };

/** Verify one downloaded object body against the evidence we hold for it. */
export function verifyDownloadedObject(
  body: Buffer,
  evidence: DownloadEvidence,
): DownloadVerdict {
  // Tier 0 — the listing's size is free and always comparable.
  if (evidence.size !== undefined && body.length !== evidence.size) {
    return {
      kind: "mismatch",
      evidence: "listing-size",
      expected: String(evidence.size),
      actual: String(body.length),
      detail: `downloaded ${body.length} bytes but the listing says ${evidence.size}`,
    };
  }

  // Tier 1 — the published checksum ledger: our own record of what these
  // bytes were when they were uploaded. It is the only tier that survives a
  // restore onto a machine with no local state, and the only one that can
  // catch an object rewritten server-side (whose ETag is self-consistent).
  if (evidence.ledgerSha256 !== undefined) {
    const actual = sha256Hex(body);
    if (actual === evidence.ledgerSha256) {
      return { kind: "verified", evidence: "ledger-sha256" };
    }
    return {
      kind: "mismatch",
      evidence: "ledger-sha256",
      expected: evidence.ledgerSha256,
      actual,
      detail: `sha256 ${actual} != ledger ${evidence.ledgerSha256}`,
    };
  }

  // Tier 2 — a single-part ETag IS the md5 of the object.
  const checksum = etagChecksum(evidence.etag);
  if (checksum) {
    const actual = md5Hex(body);
    if (actual === checksum) return { kind: "verified", evidence: "etag-md5" };
    return {
      kind: "mismatch",
      evidence: "etag-md5",
      expected: checksum,
      actual,
      detail: `md5 ${actual} != listing ETag ${checksum}`,
    };
  }

  // Tier 3 — our own manifest hash, valid only while the version token holds.
  if (evidence.manifestSha256 !== undefined) {
    const listed = (evidence.etag ?? "").replace(/"/g, "").trim();
    const tokenHolds =
      evidence.manifestEtag !== undefined &&
      listed !== "" &&
      listed === evidence.manifestEtag.replace(/"/g, "").trim();
    if (tokenHolds) {
      const actual = sha256Hex(body);
      if (actual === evidence.manifestSha256) {
        return { kind: "verified", evidence: "manifest-sha256" };
      }
      return {
        kind: "mismatch",
        evidence: "manifest-sha256",
        expected: evidence.manifestSha256,
        actual,
        detail: `sha256 ${actual} != manifest ${evidence.manifestSha256} (remote version token unchanged)`,
      };
    }
    return {
      kind: "unverified",
      reason: `manifest hash recorded but the remote version token changed (listing=${listed || "none"} recorded=${evidence.manifestEtag ?? "none"})`,
    };
  }

  return {
    kind: "unverified",
    reason:
      listedReason(evidence) ??
      "no single-part ETag and no manifest identity for this object",
  };
}

/** Why an object carries no checksum evidence (for the loud unverified report). */
function listedReason(evidence: DownloadEvidence): string | null {
  if (evidence.etag === undefined) return "listing carries no ETag";
  const hex = evidence.etag.replace(/"/g, "").trim();
  if (hex.includes("-")) {
    return `multipart ETag (${hex.split("-")[1]} parts) is not a content checksum`;
  }
  return null;
}

/**
 * Remote identity verdict for `localBytes` vs the listed remote object.
 * Two outcomes — "same" is only ever returned when sameness is PROVEN;
 * every unproven case ("transfer") makes the caller act conservatively:
 * re-upload on push, download (repair) on pull.
 *
 * Evidence tiers, strongest first:
 *  1. USABLE md5 ETag (single-part, 32-hex, no '-'): authoritative — a match
 *     against the local md5 pins the remote bytes byte-for-byte → "same";
 *     a mismatch proves divergence → "transfer". (A dash-containing ETag is
 *     NEVER compared as a checksum: the hex prefix of `<hex>-<parts>` is a
 *     per-part md5 composite, not the object checksum.)
 *  2. Recorded ETag from our own manifest (written at the last successful
 *     transfer): a VERSION TOKEN, not a checksum. Listed ETag EQUALS it while
 *     the recorded sha256 still matches the local bytes ⇒ the object is
 *     untouched since we transferred those exact bytes → "same". Any other
 *     combination (rewritten ETag — including a multipart one we could never
 *     checksum-compare — or locally diverged bytes) → "transfer".
 *  3. Manifest sha256 identity alone (legacy pre-008 records): "same" only
 *     when the wire shows NO ETag at all; an unverifiable ETag on the wire
 *     means the object MIGHT have been rewritten since our last sync, and we
 *     have no recorded ETag to compare → repair conservatively. (One-time
 *     migration cost: the first pass after the upgrade re-transfers affected
 *     files and records their ETags, after which tier 1/2 decide.)
 */
function remoteIdentity(
  localBytes: Buffer,
  manifestMeta: FileMeta | undefined,
  remoteObj: RemoteObject,
): "same" | "transfer" {
  // Tier 1: usable (single-part) ETag as a real checksum.
  const checksum = etagChecksum(remoteObj.etag);
  if (checksum) return checksum === md5Hex(localBytes) ? "same" : "transfer";

  // Tier 2: our own recorded ETag as a version token.
  if (manifestMeta?.etag !== undefined) {
    const listed = (remoteObj.etag ?? "").replace(/"/g, "").trim();
    const identityStillHolds =
      manifestMeta.sha256 === undefined ||
      manifestMeta.sha256 === sha256Hex(localBytes);
    return listed === manifestMeta.etag && identityStillHolds
      ? "same"
      : "transfer";
  }

  // Tier 3: legacy manifest sha256 identity, only with no ETag on the wire.
  if (
    remoteObj.etag === undefined &&
    manifestMeta?.sha256 !== undefined &&
    manifestMeta.sha256 === sha256Hex(localBytes)
  ) {
    return "same";
  }
  return "transfer";
}

/** Directories never synced (per-namespace repo internals). */
const EXCLUDED_DIRS = new Set([
  ".git",
  ".s3state",
  ".embeddings",
  "node_modules",
]);
/** Extensions never synced (rebuildable caches / temp files). */
const EXCLUDED_EXTENSIONS = new Set([".db", ".parquet", ".tmp", ".bak"]);
const EXCLUDED_FILES = new Set([".DS_Store"]);

/**
 * S3-PULL-INTEGRITY-001 — the published checksum ledger.
 *
 * The pull verifies what it downloads, but the strongest evidence we have —
 * our own sha256 per path — lived only in `<namespacesPath>/.s3state/<ns>.json`
 * on the machine that PUSHED. A restore onto an empty root therefore had no
 * authority at all: the listing's ETag is recomputed from whatever bytes the
 * bucket holds NOW, so a same-length overwrite produces a perfectly
 * self-consistent ETag and passes any md5 tier. That is exactly the fault the
 * negative control injects.
 *
 * So the push publishes its identity record next to the data, at
 * `<prefix>/<ns>/.s3state/checksums.json` (a path walkLocal() never syncs as
 * data and computeDeltas() never downloads as a file), and every pull fetches
 * it before deciding what the download should contain. The ledger is metadata:
 * it does not change file counts, and its own upload failure is a loud push
 * failure rather than a silent gap.
 */
export const LEDGER_REL_PATH = ".s3state/checksums.json";

export interface LedgerEntry {
  sha256: string;
  size: number;
  etag?: string;
}

export interface ChecksumLedger {
  version: 1;
  ns: string;
  generatedAt: string;
  files: Record<string, LedgerEntry>;
}

/** Remote key of a namespace's checksum ledger object. */
export function ledgerKey(cfg: S3Config, ns: string): string {
  return `${cfg.prefix}/${ns}/${LEDGER_REL_PATH}`;
}

/** Build the ledger from the identity the push just recorded in the manifest. */
export function buildLedger(
  ns: string,
  files: Record<string, FileMeta>,
  now: Date = new Date(),
): ChecksumLedger {
  const entries: Record<string, LedgerEntry> = {};
  for (const [relPath, meta] of Object.entries(files)) {
    if (meta.sha256 === undefined) continue;
    entries[relPath] = {
      sha256: meta.sha256,
      size: meta.size,
      ...(meta.etag !== undefined ? { etag: meta.etag } : {}),
    };
  }
  return {
    version: 1,
    ns,
    generatedAt: now.toISOString(),
    files: entries,
  };
}

/** Parse a downloaded ledger; null means "unusable", never "trust it anyway". */
export function parseLedger(raw: Buffer, ns: string): ChecksumLedger | null {
  try {
    const parsed = JSON.parse(raw.toString("utf-8")) as ChecksumLedger;
    if (parsed.version !== 1) return null;
    if (parsed.ns !== undefined && parsed.ns !== ns) return null;
    if (!parsed.files || typeof parsed.files !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}


const CONTENT_TYPES: Record<string, string> = {
  ".jsonl": "application/x-ndjson",
  ".json": "application/json",
  ".md": "text/markdown",
  ".txt": "text/plain",
};

/**
 * S3-PULL-INTEGRITY-001 — one object the pull could not put on disk.
 *
 * `kind: "transfer"` means the GET itself failed; `kind: "verification"` means
 * the bytes arrived and were REJECTED (corrupt or truncated), so nothing was
 * written. Both are failures of the restore, not warnings: the object is named
 * and the caller exits nonzero.
 */
export interface SyncFailure {
  ns: string;
  key: string;
  relPath: string;
  kind: "transfer" | "verification";
  detail: string;
}

export interface SyncStats {
  ns: string;
  direction: "push" | "pull";
  uploaded: number;
  downloaded: number;
  skipped: number;
  durationMs: number;
  /**
   * S3-PULL-INTEGRITY-001 (pull only): objects whose bytes were PROVEN equal
   * to the remote (listing size + single-part ETag md5, or a manifest sha256
   * still pinned by an unchanged ETag version token).
   */
  verified: number;
  /**
   * S3-PULL-INTEGRITY-001 (pull only): objects accepted with NO checksum
   * evidence — a fresh machine with no manifest, a multipart ETag, or a legacy
   * record. They are restored (a restore must work on a machine that has
   * nothing) but counted and reported, never silently trusted.
   */
  unverified: number;
  /** The keys behind `unverified` (same order, so the report can name them). */
  unverifiedKeys: string[];
  /** Objects that were NOT restored: transfer error or rejected bytes. */
  failed: number;
  failures: SyncFailure[];
  /**
   * S3-PULL-INTEGRITY-001: state of the namespace's published checksum ledger.
   * `pushed` (push) / `present` (pull) mean the identity record was available;
   * `absent` means there was nothing to verify against (pre-ledger push, or a
   * ledger that could not be read) — the restore ran on trusted, unproven
   * bytes and says so.
   */
  checksumLedger: "pushed" | "present" | "absent";
}

export interface LocalFile {
  relPath: string;
  size: number;
  mtimeMs: number;
}

/** Recursively walk a namespace dir, returning syncable files (relPath → meta). */
export function walkLocal(nsPath: string): Map<string, LocalFile> {
  const out = new Map<string, LocalFile>();
  const visit = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (EXCLUDED_DIRS.has(e.name)) continue;
        visit(path.join(dir, e.name), rel);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (EXCLUDED_EXTENSIONS.has(ext)) continue;
        if (EXCLUDED_FILES.has(e.name)) continue;
        try {
          const st = fs.statSync(path.join(dir, e.name));
          out.set(rel, { relPath: rel, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          // file vanished mid-walk — skip
        }
      }
    }
  };
  visit(nsPath, "");
  return out;
}

export function remoteKeyFor(
  cfg: S3Config,
  ns: string,
  relPath: string,
): string {
  return `${cfg.prefix}/${ns}/${relPath}`;
}

export interface SyncDeltas {
  toUpload: LocalFile[];
  toDownload: { key: string; relPath: string; size: number }[];
  skipped: number;
  /**
   * S3-GIT-008: which files the `skipped` count refers to. Only these were
   * proven present-and-identical on the remote this pass, so only these may
   * be carried forward into the saved manifest.
   */
  skippedRelPaths: string[];
}

/**
 * Compute push/pull deltas from local walk + remote listing + last manifest.
 *
 * S3-GIT-008: `localContents` (relPath → bytes, sampled by the caller at the
 * SAME moment as the walk) carries content identity. Deltas are decided by
 * content, never by size+mtime alone:
 *  - push uploads when the local bytes' identity diverges from what the
 *    manifest recorded as last-synced (same-size corruption included), or
 *    when the remote side cannot be proven current;
 *  - pull downloads when the remote side is not provably identical to the
 *    local bytes (md5 ETag hint when available; multipart '-' ETags are never
 *    trusted as checksums and force the download).
 *
 * Pure function (unit-tested offline).
 */
export function computeDeltas(
  cfg: S3Config,
  ns: string,
  local: Map<string, LocalFile>,
  remote: Map<string, RemoteObject>,
  manifest: S3SyncManifest | null,
  localContents?: Map<string, Buffer>,
): SyncDeltas {
  const prefix = `${cfg.prefix}/${ns}/`;
  const toUpload: LocalFile[] = [];
  const toDownload: { key: string; relPath: string; size: number }[] = [];
  const skippedRelPaths: string[] = [];
  let skipped = 0;

  for (const [relPath, file] of local) {
    const key = `${prefix}${relPath}`;
    const remoteObj = remote.get(key);
    const prev = manifest?.files?.[relPath];
    const content = localContents?.get(relPath);

    // ---- local-side change detection (content identity, not size+mtime) ----
    const localUnchanged =
      prev !== undefined &&
      prev.size === file.size &&
      prev.mtimeMs === file.mtimeMs &&
      (prev.sha256 === undefined ||
        (content !== undefined && prev.sha256 === sha256Hex(content)));

    if (content === undefined) {
      // No bytes available → fall back to the historical metadata-only
      // comparison (best effort, no fabricated identity).
      if (localUnchanged && remoteObj && remoteObj.size === file.size) {
        skipped++;
        skippedRelPaths.push(relPath);
      } else {
        toUpload.push(file);
      }
      continue;
    }

    if (remoteObj === undefined) {
      toUpload.push(file); // never synced remotely
      continue;
    }

    const identity = remoteIdentity(content, prev, remoteObj);
    if (identity === "same" && remoteObj.size === file.size) {
      skipped++;
      skippedRelPaths.push(relPath);
    } else {
      // Identity unknown (incl. same-size divergent content) → re-upload;
      // or identity byte-equal but metadata disagrees — refresh remote
      // metadata so the recorded size stops drifting (S3-GIT-008 probe).
      toUpload.push(file);
    }
  }

  for (const [key, obj] of remote) {
    if (!key.startsWith(prefix)) continue;
    const relPath = key.slice(prefix.length);
    // S3-PULL-INTEGRITY-001: the checksum ledger is engine metadata that lives
    // under the namespace prefix; it is fetched deliberately, never "restored"
    // as if it were one of the namespace's data files.
    if (relPath === LEDGER_REL_PATH) continue;
    const localFile = local.get(relPath);

    if (!localFile) {
      toDownload.push({ key, relPath, size: obj.size });
      continue;
    }

    const content = localContents?.get(relPath);
    if (content === undefined) {
      // No bytes available → fall back to the historical metadata-only rule
      // (size difference), never a fabricated identity.
      if (localFile.size !== obj.size) {
        toDownload.push({ key, relPath, size: obj.size });
      }
      continue;
    }
    if (remoteIdentity(content, manifest?.files?.[relPath], obj) === "same") {
      continue; // provably identical — no repair
    }
    toDownload.push({ key, relPath, size: obj.size });
  }

  return { toUpload, toDownload, skipped, skippedRelPaths };
}

export interface SyncLock {
  path: string;
}

const LOCK_STALE_MS = 10 * 60 * 1000;

/** Acquire a cross-process sync lock (one sync at a time). */
export function acquireLock(namespacesPath: string): SyncLock | null {
  const dir = path.join(namespacesPath, ".s3state");
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, ".lock");
  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    fs.closeSync(fd);
    return { path: lockPath };
  } catch {
    // lock exists — check staleness
    try {
      const raw = fs.readFileSync(lockPath, "utf-8");
      const data = JSON.parse(raw) as { pid: number; ts: number };
      // A lock held by a dead process is broken immediately, regardless of
      // age — a hard-killed sync never releases its lock. Guard on a valid
      // pid first: a corrupt lock (missing/NaN pid) counts as unreadable and
      // keeps the 10-min stale window below.
      if (Number.isInteger(data.pid) && data.pid > 0 && !isPidAlive(data.pid)) {
        fs.unlinkSync(lockPath);
        return acquireLock(namespacesPath);
      }
      if (Date.now() - data.ts > LOCK_STALE_MS) {
        fs.unlinkSync(lockPath);
        return acquireLock(namespacesPath);
      }
      return null;
    } catch {
      return null;
    }
  }
}

export function releaseLock(lock: SyncLock | null): void {
  if (!lock) return;
  try {
    fs.unlinkSync(lock.path);
  } catch {
    // already gone
  }
}

/** Resolve a namespace's absolute path. */
export function namespacePath(namespacesPath: string, ns: string): string {
  return path.resolve(namespacesPath, ns);
}

/**
 * Enumerate the namespaces that exist REMOTELY under the configured prefix.
 *
 * Groups object keys by their first path segment after `<prefix>/` — the
 * namespace name — so a fresh machine can discover what is restorable before
 * anything exists locally. Used by pull mode (bootstrap pull + `sync all
 * pull`); push never needs it.
 */
export async function listRemoteNamespaces(
  client: S3Client,
  cfg: S3Config,
): Promise<string[]> {
  const { listRemoteObjects } = await loadClient();
  const objects = await listRemoteObjects(client, cfg.bucket, `${cfg.prefix}/`);
  const names = new Set<string>();
  for (const key of objects.keys()) {
    const rest = key.slice(cfg.prefix.length + 1); // "<ns>/<relPath>"
    const slash = rest.indexOf("/");
    // Only count keys that carry a namespace segment AND a payload below it —
    // a bare `<prefix>/<ns>` or `<prefix>/<ns>/` (slash at the very end) is
    // not restorable data.
    if (slash > 0 && slash < rest.length - 1) names.add(rest.slice(0, slash));
  }
  return [...names].sort();
}

/**
 * Read every syncable local file's bytes at (approximately) the same moment
 * as the walk — the content side of the S3-GIT-008 identity comparison.
 * Files that vanish mid-read are simply absent (deltas fall back to
 * metadata-only for them, exactly like a vanished walk entry).
 */
export function readLocalContents(
  nsPath: string,
  local: Map<string, LocalFile>,
): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const relPath of local.keys()) {
    try {
      out.set(relPath, fs.readFileSync(path.join(nsPath, relPath)));
    } catch {
      // vanished between walk and read — no identity available
    }
  }
  return out;
}

/**
 * Content identity for a file ALREADY IN HAND (no second disk read): sha256
 * of its bytes plus the ETag the server assigned to those bytes.
 */
function fileContentsIdentity(
  body: Buffer,
  remoteEtag: string | undefined,
): Pick<FileMeta, "sha256" | "etag"> {
  return { sha256: sha256Hex(body), ...(remoteEtag ? { etag: remoteEtag } : {}) };
}

/** Push a single namespace's deltas to S3. */
export async function pushNamespace(
  cfg: S3Config,
  ns: string,
  namespacesPath: string,
  signal?: AbortSignal,
  hooks?: SyncHooks,
): Promise<SyncStats> {
  const start = Date.now();
  const { buildClient, listRemoteObjects, putObject } = await loadClient();
  const client = buildClient(cfg);
  const nsDir = namespacePath(namespacesPath, ns);
  const prefix = `${cfg.prefix}/${ns}/`;

  const [local, remote, manifest] = await Promise.all([
    Promise.resolve(walkLocal(nsDir)),
    listRemoteObjects(client, cfg.bucket, prefix, signal),
    Promise.resolve(loadManifest(namespacesPath, ns)),
  ]);
  const contents = readLocalContents(nsDir, local);

  const deltas = computeDeltas(
    cfg,
    ns,
    local,
    remote,
    manifest,
    contents,
  );
  let uploaded = 0;
  /**
   * S3-GIT-008: the manifest records ONLY files whose bytes are provably on
   * the remote — either uploaded successfully in this pass, or skipped as
   * unchanged-and-confirmed (identical identity + size) against the remote
   * listing. A failed PUT must never be recorded as synced, or the next pass
   * would trust the manifest and skip the retry forever.
   */
  const syncedFiles: Record<string, FileMeta> = {};

  // S3-DEADLINE-001: transfers run in a bounded pool instead of strictly
  // sequentially. Per-object latency (~0.5 s/object to hel1) was the whole
  // RTO while the loops were serial; the pool keeps a fixed number of socket
  // round-trips in flight and reports each completion to the watchdog.
  const toUpload = deltas.toUpload;
  hooks?.plan?.(toUpload.length);
  await runPool(
    toUpload,
    syncConcurrency(),
    async (file) => {
      const content = contents.get(file.relPath);
      let body: Buffer;
      if (content !== undefined) {
        body = content;
      } else {
        try {
          body = fs.readFileSync(path.join(nsDir, file.relPath));
        } catch {
          // File vanished between the walk and the read — the namespace was
          // deleted (or the file removed) mid-push. Skip it SILENTLY: the next
          // pass must not retry it forever, and the ENOENT storm this once
          // produced (98 log lines over auger-pytest ghosts, 2026-09-21/22) is
          // noise, not signal. It is also NOT recorded in the manifest (its
          // bytes could not be confirmed anywhere).
          return;
        }
      }
      const key = remoteKeyFor(cfg, ns, file.relPath);
      try {
        const ext = path.extname(file.relPath).toLowerCase();
        // The PUT's own response ETag is the version token for EXACTLY the
        // bytes just uploaded (the pre-push listing's ETag may be absent or
        // stale for a fresh/changed object). Recording it is what lets later
        // passes prove remote sameness without re-uploading.
        const putEtag = await putObject(
          client,
          cfg.bucket,
          key,
          body,
          CONTENT_TYPES[ext] ?? "application/octet-stream",
          signal,
        );
        uploaded++;
        // Success ONLY here — after the PUT resolved. A failed PUT must never
        // be recorded as synced, or the next pass would trust the manifest and
        // skip the retry forever (S3-GIT-008).
        syncedFiles[file.relPath] = {
          size: file.size,
          mtimeMs: file.mtimeMs,
          ...fileContentsIdentity(body, putEtag),
        };
      } catch (err) {
        // Failed PUT: loud warn, and NOT added to syncedFiles — the next pass
        // retries this object (S3-GIT-008).
        console.warn(
          `[S3] push ${ns}/${file.relPath} failed: ${(err as Error).message}`,
        );
      }
    },
    (done) => hooks?.progress?.(done, toUpload.length),
  );

  // Carry forward previously-synced files that were skipped this pass as
  // unchanged (their bytes are already confirmed on the remote), preserving
  // their recorded identity.
  for (const relPath of deltas.skippedRelPaths) {
    const prev = manifest?.files?.[relPath];
    const f = local.get(relPath);
    if (prev && f) {
      syncedFiles[relPath] = {
        size: f.size,
        mtimeMs: f.mtimeMs,
        ...(prev.sha256 !== undefined ? { sha256: prev.sha256 } : {}),
        ...(prev.etag !== undefined ? { etag: prev.etag } : {}),
      };
    }
  }

  saveManifest(makeManifest(ns, syncedFiles), namespacesPath);

  // S3-PULL-INTEGRITY-001: publish the identity record next to the data, so a
  // restore onto an empty machine has something to verify against. A push that
  // cannot publish it is a FAILED push: the objects would be restorable but
  // unverifiable, and the next pull would say so at the worst possible time.
  const failures: SyncFailure[] = [];
  let checksumLedger: "pushed" | "absent" = "absent";
  const key = ledgerKey(cfg, ns);
  try {
    const payload = Buffer.from(
      JSON.stringify(buildLedger(ns, syncedFiles)),
      "utf-8",
    );
    await putObject(client, cfg.bucket, key, payload, "application/json", signal);
    checksumLedger = "pushed";
  } catch (err) {
    const detail = (err as Error).message;
    failures.push({
      ns,
      key,
      relPath: LEDGER_REL_PATH,
      kind: "transfer",
      detail,
    });
    console.error(
      `[S3] push ${ns}: checksum ledger NOT published (${detail}) — the namespace is restorable but its restore cannot be verified`,
    );
  }

  return {
    ns,
    direction: "push",
    uploaded,
    downloaded: 0,
    skipped: deltas.skipped,
    durationMs: Date.now() - start,
    verified: 0,
    unverified: 0,
    unverifiedKeys: [],
    failed: failures.length,
    failures,
    checksumLedger,
  };
}

/**
 * S3-PULL-INTEGRITY-001: per-object messages are throttled. A bulk corruption
 * (or a large pre-ledger restore) can touch hundreds of thousands of objects;
 * one line each would bury the summary that says what happened. The COUNTS in
 * SyncStats are never throttled — only the printed lines.
 */
const MAX_OBJECT_LINES = 20;
let objectFailureLines = 0;
let objectUnverifiedLines = 0;

function logObjectFailure(message: string): void {
  objectFailureLines += 1;
  if (objectFailureLines <= MAX_OBJECT_LINES) {
    console.error(`[S3] pull ${message}`);
    if (objectFailureLines === MAX_OBJECT_LINES) {
      console.error(
        `[S3] pull: further per-object failure lines suppressed after ${MAX_OBJECT_LINES}; the summary counts and the full failure list are authoritative`,
      );
    }
  }
}

function logObjectUnverified(message: string): void {
  objectUnverifiedLines += 1;
  if (objectUnverifiedLines <= MAX_OBJECT_LINES) {
    console.warn(`[S3] pull ${message}`);
    if (objectUnverifiedLines === MAX_OBJECT_LINES) {
      console.warn(
        `[S3] pull: further per-object unverified lines suppressed after ${MAX_OBJECT_LINES}; the summary count is authoritative`,
      );
    }
  }
}

/** Reset the throttles (tests run many pulls in one process). */
export function resetPullLogThrottle(): void {
  objectFailureLines = 0;
  objectUnverifiedLines = 0;
}

/**
 * Pull a single namespace's missing/changed files from S3.
 *
 * S3-GIT-008: the delta decision carries content identity, so a same-length
 * remote update is repaired instead of being silently equated with the
 * (possibly corrupted) local copy. The saved manifest records the sha256 of
 * the bytes actually on disk after the pull.
 */
export async function pullNamespace(
  cfg: S3Config,
  ns: string,
  namespacesPath: string,
  signal?: AbortSignal,
  hooks?: SyncHooks,
): Promise<SyncStats> {
  const start = Date.now();
  // Each pull gets its own throttle window (the counters are module-global so
  // the parallel pool can share them; a long-lived daemon must not run out).
  resetPullLogThrottle();
  const { buildClient, listRemoteObjects, getObject } = await loadClient();
  const client = buildClient(cfg);
  const nsDir = namespacePath(namespacesPath, ns);
  const prefix = `${cfg.prefix}/${ns}/`;

  const [local, remote, manifest, ledger] = await Promise.all([
    Promise.resolve(walkLocal(nsDir)),
    listRemoteObjects(client, cfg.bucket, prefix, signal),
    // S3-GIT-008: the pull comparison needs the previously recorded ETags
    // (version tokens) to prove which remote objects are untouched.
    Promise.resolve(loadManifest(namespacesPath, ns)),
    // S3-PULL-INTEGRITY-001: the published identity record is the authority a
    // fresh machine otherwise lacks. Missing ledger = restore unverified (and
    // said so); unreadable ledger = same, but loudly.
    (async (): Promise<ChecksumLedger | null> => {
      const key = ledgerKey(cfg, ns);
      let raw: Buffer;
      try {
        raw = await getObject(client, cfg.bucket, key, signal);
      } catch (err) {
        const message = (err as Error).message;
        const missing = /\b(NoSuchKey|not exist|NotFound|404)\b/i.test(message);
        if (!missing) {
          console.warn(
            `[S3] pull ${ns}: checksum ledger unreadable (${message}) — downloaded bytes cannot be verified against our own record`,
          );
        }
        return null;
      }
      const parsed = parseLedger(raw, ns);
      if (!parsed) {
        console.error(
          `[S3] pull ${ns}: checksum ledger at ${key} is not a usable ledger (${raw.length} bytes) — downloaded bytes cannot be verified against our own record`,
        );
      }
      return parsed;
    })(),
  ]);
  const contents = readLocalContents(nsDir, local);
  const deltas = computeDeltas(cfg, ns, local, remote, manifest, contents);
  let downloaded = 0;
  /** relPaths whose bytes were written to disk this pass. */
  const repaired = new Set<string>();

  const toDownload = deltas.toDownload;
  hooks?.plan?.(toDownload.length);
  // S3-PULL-INTEGRITY-001: counters the caller can act on. A pull used to
  // report only `downloaded`, so a rejected/corrupt object was invisible in
  // the summary and the CLI said "0 failed".
  const failures: SyncFailure[] = [];
  const unverifiedKeys: string[] = [];
  let verified = 0;
  let unverified = 0;

  await runPool(
    toDownload,
    syncConcurrency(),
    async (item) => {
      let body: Buffer;
      try {
        body = await getObject(client, cfg.bucket, item.key, signal);
      } catch (err) {
        const detail = (err as Error).message;
        failures.push({
          ns,
          key: item.key,
          relPath: item.relPath,
          kind: "transfer",
          detail,
        });
        logObjectFailure(
          `${ns}/${item.relPath} FAILED (transfer): ${detail} [key ${item.key}]`,
        );
        return;
      }

      // Verify BEFORE the write: the point of the check is that corrupt bytes
      // never reach the restored tree, so there is nothing to clean up after a
      // rejection and no window in which a reader sees them.
      const prev = manifest?.files?.[item.relPath];
      const ledgerEntry = ledger?.files?.[item.relPath];
      const verdict = verifyDownloadedObject(body, {
        etag: remote.get(item.key)?.etag,
        size: remote.get(item.key)?.size ?? item.size,
        ...(ledgerEntry?.sha256 !== undefined
          ? { ledgerSha256: ledgerEntry.sha256 }
          : {}),
        ...(prev?.sha256 !== undefined ? { manifestSha256: prev.sha256 } : {}),
        ...(prev?.etag !== undefined ? { manifestEtag: prev.etag } : {}),
      });

      if (verdict.kind === "mismatch") {
        failures.push({
          ns,
          key: item.key,
          relPath: item.relPath,
          kind: "verification",
          detail: `${verdict.evidence}: ${verdict.detail}`,
        });
        const existing = fs.existsSync(path.join(nsDir, item.relPath))
          ? " (existing local file left untouched)"
          : "";
        logObjectFailure(
          `${ns}/${item.relPath} FAILED (integrity): ${verdict.evidence}: ${verdict.detail} — corrupt bytes NOT written${existing} [key ${item.key}]`,
        );
        return;
      }

      const dest = path.join(nsDir, item.relPath);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, body);
      downloaded++;
      repaired.add(item.relPath);
      if (verdict.kind === "verified") {
        verified++;
      } else {
        unverified++;
        unverifiedKeys.push(item.key);
        logObjectUnverified(
          `${ns}/${item.relPath} restored UNVERIFIED: ${verdict.reason} [key ${item.key}]`,
        );
      }
    },
    (done) => hooks?.progress?.(done, toDownload.length),
  );

  if (failures.length > 0) {
    console.error(
      `[S3] pull ${ns}: ${failures.length} object(s) NOT restored (${downloaded} restored, ${verified} verified, ${unverified} unverified)`,
    );
  }
  if (unverified > 0) {
    console.warn(
      `[S3] pull ${ns}: ${unverified} object(s) restored with NO checksum evidence (fresh machine / multipart ETag / legacy record) — bytes are trusted, not proven`,
    );
  }

  /**
   * S3-GIT-008 manifest refresh. The saved manifest now carries content
   * identity (sha256 of the bytes actually on disk — including every
   * repaired file) plus, per remote object, the ETag OBSERVED AT LIST TIME
   * for the bytes we just verified. A file whose download FAILED this pass
   * keeps its PREVIOUS manifest entry verbatim (or stays absent) — never
   * marked synced against bytes we could not obtain.
   */
  const fresh = walkLocal(nsDir);
  const freshContents = readLocalContents(nsDir, fresh);
  const files: Record<string, FileMeta> = {};
  // S3-PULL-INTEGRITY-001: a path whose object we REFUSED must not be
  // re-identified from whatever local bytes happen to be on disk — that would
  // bless corrupt content as synced and let a later pass skip the repair.
  const rejected = new Set(failures.map((f) => f.relPath));
  for (const [relPath, f] of fresh) {
    const bytes = freshContents.get(relPath);
    const key = `${prefix}${relPath}`;
    const listedEtag = remote.get(key)?.etag;
    const prev = manifest?.files?.[relPath];
    if (rejected.has(relPath)) {
      if (prev) files[relPath] = prev;
      continue;
    }
    files[relPath] = {
      size: f.size,
      mtimeMs: f.mtimeMs,
      ...(bytes ? { sha256: sha256Hex(bytes) } : {}),
      // For repaired files the listed ETag corresponds to the (freshly
      // verified) remote bytes. For untouched files keep the previously
      // recorded token; for files that FAILED to download the stale listed
      // ETag must NOT be adopted — keep the previous entry's token so the
      // next pass re-examines the object.
      ...(repaired.has(relPath)
        ? listedEtag
          ? { etag: listedEtag }
          : {}
        : prev?.etag !== undefined
          ? { etag: prev.etag }
          : {}),
    };
  }
  saveManifest(makeManifest(ns, files), namespacesPath);

  return {
    ns,
    direction: "pull",
    uploaded: 0,
    downloaded,
    skipped: deltas.skipped,
    durationMs: Date.now() - start,
    verified,
    unverified,
    unverifiedKeys,
    failed: failures.length,
    failures,
    checksumLedger: ledger ? "present" : "absent",
  };
}

/**
 * No-progress window (seconds) for ONE namespace. Default 300s; override with
 * S3_SYNC_NAMESPACE_DEADLINE_S. S3-GIT-007: a namespace whose push/pull never
 * resolves (e.g. an SDK call stuck in epoll) used to hang the whole sync-all
 * pass until the cron watchdog killed the process ~2h later, then the next
 * run cleared the stale lock and repeated the hang.
 *
 * S3-DEADLINE-001: this value is the STALL window and the deadline FLOOR, not
 * a total wall-clock cap. Used as a cap it was arithmetically impossible for
 * any namespace above ~560 objects (300s / 0.53 s per object measured against
 * Hetzner hel1) to ever complete — six live namespaces are far above that, so
 * "backed up nightly" was false for all of them. What a watchdog actually has
 * to catch is a run that stopped making progress, so the stall window is
 * re-armed on every completed object and the total allowance is derived from
 * the work (`syncDeadlineBudgetSeconds`).
 */
export function namespaceDeadlineSeconds(): number {
  const raw = process.env.S3_SYNC_NAMESPACE_DEADLINE_S;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 300;
}

/**
 * Measured serial transfer cost against Hetzner hel1 from one vCPU
 * (BACKUP-RESTORE-PROOF-001, 2026-11-05): 0.535 s/object push, 0.449 s/object
 * pull. The deadline budget is derived from this, so it scales with the work
 * instead of assuming every namespace looks like the one that was measured.
 */
export const MEASURED_SECONDS_PER_OBJECT = 0.53;

/**
 * Headroom over the measured cost. A restore over a slower link (a fresh
 * machine on hotel wifi) is a legitimate slow run, not a stuck one; 3x still
 * bounds a pathological namespace to hours, and the stall watchdog — not this
 * budget — is what catches a hang.
 */
const DEADLINE_BUDGET_HEADROOM = 3;

/**
 * Total per-namespace allowance (seconds) for a transfer of `workItems`
 * objects: the stall window as a floor plus the measured cost of the work,
 * with headroom. `scheduler` (258,672 syncable objects) therefore gets
 * ~114h instead of 300s; `chat-archive` (617) gets ~1,281s.
 */
export function syncDeadlineBudgetSeconds(
  workItems: number,
  stallSeconds: number = namespaceDeadlineSeconds(),
): number {
  const items = Number.isFinite(workItems) && workItems > 0 ? workItems : 0;
  return Math.max(
    stallSeconds,
    Math.ceil(stallSeconds + items * MEASURED_SECONDS_PER_OBJECT * DEADLINE_BUDGET_HEADROOM),
  );
}

/**
 * Objects transferred in parallel. The engine was strictly sequential, which
 * made the per-object latency the whole RTO: 8 sockets turns chat-archive's
 * 4.6 min restore into ~1 min on the same link. Override with
 * S3_SYNC_CONCURRENCY (clamped 1..32, default 8).
 */
export function syncConcurrency(): number {
  const raw = process.env.S3_SYNC_CONCURRENCY;
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isFinite(parsed) || parsed < 1) return 8;
  return Math.min(32, Math.floor(parsed));
}

/**
 * The two conditions a per-namespace watchdog has to enforce, tracked
 * separately because they mean different things:
 *  - STALL: nothing completed for `stallSeconds` → the transfer is stuck
 *    (S3-GIT-007's epoll hang, a black-holed endpoint). Aborts fast.
 *  - BUDGET: total elapsed exceeded the work-derived allowance → the run is
 *    progressing absurdly slowly. Aborts, but only after a compute-derived
 *    window, so it can no longer kill an honest large namespace.
 *
 * Both abort the in-flight SDK calls before the lock is released, and both
 * name the namespace and the progress made, because "sync deadline exceeded
 * after 300s" without a namespace is not an actionable error.
 */
export class NamespaceDeadline {
  /** The stall window timer — re-armed on every completed object. */
  private stallTimer: NodeJS.Timeout | undefined;
  /** The work-derived total allowance timer — armed once, never re-armed. */
  private budgetTimer: NodeJS.Timeout | undefined;
  private settled = false;
  private rejectFn!: (err: Error) => void;
  private total = 0;
  private done = 0;
  private startedAt = Date.now();
  /** Aborted when either condition fires, so the SDK cancels in-flight I/O. */
  readonly controller = new AbortController();
  /** Rejects (never resolves) when the namespace is out of time. */
  readonly failure: Promise<never>;

  constructor(
    private readonly ns: string,
    private readonly stallSeconds: number = namespaceDeadlineSeconds(),
    private readonly onTimeout: (seconds: number) => void = () => undefined,
  ) {
    this.failure = new Promise<never>((_, reject) => {
      this.rejectFn = reject;
    });
    this.armStall();
  }

  /** The number of objects to transfer is known — start the budget clock. */
  plan(total: number): void {
    if (this.settled) return;
    this.total = total;
    const budget = syncDeadlineBudgetSeconds(total, this.stallSeconds);
    this.budgetTimer = this.arm(
      setTimeout(() => {
        this.fire(budget, `budget ${budget}s exhausted; ${this.done}/${this.total} objects`);
      }, budget * 1000),
    );
  }

  /** One object finished (success or failure) — the transfer is alive. */
  progress(done: number, total?: number): void {
    if (this.settled) return;
    this.done = done;
    if (total !== undefined) this.total = total;
    this.armStall();
  }

  /** Stop the clocks. Call from a `finally` — a late fire must be a no-op. */
  dispose(): void {
    this.settled = true;
    if (this.stallTimer) clearTimeout(this.stallTimer);
    if (this.budgetTimer) clearTimeout(this.budgetTimer);
    this.stallTimer = undefined;
    this.budgetTimer = undefined;
  }

  private armStall(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = this.arm(
      setTimeout(() => {
        this.fire(
          this.stallSeconds,
          `no progress for ${this.stallSeconds}s; ${this.done}/${this.total} objects transferred, ${Math.round((Date.now() - this.startedAt) / 1000)}s elapsed`,
        );
      }, this.stallSeconds * 1000),
    );
  }

  private arm(t: NodeJS.Timeout): NodeJS.Timeout {
    t.unref(); // don't hold the process open
    return t;
  }

  private fire(seconds: number, detail: string): void {
    if (this.settled) return;
    this.settled = true;
    if (this.stallTimer) clearTimeout(this.stallTimer);
    if (this.budgetTimer) clearTimeout(this.budgetTimer);
    this.stallTimer = undefined;
    this.budgetTimer = undefined;
    this.controller.abort(); // cancel in-flight SDK calls
    this.onTimeout(seconds);
    this.rejectFn(
      new Error(`sync deadline exceeded after ${seconds}s for namespace ${this.ns} (${detail})`),
    );
  }
}

/**
 * Hooks the engine reports its plan and its progress through. The deadline
 * needs the object count to derive a budget, and needs a heartbeat per object
 * to tell "slow" from "stuck".
 */
export interface SyncHooks {
  /** Number of objects this namespace will transfer. */
  plan?: (total: number) => void;
  /** Completed transfers so far (successes + failures). */
  progress?: (done: number, total: number) => void;
}

/**
 * Run `worker` over `items` with at most `limit` in flight, preserving the
 * per-item error isolation the sequential loops had (a worker failure is the
 * worker's own business). Progress is reported once per completed item.
 */
async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
  onDone?: (done: number) => void,
): Promise<void> {
  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  let done = 0;
  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      try {
        await worker(items[index]);
      } finally {
        done++;
        onDone?.(done);
      }
    }
  });
  await Promise.all(runners);
}

/** Sync one namespace in the given direction (guarded by config + lock). */
export async function syncNamespace(
  cfg: S3Config,
  ns: string,
  namespacesPath: string,
  direction: "push" | "pull" = "push",
): Promise<SyncStats | null> {
  if (!cfg.enabled) {
    console.warn("[S3] sync skipped: s3.enabled is false");
    return null;
  }
  const nsDir = namespacePath(namespacesPath, ns);
  if (!fs.existsSync(nsDir)) {
    // Pull BOOTSTRAPS a namespace missing locally (fresh-machine DR restore
    // — DF-0925-07): the remote prefix is the source of truth, so the dir is
    // created and the pull proceeds. Push keeps the hard throw — there is
    // nothing local to push. Bootstrap is a DATA restore only: it never
    // touches the config namespaceMappings registry, and the pulled namespace
    // arrives without git history (see README "Fresh-machine DR restore").
    if (direction === "push") {
      throw new Error(`Namespace not found: ${ns}`);
    }
    fs.mkdirSync(nsDir, { recursive: true });
  }
  const lock = acquireLock(namespacesPath);
  if (!lock) {
    throw new Error("[S3] another sync is in progress (lock held)");
  }
  // S3-DEADLINE-001: the watchdog's signal is threaded through to every SDK
  // call so a timeout cancels the in-flight I/O before the lock is released
  // (S3-GIT-007), and the engine reports its plan + per-object progress back
  // so the stall window measures "stopped moving" instead of wall clock.
  const deadline = new NamespaceDeadline(ns, namespaceDeadlineSeconds(), (s) => {
    console.warn(`[S3] sync ${ns} timed out after ${s}s (S3-GIT-007)`);
  });
  try {
    const hooks: SyncHooks = {
      plan: (total) => deadline.plan(total),
      progress: (done, total) => deadline.progress(done, total),
    };
    const innerPromise =
      direction === "push"
        ? pushNamespace(cfg, ns, namespacesPath, deadline.controller.signal, hooks)
        : pullNamespace(cfg, ns, namespacesPath, deadline.controller.signal, hooks);
    // Losing the race means the transfer is being aborted; its own rejection
    // must not surface as an unhandled rejection.
    innerPromise.catch(() => undefined);
    return await Promise.race([innerPromise, deadline.failure]);
  } finally {
    deadline.dispose();
    releaseLock(lock);
  }
}

/**
 * Aggregate outcome of one `sync all` pass (S3-CLI-001).
 *
 * A per-namespace failure used to be swallowed by the loop (one `console.warn`)
 * while the pass still returned its successes, so the CLI printed "complete"
 * and exited 0 after a partial push/pull. The aggregate makes the failure count
 * a first-class result: callers can report it and exit nonzero.
 *
 * `attempted` counts every namespace the pass tried; `succeeded` counts the
 * ones that returned without throwing (a namespace whose sync is inert because
 * s3 is disabled yields no stats but is NOT a failure); `failed` counts the
 * throws, each captured in `failures` with its namespace name and message.
 */
export interface SyncAllResult {
  /** Per-namespace stats for the namespaces that completed (unchanged shape). */
  stats: SyncStats[];
  attempted: number;
  succeeded: number;
  failed: number;
  failures: { namespace: string; error: string }[];
}

/**
 * Sync every namespace dir under namespacesPath and return the AGGREGATE
 * outcome — successes, failure count, and every per-namespace error.
 *
 * S3-CLI-001: failures are still non-fatal for the pass (one broken namespace
 * must not abort the rest), but they are now RETURNED instead of only warned,
 * so `s3 sync all` can exit nonzero. Callers that only need the stats can use
 * `syncAllNamespaces` (the stats-only wrapper).
 */
export async function syncAllNamespacesResult(
  cfg: S3Config,
  namespacesPath: string,
  direction: "push" | "pull" = "push",
): Promise<SyncAllResult> {
  const stats: SyncStats[] = [];
  const failures: { namespace: string; error: string }[] = [];
  let localEntries: string[] = [];
  try {
    localEntries = fs
      .readdirSync(namespacesPath, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch (err) {
    // A missing namespaces ROOT is the fresh-machine restore case for pull
    // (syncNamespace bootstraps root + namespace via mkdir -p). Push has
    // nothing to push without a root — keep that failure loud (rethrow).
    if (direction === "push") throw err;
  }

  let nsList = localEntries;
  if (direction === "pull") {
    // Pull enumerates the REMOTE prefix (a fresh machine has no local dirs to
    // iterate — the old local-only walk reported "0 namespaces" while
    // restoring nothing) and unions with local ones so an `all pull` also
    // refreshes namespaces that exist on both sides.
    const { buildClient } = await loadClient();
    const client = buildClient(cfg);
    const remoteNames = await listRemoteNamespaces(client, cfg);
    nsList = [...new Set([...remoteNames, ...localEntries])].sort();
  }

  for (const ns of nsList) {
    try {
      const nsStats = await syncNamespace(cfg, ns, namespacesPath, direction);
      if (nsStats) stats.push(nsStats);
      // S3-PULL-INTEGRITY-001: per-OBJECT restore failures are namespace
      // failures. Before this they only reached a console.warn inside
      // pullNamespace, so `sync all pull` counted the namespace as succeeded
      // and the CLI printed "0 failed" over a corrupt restore.
      if (nsStats && nsStats.failed > 0) {
        const first = nsStats.failures[0];
        failures.push({
          namespace: ns,
          error: `${nsStats.failed} object(s) not restored — first: ${first.key} (${first.kind}: ${first.detail})`,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ namespace: ns, error: message });
      console.warn(`[S3] sync ${ns} failed: ${message}`);
    }
  }
  return {
    stats,
    attempted: nsList.length,
    succeeded: nsList.length - failures.length,
    failed: failures.length,
    failures,
  };
}

/**
 * Sync every namespace dir under namespacesPath — stats-only view.
 *
 * Kept for existing callers/tests that only consume the per-namespace stats;
 * new code that must react to failures should use `syncAllNamespacesResult`.
 */
export async function syncAllNamespaces(
  cfg: S3Config,
  namespacesPath: string,
  direction: "push" | "pull" = "push",
): Promise<SyncStats[]> {
  return (await syncAllNamespacesResult(cfg, namespacesPath, direction)).stats;
}
