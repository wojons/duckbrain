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
