/**
 * Per-namespace sync state (manifest).
 *
 * Stored OUTSIDE the namespace git repos (never committed): one JSON file per
 * namespace under `<namespacesPath>/.s3state/`. Tracks the last-known local
 * size + mtime per relative path so incremental syncs only touch changed files.
 */

import fs from "fs";
import path from "path";

export interface FileMeta {
  size: number;
  mtimeMs: number;
  /**
   * S3-GIT-008: sha256 (hex) of the file bytes at the last successful sync.
   * Optional so manifests written before this field existed still load; a
   * manifest without identities converges to hashed ones as files are
   * successfully pushed/pulled (metadata-only skips never FABRICATE one —
   * that would bless possibly-corrupted bytes as synced).
   */
  sha256?: string;
  /**
   * S3-GIT-008: the remote object's ETag as observed at the last successful
   * transfer. Used as a version token (NOT a checksum — multipart ETags are
   * not md5): when the listed ETag differs from the recorded one, the object
   * was rewritten since our last sync and must be re-examined, even when the
   * new ETag carries no usable checksum.
   */
  etag?: string;
}

export interface S3SyncManifest {
  version: 1;
  ns: string;
  lastSyncAt: string;
  /** relPath (e.g. "event/2026-08/current.jsonl") → local metadata at last sync */
  files: Record<string, FileMeta>;
}

export const MANIFEST_VERSION = 1 as const;

export function stateDir(namespacesPath: string): string {
  return path.join(namespacesPath, ".s3state");
}

export function manifestFilePath(namespacesPath: string, ns: string): string {
  return path.join(stateDir(namespacesPath), `${ns}.json`);
}

export function loadManifest(
  namespacesPath: string,
  ns: string,
): S3SyncManifest | null {
  try {
    const raw = fs.readFileSync(manifestFilePath(namespacesPath, ns), "utf-8");
    const parsed = JSON.parse(raw) as S3SyncManifest;
    if (parsed.version !== MANIFEST_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveManifest(
  manifest: S3SyncManifest,
  namespacesPath: string,
): void {
  const dir = stateDir(namespacesPath);
  fs.mkdirSync(dir, { recursive: true });
  const file = manifestFilePath(namespacesPath, manifest.ns);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}

export function makeManifest(
  ns: string,
  files: Record<string, FileMeta>,
): S3SyncManifest {
  return {
    version: MANIFEST_VERSION,
    ns,
    lastSyncAt: new Date().toISOString(),
    files,
  };
}

/**
 * Remove a namespace's sync manifest (i.e. stop all scheduled pushes for it).
 *
 * Lives here, not in namespaces/lifecycle, so the shared deletion core
 * (src/namespaces/delete.ts) can import it without an import cycle. Returns
 * true when a manifest file existed and was removed.
 */
export function pruneSyncManifest(namespacesPath: string, ns: string): boolean {
  const file = manifestFilePath(namespacesPath, ns);
  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      return true;
    }
  } catch {
    // best-effort; callers surface removal through their own audit trail
  }
  return false;
}
