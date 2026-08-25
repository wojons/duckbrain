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
import {
  buildClient,
  listRemoteObjects,
  putObject,
  getObject,
  type RemoteObject,
} from "./client";
import {
  loadManifest,
  saveManifest,
  makeManifest,
  type S3SyncManifest,
  type FileMeta,
} from "./manifest";
import type { S3Config } from "./config";
import { isPidAlive } from "../utils/pidfile";

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
}

/**
 * Compute push/pull deltas from local walk + remote listing + last manifest.
 * Pure function (unit-tested offline).
 */
export function computeDeltas(
  cfg: S3Config,
  ns: string,
  local: Map<string, LocalFile>,
  remote: Map<string, RemoteObject>,
  manifest: S3SyncManifest | null,
): SyncDeltas {
  const prefix = `${cfg.prefix}/${ns}/`;
  const toUpload: LocalFile[] = [];
  const toDownload: { key: string; relPath: string; size: number }[] = [];
  let skipped = 0;

  for (const [relPath, file] of local) {
    const key = `${prefix}${relPath}`;
    const remoteObj = remote.get(key);
    const prev = manifest?.files?.[relPath];
    const localUnchanged =
      prev !== undefined &&
      prev.size === file.size &&
      prev.mtimeMs === file.mtimeMs;
    if (localUnchanged && remoteObj && remoteObj.size === file.size) {
      skipped++;
    } else {
      toUpload.push(file);
    }
  }

  for (const [key, obj] of remote) {
    if (!key.startsWith(prefix)) continue;
    const relPath = key.slice(prefix.length);
    const localFile = local.get(relPath);
    if (!localFile || localFile.size !== obj.size) {
      toDownload.push({ key, relPath, size: obj.size });
    }
  }

  return { toUpload, toDownload, skipped };
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

/** Push a single namespace's deltas to S3. */
export async function pushNamespace(
  cfg: S3Config,
  ns: string,
  namespacesPath: string,
): Promise<SyncStats> {
  const start = Date.now();
  const client = buildClient(cfg);
  const nsDir = namespacePath(namespacesPath, ns);
  const prefix = `${cfg.prefix}/${ns}/`;

  const [local, remote, manifest] = await Promise.all([
    Promise.resolve(walkLocal(nsDir)),
    listRemoteObjects(client, cfg.bucket, prefix),
    Promise.resolve(loadManifest(namespacesPath, ns)),
  ]);

  const deltas = computeDeltas(cfg, ns, local, remote, manifest);
  let uploaded = 0;

  for (const file of deltas.toUpload) {
    try {
      const body = fs.readFileSync(path.join(nsDir, file.relPath));
      const ext = path.extname(file.relPath).toLowerCase();
      await putObject(
        client,
        cfg.bucket,
        remoteKeyFor(cfg, ns, file.relPath),
        body,
        CONTENT_TYPES[ext] ?? "application/octet-stream",
      );
      uploaded++;
    } catch (err) {
      console.warn(
        `[S3] push ${ns}/${file.relPath} failed: ${(err as Error).message}`,
      );
    }
  }

  const files: Record<string, FileMeta> = {};
  for (const [relPath, f] of local) {
    files[relPath] = { size: f.size, mtimeMs: f.mtimeMs };
  }
  saveManifest(makeManifest(ns, files), namespacesPath);

  return {
    ns,
    direction: "push",
    uploaded,
    downloaded: 0,
    skipped: deltas.skipped,
    durationMs: Date.now() - start,
  };
}

/** Pull a single namespace's missing/changed files from S3. */
export async function pullNamespace(
  cfg: S3Config,
  ns: string,
  namespacesPath: string,
): Promise<SyncStats> {
  const start = Date.now();
  const client = buildClient(cfg);
  const nsDir = namespacePath(namespacesPath, ns);
  const prefix = `${cfg.prefix}/${ns}/`;

  const [local, remote] = await Promise.all([
    Promise.resolve(walkLocal(nsDir)),
    listRemoteObjects(client, cfg.bucket, prefix),
  ]);
  const deltas = computeDeltas(cfg, ns, local, remote, null);
  let downloaded = 0;

  for (const item of deltas.toDownload) {
    try {
      const body = await getObject(client, cfg.bucket, item.key);
      const dest = path.join(nsDir, item.relPath);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, body);
      downloaded++;
    } catch (err) {
      console.warn(
        `[S3] pull ${ns}/${item.relPath} failed: ${(err as Error).message}`,
      );
    }
  }

  // Refresh manifest from the post-pull local state
  const fresh = walkLocal(nsDir);
  const files: Record<string, FileMeta> = {};
  for (const [relPath, f] of fresh) {
    files[relPath] = { size: f.size, mtimeMs: f.mtimeMs };
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
  if (!fs.existsSync(namespacePath(namespacesPath, ns))) {
    throw new Error(`Namespace not found: ${ns}`);
  }
  const lock = acquireLock(namespacesPath);
  if (!lock) {
    throw new Error("[S3] another sync is in progress (lock held)");
  }
  try {
    return direction === "push"
      ? await pushNamespace(cfg, ns, namespacesPath)
      : await pullNamespace(cfg, ns, namespacesPath);
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
  const entries = fs
    .readdirSync(namespacesPath, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name);
  for (const ns of entries) {
    try {
      const stats = await syncNamespace(cfg, ns, namespacesPath, direction);
      if (stats) out.push(stats);
    } catch (err) {
      console.warn(`[S3] sync ${ns} failed: ${(err as Error).message}`);
    }
  }
  return out;
}
