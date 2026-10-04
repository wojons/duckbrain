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

/**
 * Cooperative per-namespace deadline handed down by syncNamespace: the
 * push/pull loops poll isAborted() BETWEEN file operations so an abandoned
 * namespace stops cleanly (manifest saved, partial progress durable) instead
 * of lingering as a zombie that keeps the process alive after the run.
 */
export interface NamespaceDeadline {
  timeoutMs: number;
  isAborted: () => boolean;
}

/** Error thrown when a namespace outlives its deadline (S3-ALERT-002). */
export class NamespaceSyncDeadlineError extends Error {
  constructor(ns: string, timeoutMs: number, done: number, total: number) {
    super(
      `[S3] ${ns} exceeded its ${Math.round(timeoutMs / 1000)}s deadline after ${done}/${total} files (partial progress saved; sync abandoned)`,
    );
    this.name = "NamespaceSyncDeadlineError";
  }
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

/** Push a single namespace's deltas to S3. */
export async function pushNamespace(
  cfg: S3Config,
  ns: string,
  namespacesPath: string,
  deadline?: NamespaceDeadline,
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
    if (deadline?.isAborted()) {
      // S3-ALERT-002: stop BETWEEN files so the manifest below persists the
      // partial progress and the namespace stops CLEANLY (no zombie uploads
      // holding the process open after the pass moves on).
      saveManifest(makeManifest(ns, manifestFromLocal(local)), namespacesPath);
      throw new NamespaceSyncDeadlineError(
        ns,
        deadline.timeoutMs,
        uploaded,
        deltas.toUpload.length,
      );
    }
    let body: Buffer;
    try {
      body = fs.readFileSync(path.join(nsDir, file.relPath));
    } catch {
      // File vanished between the walk and the read — the namespace was
      // deleted (or the file removed) mid-push. Skip it SILENTLY: the next
      // pass must not retry it forever, and the ENOENT storm this once
      // produced (98 log lines over auger-pytest ghosts, 2026-09-21/22) is
      // noise, not signal. The manifest is refreshed from the CURRENT walk
      // below, so the vanished file also drops out of future deltas.
      continue;
    }
    try {
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

  saveManifest(makeManifest(ns, manifestFromLocal(local)), namespacesPath);

  return {
    ns,
    direction: "push",
    uploaded,
    downloaded: 0,
    skipped: deltas.skipped,
    durationMs: Date.now() - start,
  };
}

/** Build the manifest files-record from a walkLocal result. */
function manifestFromLocal(
  local: Map<string, LocalFile>,
): Record<string, FileMeta> {
  const files: Record<string, FileMeta> = {};
  for (const [relPath, f] of local) {
    files[relPath] = { size: f.size, mtimeMs: f.mtimeMs };
  }
  return files;
}

/** Pull a single namespace's missing/changed files from S3. */
export async function pullNamespace(
  cfg: S3Config,
  ns: string,
  namespacesPath: string,
  deadline?: NamespaceDeadline,
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
    if (deadline?.isAborted()) {
      throw new NamespaceSyncDeadlineError(
        ns,
        deadline.timeoutMs,
        downloaded,
        deltas.toDownload.length,
      );
    }
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
  saveManifest(makeManifest(ns, manifestFromLocal(fresh)), namespacesPath);

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
  opts?: { timeoutMs?: number },
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
  const timeoutMs =
    opts?.timeoutMs !== undefined ? opts.timeoutMs : namespaceDeadlineMs();
  const body = async (): Promise<SyncStats> => {
    // Cooperative deadline: the loops poll this between files, so an
    // abandoned namespace stops cleanly (partial progress saved) instead of
    // lingering as a zombie that keeps the process alive after the run.
    const startMs = Date.now();
    const deadline: NamespaceDeadline | undefined =
      timeoutMs > 0
        ? {
            timeoutMs,
            isAborted: () => Date.now() - startMs >= timeoutMs,
          }
        : undefined;
    return direction === "push"
      ? pushNamespace(cfg, ns, namespacesPath, deadline)
      : pullNamespace(cfg, ns, namespacesPath, deadline);
  };
  try {
    // S3-ALERT-002 backstop: the cooperative checks above abort BETWEEN file
    // operations; this wall-clock race also bounds a stall INSIDE one
    // operation (e.g. a request that ignores its socket timeout). The losing
    // branch may still run to completion in the background — that is what
    // the cooperative path is for.
    if (timeoutMs > 0) {
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>(
        (_, reject) =>
          (timer = setTimeout(
            () =>
              reject(
                new Error(
                  `[S3] ${ns} exceeded its ${Math.round(timeoutMs / 1000)}s deadline (sync abandoned mid-flight)`,
                ),
              ),
            timeoutMs,
          )),
      );
      try {
        return await Promise.race([body(), deadline]);
      } finally {
        clearTimeout(timer);
      }
    }
    return await body();
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
  const detailed = await syncAllNamespacesDetailed(
    cfg,
    namespacesPath,
    direction,
  );
  return detailed.stats;
}

export interface SyncFailure {
  ns: string;
  error: string;
}

export interface SyncAllResult {
  stats: SyncStats[];
  failures: SyncFailure[];
}

/**
 * Per-namespace deadline for `sync all`, in ms.
 *
 * Read once per run from S3_SYNC_ALL_DEADLINE_S (whole seconds; 0 disables).
 * Same env knob the cron wrapper uses for its whole-run `timeout` — the
 * per-namespace deadline keeps every run comfortably inside the wrapper's.
 */
export function namespaceDeadlineMs(): number {
  const raw = process.env.S3_SYNC_ALL_DEADLINE_S;
  if (raw === undefined || raw === "") return 1_800_000;
  const s = Number.parseInt(raw, 10);
  if (!Number.isInteger(s) || s < 0) return 1_800_000;
  return s * 1000;
}

/**
 * Sync every namespace dir under namespacesPath, reporting failures.
 *
 * S3-ALERT-002: the old loop awaited each namespace with NO per-namespace
 * bound, so one huge/stuck namespace pinned the whole pass (measured: a
 * ~46k-file `scheduler` delta outlived every 3600s wrapper run). Each
 * namespace now races a per-ns wall-clock deadline; a namespace that
 * exceeds it is abandoned (its lock is released in syncNamespace's
 * finally), logged LOUDLY with its name, and the pass CONTINUES. Callers
 * get every failed namespace by name + error so the exit can reflect them.
 */
export async function syncAllNamespacesDetailed(
  cfg: S3Config,
  namespacesPath: string,
  direction: "push" | "pull" = "push",
  opts?: { perNsTimeoutMs?: number },
): Promise<SyncAllResult> {
  const out: SyncStats[] = [];
  const failures: SyncFailure[] = [];
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
    const client = buildClient(cfg);
    const remoteNames = await listRemoteNamespaces(client, cfg);
    nsList = [...new Set([...remoteNames, ...localEntries])].sort();
  }

  for (const ns of nsList) {
    try {
      const stats = await syncNamespace(cfg, ns, namespacesPath, direction, {
        timeoutMs: opts?.perNsTimeoutMs,
      });
      if (stats) out.push(stats);
    } catch (err) {
      const message = (err as Error).message;
      console.warn(`[S3] sync ${ns} failed: ${message}`);
      failures.push({ ns, error: message });
    }
  }
  return { stats: out, failures };
}
