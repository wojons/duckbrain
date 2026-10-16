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

const CONTENT_TYPES: Record<string, string> = {
  ".jsonl": "application/x-ndjson",
  ".json": "application/json",
  ".md": "text/markdown",
  ".txt": "text/plain",
};

export interface SyncStats {
  ns: string;
  direction: "push" | "pull";
  uploaded: number;
  downloaded: number;
  skipped: number;
  durationMs: number;
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

  for (const file of deltas.toUpload) {
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
        continue;
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
  }

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

  return {
    ns,
    direction: "push",
    uploaded,
    downloaded: 0,
    skipped: deltas.skipped,
    durationMs: Date.now() - start,
  };
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
): Promise<SyncStats> {
  const start = Date.now();
  const { buildClient, listRemoteObjects, getObject } = await loadClient();
  const client = buildClient(cfg);
  const nsDir = namespacePath(namespacesPath, ns);
  const prefix = `${cfg.prefix}/${ns}/`;

  const [local, remote, manifest] = await Promise.all([
    Promise.resolve(walkLocal(nsDir)),
    listRemoteObjects(client, cfg.bucket, prefix, signal),
    // S3-GIT-008: the pull comparison needs the previously recorded ETags
    // (version tokens) to prove which remote objects are untouched.
    Promise.resolve(loadManifest(namespacesPath, ns)),
  ]);
  const contents = readLocalContents(nsDir, local);
  const deltas = computeDeltas(cfg, ns, local, remote, manifest, contents);
  let downloaded = 0;
  /** relPaths whose bytes were written to disk this pass. */
  const repaired = new Set<string>();

  for (const item of deltas.toDownload) {
    try {
      const body = await getObject(client, cfg.bucket, item.key, signal);
      const dest = path.join(nsDir, item.relPath);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, body);
      downloaded++;
      repaired.add(item.relPath);
    } catch (err) {
      console.warn(
        `[S3] pull ${ns}/${item.relPath} failed: ${(err as Error).message}`,
      );
    }
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
  for (const [relPath, f] of fresh) {
    const bytes = freshContents.get(relPath);
    const key = `${prefix}${relPath}`;
    const listedEtag = remote.get(key)?.etag;
    const prev = manifest?.files?.[relPath];
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
  };
}

/**
 * Per-namespace wall-clock deadline (seconds). Default 300s; override with
 * S3_SYNC_NAMESPACE_DEADLINE_S. S3-GIT-007: a namespace whose push/pull never
 * resolves (e.g. an SDK call stuck in epoll) used to hang the whole sync-all
 * pass until the cron watchdog killed the process ~2h later, then the next
 * run cleared the stale lock and repeated the hang.
 */
export function namespaceDeadlineSeconds(): number {
  const raw = process.env.S3_SYNC_NAMESPACE_DEADLINE_S;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 300;
}

/**
 * Reject after `seconds` unless `p` settles first — AND abort the
 * underlying HTTP requests so the SDK actually cancels the in-flight
 * I/O instead of leaving a zombie request after the lock is released.
 */
async function withDeadline<T>(
  p: Promise<T>,
  seconds: number,
  onTimeout: (s: number) => void,
): Promise<T> {
  const controller = new AbortController();
  const deadline = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      controller.abort(); // cancel in-flight SDK calls
      onTimeout(seconds);
      reject(new Error(`sync deadline exceeded after ${seconds}s`));
    }, seconds * 1000);
    timer.unref(); // don't prevent process exit
  });
  try {
    return await Promise.race([p, deadline]);
  } finally {
    // timer.unref() above lets the process exit even if this promise never settles;
    // the controller remains alive but the signal is fire-and-forget.
  }
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
  try {
    const deadlineS = namespaceDeadlineSeconds();
    // Create an AbortController that the deadline will fire — this signal
    // is threaded through to every SDK call so a timeout cancels the
    // in-flight I/O before the lock is released (S3-GIT-007 fix).
    const deadlineController = new AbortController();
    const innerPromise =
      direction === "push"
        ? pushNamespace(cfg, ns, namespacesPath, deadlineController.signal)
        : pullNamespace(cfg, ns, namespacesPath, deadlineController.signal);
    const inner = withDeadline(innerPromise, deadlineS, (s) => {
      console.warn(`[S3] sync ${ns} timed out after ${s}s (S3-GIT-007)`);
    });
    return await inner;
  } finally {
    releaseLock(lock);
  }
}

/** Sync every namespace dir under namespacesPath. */
export async function syncAllNamespaces(
  cfg: S3Config,
  namespacesPath: string,
  direction: "push" | "pull" = "push",
): Promise<SyncStats[]> {
  const out: SyncStats[] = [];
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
      const stats = await syncNamespace(cfg, ns, namespacesPath, direction);
      if (stats) out.push(stats);
    } catch (err) {
      console.warn(`[S3] sync ${ns} failed: ${(err as Error).message}`);
    }
  }
  return out;
}
