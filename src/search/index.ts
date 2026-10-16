/**
 * Keyword search index — rebuildable FTS sidecar (RETR-001).
 *
 * Per-namespace cache living at `<namespace>/.search/` (gitignored, never
 * committed — mirror of the `.embeddings` cache doctrine, Q-7). The index
 * is a DuckDB file holding:
 *
 *   - `memories` — the live (non-tombstoned, latest-per-id) memory rows
 *     with a `raw_text` column (key + content + attributes, untouched) and
 *     a `search_text` column (digit-mapped, see transform.ts) so the FTS
 *     tokenizer can index ticket IDs / cron IDs / UUIDs.
 *   - an FTS index over (id, search_text) via the extension's
 *     `create_fts_index` pragma.
 *
 * Rebuilds are idempotent: the sidecar directory is deleted and rebuilt
 * from the namespace JSONL (parsed with JSON.parse per line — never
 * read_json_auto — per the DOGFOOD-010/018/019 duplicate-key constraint).
 *
 * The FTS extension follows the same INSTALL/LOAD pattern as the VSS
 * extension (src/duckdb/vss.ts): `INSTALL fts` on first use (one-time
 * download), `LOAD fts` thereafter. The sidecar uses its OWN connection —
 * never the namespace singleton, which must stay extension-free
 * (connection.ts Napi::Error history).
 */

import fs from "fs";
import path from "path";
import { Database } from "duckdb";
import { mapDigits } from "./transform";

/** Sidecar directory name inside a namespace (mirrors EMBEDDING_CACHE_DIR). */
export const SEARCH_INDEX_DIR = ".search";

/** DuckDB file holding the base table + FTS index. */
export const INDEX_DB_NAME = "fts.duckdb";

/** Meta file written after every successful rebuild. */
export const INDEX_META_NAME = "meta.json";

/** Explicit all-VARCHAR read_json schema for the staged row file. */
export const SEARCH_ROW_COLUMNS =
  "columns={id:'VARCHAR', key:'VARCHAR', domain:'VARCHAR', timestamp:'VARCHAR', valid_from:'VARCHAR', valid_until:'VARCHAR', author:'VARCHAR', action:'VARCHAR', embedding_text:'VARCHAR', attributes:'VARCHAR', raw_text:'VARCHAR', search_text:'VARCHAR'}";

/** DuckDB connection options — one thread, matching connection.ts. */
export const DB_CONFIG = { threads: "1" };

/**
 * DF-1013-04: cross-process single-flight lock for sidecar rebuilds.
 *
 * The live fleet runs ELEVEN stdio MCP daemons plus the HTTP daemon, and
 * every one of them rebuilds the SAME `.search/` sidecars (boot warm-up
 * + read-path auto-build). `rebuildNamespaceIndex` wipes the sidecar
 * directory before building, so two concurrent rebuilds interleave:
 * process A finishes and renames its fresh DB into place, then process B's
 * `rm -rf` deletes A's completed sidecar before B renames its own — the
 * observed failure mode (53/813 empty sidecars, ~20 missing fts schema,
 * every allNamespaces union 400ing, 2026-10-13).
 *
 * The fix is an advisory lock file in the NAMESPACE ROOT (outside the
 * wiped `.search/` directory — a lock inside it would be deleted by the
 * rebuild's own wipe and let a waiter steal mid-rebuild), taken with
 * `openSync(..., O_CREAT|O_EXCL)`. A process that loses the race POLLS
 * until the winner finishes (the winner deletes the lock file last) and
 * then REUSES the fresh result — never rebuilds again. A lock file is
 * stale only when its pid is dead, so a crashed rebuilder does not wedge
 * the namespace forever.
 */
export const REBUILD_LOCK_NAME = ".search.rebuild.lock";

/** Poll interval while waiting on another process's rebuild (ms). */
const REBUILD_LOCK_POLL_MS = 50;
/** Stale-lock reaper: a lock older than this AND with a dead pid is stolen. */
const REBUILD_LOCK_STALE_MS = 10 * 60_000;

function readPidFromLockFile(lockPath: string): number | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: number };
    return typeof parsed?.pid === "number" && parsed.pid > 0
      ? parsed.pid
      : null;
  } catch {
    return null;
  }
}

/** Best-effort liveness probe for the pid recorded in a lock file. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === "EPERM"; // exists but not ours
    // ESRCH (or anything else) = not running.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Try to acquire the sidecar rebuild lock. Returns true when THIS process
 * owns it (caller rebuilds), false when another process holds it (caller
 * should wait for their result instead of rebuilding).
 *
 * Any OTHER failure to create the lock file (ENOENT on a missing namespace,
 * EACCES on an unwritable one, EROFS, ENOSPC) is neither "I own it" nor
 * "someone else owns it": throwing is the only honest answer, because a
 * `false` here makes rebuildNamespaceIndex's wait loop spin forever.
 */
function tryAcquireRebuildLock(lockPath: string): boolean {
  try {
    const fd = fs.openSync(lockPath, "wx");
    try {
      fs.writeFileSync(
        fd,
        JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
        "utf8",
      );
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "EEXIST") {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `search index rebuild lock could not be created at ${lockPath}: ${detail}`,
      );
    }
    // Existing lock: steal it when stale (holder pid dead + aged).
    const pid = readPidFromLockFile(lockPath);
    let ageMs = 0;
    try {
      ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
    } catch {
      return false; // vanished — next loop iteration re-races
    }
    if (ageMs > REBUILD_LOCK_STALE_MS && pid !== null && !pidAlive(pid)) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Raced with another reaper — they won, we wait.
      }
      return false;
    }
    return false;
  }
}

export function sidecarDir(namespacePath: string): string {
  return path.join(namespacePath, SEARCH_INDEX_DIR);
}

export function indexDbPath(namespacePath: string): string {
  return path.join(sidecarDir(namespacePath), INDEX_DB_NAME);
}

export function indexMetaPath(namespacePath: string): string {
  return path.join(sidecarDir(namespacePath), INDEX_META_NAME);
}

export interface IndexMeta {
  version: number;
  indexedAt: string;
  rowCount: number;
  sourceFiles: number;
  durationMs: number;
}

/**
 * Ensure the namespace `.gitignore` excludes the search index sidecar.
 * Mirrors ensureCacheGitignored (src/embedding/cache.ts).
 */
export function ensureSearchGitignored(namespacePath: string): void {
  const giPath = path.join(namespacePath, ".gitignore");
  const entry = `/${SEARCH_INDEX_DIR}/`;
  let content = "";
  if (fs.existsSync(giPath)) {
    content = fs.readFileSync(giPath, "utf8");
    if (
      content.includes(entry) ||
      content
        .split("\n")
        .map((l) => l.trim())
        .includes(SEARCH_INDEX_DIR)
    ) {
      return;
    }
    content = content.endsWith("\n") ? content : `${content}\n`;
  }
  fs.writeFileSync(
    giPath,
    `${content}# DuckBrain search index (rebuildable, never commit)\n${entry}\n`,
  );
}

/** A raw memory record as read from a JSONL partition file. */
export interface MemoryRecord {
  id: string;
  key: string;
  domain: string;
  timestamp: string;
  author: string;
  action: string;
  embedding_text: string;
  attributes: Record<string, unknown>;
  /** RETR-011: optional validity-window start (ISO-8601) */
  valid_from?: string;
  /** RETR-011: optional validity-window end (ISO-8601) */
  valid_until?: string;
}

/**
 * Directories under a namespace that never hold source JSONL: git metadata
 * and the two rebuildable caches (`.embeddings`, `.search`). Shared by every
 * source walk so the freshness check, the row guard and the rebuild always
 * agree on which files are sources.
 */
export function isSkippedSourceDir(name: string): boolean {
  return (
    name === ".git" ||
    name === ".embeddings" ||
    name === SEARCH_INDEX_DIR ||
    name === ".keys"
  );
}

/** Every `*.jsonl` source file under a namespace, in walk order. */
export function collectSourceFiles(namespacePath: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // Missing / unreadable directory — no sources below it.
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (isSkippedSourceDir(ent.name)) continue;
        walk(full);
      } else if (ent.name.endsWith(".jsonl")) {
        files.push(full);
      }
    }
  };
  walk(namespacePath);
  return files;
}

/**
 * Collect the LIVE memory rows of a namespace.
 *
 * Walks every *.jsonl file under the namespace (skipping git and cache
 * dirs), parses each line with JSON.parse (safe against duplicate keys —
 * the read_json_auto constraint applies to SQL, which this path avoids),
 * keeps the latest record per id (ISO timestamp compare, later file/line
 * wins ties) and drops ids whose latest record is a tombstone — the same
 * semantics as queryMemories' ROW_NUMBER() dedup.
 */
export function collectLiveMemoryRows(namespacePath: string): MemoryRecord[] {
  const latest = new Map<
    string,
    { rec: MemoryRecord; ts: string; order: number }
  >();
  let order = 0;
  let sourceFiles = 0;

  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (isSkippedSourceDir(ent.name)) {
          continue;
        }
        walk(full);
      } else if (ent.name.endsWith(".jsonl")) {
        sourceFiles += 1;
        try {
          const lines = fs.readFileSync(full, "utf8").split("\n");
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const rec = JSON.parse(line) as Partial<MemoryRecord>;
              if (typeof rec.id !== "string" || !rec.id) continue;
              const text =
                typeof rec.embedding_text === "string"
                  ? rec.embedding_text
                  : typeof (rec as any).content === "string"
                    ? ((rec as any).content as string)
                    : "";
              const norm: MemoryRecord = {
                id: rec.id,
                key: typeof rec.key === "string" ? rec.key : "",
                domain:
                  typeof rec.domain === "string" ? rec.domain : "raw_note",
                timestamp:
                  typeof rec.timestamp === "string" ? rec.timestamp : "",
                // RETR-011: optional validity window — carried through so
                // the sidecar can apply current-view filtering.
                ...(typeof (rec as any).valid_from === "string"
                  ? { valid_from: (rec as any).valid_from as string }
                  : {}),
                ...(typeof (rec as any).valid_until === "string"
                  ? { valid_until: (rec as any).valid_until as string }
                  : {}),
                author: typeof rec.author === "string" ? rec.author : "",
                action: typeof rec.action === "string" ? rec.action : "add",
                embedding_text: text,
                attributes:
                  rec.attributes && typeof rec.attributes === "object"
                    ? (rec.attributes as Record<string, unknown>)
                    : {},
              };
              const prev = latest.get(norm.id);
              // Latest record wins: newer timestamp, or (on ties) later in
              // the file order — matches ROW_NUMBER() ORDER BY timestamp DESC.
              if (
                !prev ||
                norm.timestamp > prev.ts ||
                (norm.timestamp === prev.ts && order > prev.order)
              ) {
                latest.set(norm.id, { rec: norm, ts: norm.timestamp, order });
              }
            } catch {
              // Unparseable line — skip (mirrors collectEmbeddingTexts).
            }
          }
        } catch {
          // Unreadable file — skip.
        }
        order += 1;
      }
    }
  };
  walk(namespacePath);

  const rows: MemoryRecord[] = [];
  for (const { rec } of latest.values()) {
    if (rec.action === "tombstone") continue;
    rows.push(rec);
  }
  return rows;
}

/** Build the raw searchable text for a record (key + content + attributes). */
export function buildRawText(rec: MemoryRecord): string {
  const attrs = safeStringify(rec.attributes);
  return [rec.key, rec.embedding_text, attrs].filter((s) => s).join(" ");
}

function safeStringify(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return typeof s === "string" ? s : "";
  } catch {
    return "";
  }
}

function execAsync(db: Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err: Error | null) => (err ? reject(err) : resolve()));
  });
}

function closeAsync(db: Database): Promise<void> {
  return new Promise((resolve) => db.close(() => resolve()));
}

/**
 * DF-1013-04: in-process single-flight registry, keyed by RESOLVED namespace
 * path.
 *
 * The lock file above serialises rebuilds ACROSS processes; this map does the
 * same job INSIDE one process, where a lock file is the wrong tool. Two
 * callers in one process that arrive together would otherwise both run a full
 * rebuild: the loser polls, sees the winner's lock vanish, and races again.
 * Joiners here reuse the owner's promise, so N concurrent calls for one
 * namespace cost exactly ONE wipe+build+rename of the sidecar directory and
 * every caller observes the same result.
 *
 * The key is the namespace path, so rebuilds of DIFFERENT namespaces still run
 * concurrently — this is deliberately NOT a global mutex.
 */
const rebuildInFlight = new Map<string, Promise<IndexMeta>>();

/**
 * DF-1013-04 observability: the namespaces with a rebuild in flight in THIS
 * process (resolved paths, insertion order). Empty when nothing is rebuilding.
 * A length above 1 proves rebuilds are keyed per namespace, not serialised
 * behind one global lock.
 */
export function inFlightRebuildNamespaces(): string[] {
  return [...rebuildInFlight.keys()];
}

/**
 * Rebuild the keyword search index for one namespace. Idempotent: the
 * sidecar directory is deleted first, so a re-run always produces the
 * same index. The DuckDB file is built at a temp path and atomically
 * renamed into place so a concurrent reader never sees a half-written
 * index.
 *
 * Concurrent callers — in this process or another — share ONE rebuild per
 * namespace, and all of them return that rebuild's stats.
 *
 * @returns rebuild stats (rowCount, sourceFiles, durationMs, indexedAt)
 */
export async function rebuildNamespaceIndex(
  namespacePath: string,
): Promise<IndexMeta> {
  const key = path.resolve(namespacePath);
  const joined = rebuildInFlight.get(key);
  if (joined) return joined;

  const run = acquireRebuildLockAndRebuild(namespacePath).finally(() => {
    // Only the owner registers, so this never clears a successor's entry.
    if (rebuildInFlight.get(key) === run) rebuildInFlight.delete(key);
  });
  rebuildInFlight.set(key, run);
  return run;
}

/**
 * Acquire the cross-process lock and run the rebuild, releasing the lock when
 * done. Callers MUST go through rebuildNamespaceIndex so that same-process
 * callers share one build instead of racing each other for the lock.
 */
async function acquireRebuildLockAndRebuild(
  namespacePath: string,
): Promise<IndexMeta> {
  // A namespace that does not exist cannot be locked: openSync(lockPath, "wx")
  // fails with ENOENT, which is neither "I own it" nor "someone else owns it",
  // so the wait loop below would spin forever. Fail loudly instead, mirroring
  // ensureFreshIndex's wording for the same condition.
  if (!fs.existsSync(namespacePath)) {
    throw new Error(`namespace directory not found: ${namespacePath}`);
  }
  const lockPath = path.join(namespacePath, REBUILD_LOCK_NAME);

  for (;;) {
    if (tryAcquireRebuildLock(lockPath)) {
      try {
        // Single-flight across processes: this call OWNS the sidecar until
        // the rename + meta land, then releases the lock by deleting it.
        const meta = await rebuildNamespaceIndexLocked(namespacePath);
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Lock file already gone (sidecar wipe removed it) — done.
        }
        return meta;
      } catch (error) {
        // Never leave the lock behind on a failed rebuild: the stale-pid
        // reaper would cover it eventually, but the next honest rebuild
        // should not have to wait 10 minutes for that.
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Best effort.
        }
        throw error;
      }
    }
    // Another process is rebuilding THIS namespace: wait for its lock to
    // clear, then REUSE its result — never rebuild again on top of it.
    await sleep(REBUILD_LOCK_POLL_MS);
    if (!fs.existsSync(lockPath)) {
      // Winner finished: the sidecar is fresh. Report its stats.
      const meta = readIndexMeta(namespacePath);
      if (meta) return meta;
      // Meta missing/unparseable — fall through and race again.
      continue;
    }
  }
}

/**
 * The raw rebuild (no locking). Callers MUST hold the sidecar rebuild
 * lock — use rebuildNamespaceIndex.
 */
async function rebuildNamespaceIndexLocked(
  namespacePath: string,
): Promise<IndexMeta> {
  const start = Date.now();
  ensureSearchGitignored(namespacePath);

  const rows = collectLiveMemoryRows(namespacePath);
  const dir = sidecarDir(namespacePath);
  // Cache doctrine: wipe the old sidecar entirely before rebuilding.
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const dbPath = indexDbPath(namespacePath);
  const tmpDbPath = path.join(dir, `${INDEX_DB_NAME}.tmp`);
  const tmpRowsPath = path.join(dir, "rows.tmp.jsonl");

  // Stage the rows as a temp JSONL (all strings; safe to re-read with the
  // explicit all-VARCHAR schema + ignore_errors — same pattern as
  // READ_JSON_COLUMNS).
  const lines: string[] = [];
  for (const rec of rows) {
    const rawText = buildRawText(rec);
    const record = {
      id: rec.id,
      key: rec.key,
      domain: rec.domain,
      timestamp: rec.timestamp,
      // RETR-011: optional validity window — staged so rebuilt sidecars
      // carry the columns the current-view keyword filter needs.
      ...(rec.valid_from !== undefined ? { valid_from: rec.valid_from } : {}),
      ...(rec.valid_until !== undefined
        ? { valid_until: rec.valid_until }
        : {}),
      author: rec.author,
      action: rec.action,
      embedding_text: rec.embedding_text,
      attributes: safeStringify(rec.attributes),
      raw_text: rawText,
      search_text: mapDigits(rawText),
    };
    lines.push(safeStringify(record));
  }
  fs.writeFileSync(
    tmpRowsPath,
    lines.join("\n") + (lines.length ? "\n" : ""),
    "utf8",
  );

  const db = new Database(tmpDbPath, DB_CONFIG);
  try {
    // Explicit INSTALL before LOAD, mirroring src/duckdb/vss.ts. INSTALL fts
    // is idempotent (a no-op when already installed) and required on fresh
    // runners, where relying on auto-install during LOAD fails with
    // "Extension .../fts.duckdb_extension not found" (CI 32160011179).
    try {
      await execAsync(db, "INSTALL fts;");
      await execAsync(db, "LOAD fts;");
    } catch (error) {
      // Extension may already be installed/cached — still attempt LOAD.
      try {
        await execAsync(db, "LOAD fts;");
      } catch (loadError) {
        console.warn("fts extension could not be loaded:", loadError);
        throw new Error(
          `Failed to load DuckDB fts extension: ${
            loadError instanceof Error ? loadError.message : "unknown error"
          }. The extension is expected at ~/.duckdb/extensions/<version>/<platform>/fts.duckdb_extension (e.g. v1.4.4/linux_amd64 on Linux); INSTALL fts downloads it on first use, which requires a network connection to the DuckDB extension repository (duckdb.org).`,
        );
      }
    }
    await execAsync(
      db,
      `CREATE TABLE memories (id VARCHAR, key VARCHAR, domain VARCHAR, timestamp VARCHAR, valid_from VARCHAR, valid_until VARCHAR, author VARCHAR, action VARCHAR, embedding_text VARCHAR, attributes VARCHAR, raw_text VARCHAR, search_text VARCHAR)`,
    );
    if (lines.length > 0) {
      const fileList = `'${tmpRowsPath.replace(/\\/g, "/")}'`;
      await execAsync(
        db,
        `INSERT INTO memories SELECT * FROM read_json([${fileList}], format='newline_delimited', ignore_errors=true, ${SEARCH_ROW_COLUMNS})`,
      );
    }
    // Create the FTS index over (id, search_text). `id` is the join key
    // used by match_bm25 at query time.
    await execAsync(
      db,
      `PRAGMA create_fts_index('memories', 'id', 'search_text')`,
    );
  } finally {
    await closeAsync(db);
  }

  // Atomic swap into place; drop the staged rows file.
  fs.renameSync(tmpDbPath, dbPath);
  fs.rmSync(tmpRowsPath, { force: true });

  const meta: IndexMeta = {
    version: 1,
    indexedAt: new Date().toISOString(),
    rowCount: rows.length,
    sourceFiles: countSourceFiles(namespacePath),
    durationMs: Date.now() - start,
  };
  fs.writeFileSync(indexMetaPath(namespacePath), safeStringify(meta), "utf8");
  return meta;
}

function countSourceFiles(namespacePath: string): number {
  return collectSourceFiles(namespacePath).length;
}

// ---------------------------------------------------------------------------
// DB-GAP-047: read-path freshness — bounded, single-flight rebuild-before-answer
//
// The sidecar is a cache (Q-7 cache doctrine), and a cache whose lifecycle
// needs a human is a leak into every consumer: a fresh namespace 500s on
// `contains=`, `q=` silently loses its keyword leg, and a sidecar that
// predates the newest write keeps answering with stale rows. The read path
// therefore owns the cache's freshness — `ensureFreshIndex` detects
// missing/stale and rebuilds BEFORE the read runs, under two hard limits:
//
//   - BOUNDED: a namespace with more source rows than
//     DUCKBRAIN_SEARCH_AUTOBUILD_MAX_ROWS (default 5000) is refused, never
//     indexed inline — the read keeps its pre-change behavior (skipped /
//     rebuild-hint error) instead of blocking on a multi-minute rebuild.
//   - SINGLE-FLIGHT: concurrent readers of one namespace share ONE rebuild,
//     so a burst of requests cannot stack rebuilds (each of which wipes and
//     rewrites the sidecar directory).
//
// Writes never call this: indexing stays out of the write path, so a write
// costs the same as before (no write amplification).
// ---------------------------------------------------------------------------

/** Env override for the bounded read-path auto-build row guard. */
export const AUTOBUILD_MAX_ROWS_ENV = "DUCKBRAIN_SEARCH_AUTOBUILD_MAX_ROWS";

/** Default row bound for a read-path auto-build. */
export const DEFAULT_AUTOBUILD_MAX_ROWS = 5000;

/**
 * The active auto-build row bound: the env override when it parses to a
 * non-negative integer, the default otherwise. A bound of 0 refuses every
 * namespace that has at least one source row.
 */
export function autoBuildMaxRows(): number {
  const raw = process.env[AUTOBUILD_MAX_ROWS_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_AUTOBUILD_MAX_ROWS;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_AUTOBUILD_MAX_ROWS;
  return parsed;
}

export type IndexFreshnessState = "missing" | "stale" | "fresh";

export interface IndexFreshness {
  /** missing = no sidecar at all; stale = indexed before the newest source
   *  write (or an unreadable meta); fresh = newer than every source write. */
  state: IndexFreshnessState;
  /** Newest source `*.jsonl` mtime (epoch ms); 0 when there are no sources. */
  newestSourceMtimeMs: number;
  /** `meta.indexedAt` as epoch ms; null when absent/unparseable. */
  indexedAt: number | null;
  /** `meta.indexedAt` verbatim (ISO-8601); null when absent/unparseable. */
  indexedAtIso: string | null;
}

/** Newest source `*.jsonl` mtime under a namespace (epoch ms; 0 = none). */
export function newestSourceMtimeMs(namespacePath: string): number {
  let newest = 0;
  for (const file of collectSourceFiles(namespacePath)) {
    try {
      const mtime = fs.statSync(file).mtimeMs;
      if (mtime > newest) newest = mtime;
    } catch {
      // Unreadable file — ignore (mirrors the read-side skip).
    }
  }
  return newest;
}

/**
 * Classify a namespace's sidecar without touching it (read-only): `missing`
 * when there is no DuckDB file, `stale` when the newest source write is
 * newer than `meta.indexedAt` (or the meta is missing/unreadable), `fresh`
 * otherwise. Decides; never rebuilds.
 */
export function indexFreshness(namespacePath: string): IndexFreshness {
  const newestSource = newestSourceMtimeMs(namespacePath);
  const meta = readIndexMeta(namespacePath);
  const parsed = meta ? Date.parse(meta.indexedAt) : Number.NaN;
  const indexedAt = Number.isFinite(parsed) ? parsed : null;
  const base = {
    newestSourceMtimeMs: newestSource,
    indexedAt,
    indexedAtIso: indexedAt === null ? null : (meta?.indexedAt ?? null),
  };
  if (!fs.existsSync(indexDbPath(namespacePath))) {
    return { state: "missing", ...base };
  }
  if (indexedAt === null) {
    // Sidecar present but unverifiable — treat as stale (rebuild).
    return { state: "stale", ...base };
  }
  // Strictly newer: a source write in the same millisecond as the last
  // rebuild is not staleness (and must not thrash rebuilds).
  return { state: newestSource > indexedAt ? "stale" : "fresh", ...base };
}

/**
 * Upper-bound row count for the auto-build guard: newline count across every
 * source file, abandoning the scan as soon as the bound is exceeded — so an
 * over-bound namespace costs one bounded read, never a full parse.
 */
function countSourceRowsUpTo(namespacePath: string, bound: number): number {
  const CHUNK = 64 * 1024;
  const buf = Buffer.allocUnsafe(CHUNK);
  let count = 0;
  for (const file of collectSourceFiles(namespacePath)) {
    let fd: number | null = null;
    try {
      fd = fs.openSync(file, "r");
      let bytes = 0;
      while ((bytes = fs.readSync(fd, buf, 0, CHUNK, null)) > 0) {
        for (let i = 0; i < bytes; i++) {
          if (buf[i] === 0x0a) {
            count += 1;
            if (count > bound) return count;
          }
        }
      }
    } catch {
      // Unreadable file — contributes no countable rows.
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // Best effort.
        }
      }
    }
  }
  return count;
}

export interface EnsureFreshIndexOptions {
  /** Row bound override; defaults to autoBuildMaxRows() (env / const). */
  maxRows?: number;
}

export interface EnsureFreshIndexResult {
  /** Freshness as observed BEFORE this call's rebuild. */
  freshness: IndexFreshness;
  /** True when THIS call performed the rebuild. */
  rebuilt: boolean;
  /** Set while the index is still not usable: bound refusal or failure. */
  reason?: string;
  /** Rebuild stats when a rebuild happened. */
  meta?: IndexMeta;
}

/** In-process single-flight registry: one rebuild per namespace at a time. */
const autoBuildInFlight = new Map<string, Promise<EnsureFreshIndexResult>>();

/** Rebuilds the read path performed, per namespace (observability/tests). */
const autoBuildCounts = new Map<string, number>();

/** DB-GAP-047 observability: read-path rebuilds performed for a namespace. */
export function autoBuildCount(namespacePath: string): number {
  return autoBuildCounts.get(path.resolve(namespacePath)) ?? 0;
}

async function runEnsureFreshIndex(
  namespacePath: string,
  opts: EnsureFreshIndexOptions,
): Promise<EnsureFreshIndexResult> {
  const freshness = indexFreshness(namespacePath);
  if (freshness.state === "fresh") {
    return { freshness, rebuilt: false };
  }

  const namespace = path.basename(namespacePath);
  // Never materialise a sidecar (or the namespace directory) for a path that
  // does not exist — for a typo'd namespace the loud rebuild-hint error is
  // still the right answer, and a read must not create directories.
  if (!fs.existsSync(namespacePath)) {
    return {
      freshness,
      rebuilt: false,
      reason: `namespace directory not found: ${namespacePath}`,
    };
  }

  const bound = opts.maxRows ?? autoBuildMaxRows();
  const rows = countSourceRowsUpTo(namespacePath, bound);
  if (rows > bound) {
    return {
      freshness,
      rebuilt: false,
      reason:
        `namespace '${namespace}' has more than ${bound} source rows ` +
        `(${AUTOBUILD_MAX_ROWS_ENV}=${bound})`,
    };
  }

  try {
    const meta = await rebuildNamespaceIndex(namespacePath);
    const key = path.resolve(namespacePath);
    autoBuildCounts.set(key, (autoBuildCounts.get(key) ?? 0) + 1);
    return { freshness, rebuilt: true, meta };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[search] read-path auto-build failed for namespace '${namespace}' — ` +
        `falling back to the manual rebuild path: ${message}`,
    );
    return { freshness, rebuilt: false, reason: `rebuild failed: ${message}` };
  }
}

/**
 * Make a namespace's keyword index fresh enough to answer a read: rebuild
 * when the sidecar is missing or predates the newest source write, under the
 * row bound. Concurrent callers for the same namespace share ONE rebuild
 * (in-process promise map keyed by resolved path).
 *
 * Never throws: a refusal or a failed rebuild is reported as `reason` so the
 * caller keeps the pre-change behavior for that namespace.
 */
export async function ensureFreshIndex(
  namespacePath: string,
  opts: EnsureFreshIndexOptions = {},
): Promise<EnsureFreshIndexResult> {
  const key = path.resolve(namespacePath);
  const inFlight = autoBuildInFlight.get(key);
  if (inFlight) return inFlight;
  const run = runEnsureFreshIndex(namespacePath, opts).finally(() => {
    autoBuildInFlight.delete(key);
  });
  autoBuildInFlight.set(key, run);
  return run;
}

/**
 * Enumerate namespace directories under a namespaces root (directories
 * that carry a manifest.json — i.e. real namespaces, not stray dirs).
 */
export function listNamespaces(namespacesRoot: string): string[] {
  if (!fs.existsSync(namespacesRoot)) return [];
  return fs
    .readdirSync(namespacesRoot, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() &&
        !e.name.startsWith(".") &&
        fs.existsSync(path.join(namespacesRoot, e.name, "manifest.json")),
    )
    .map((e) => e.name)
    .sort();
}

/**
 * Rebuild the search index for every namespace under the given root.
 *
 * @returns per-namespace rebuild results keyed by namespace name
 */
export async function rebuildAllNamespaces(
  namespacesRoot: string,
): Promise<Record<string, IndexMeta>> {
  const out: Record<string, IndexMeta> = {};
  for (const ns of listNamespaces(namespacesRoot)) {
    out[ns] = await rebuildNamespaceIndex(path.join(namespacesRoot, ns));
  }
  return out;
}

export interface SearchIndexStatus {
  namespace: string;
  indexExists: boolean;
  dbPath: string;
  meta: IndexMeta | null;
  sizeBytes: number;
  gitignored: boolean;
}

/** Read the meta file, tolerating a missing/corrupt one. */
export function readIndexMeta(namespacePath: string): IndexMeta | null {
  try {
    const raw = fs.readFileSync(indexMetaPath(namespacePath), "utf8");
    const parsed = JSON.parse(raw) as IndexMeta;
    if (typeof parsed?.indexedAt !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function indexStatus(namespacePath: string): SearchIndexStatus {
  const dbPath = indexDbPath(namespacePath);
  const exists = fs.existsSync(dbPath);
  let sizeBytes = 0;
  if (exists) {
    try {
      sizeBytes = fs.statSync(dbPath).size;
    } catch {
      // Best-effort.
    }
  }
  const gi = path.join(namespacePath, ".gitignore");
  let gitignored = false;
  if (fs.existsSync(gi)) {
    gitignored = fs.readFileSync(gi, "utf8").includes(SEARCH_INDEX_DIR);
  }
  return {
    namespace: path.basename(namespacePath),
    indexExists: exists,
    dbPath,
    meta: readIndexMeta(namespacePath),
    sizeBytes,
    gitignored,
  };
}

/** Error thrown when a search is attempted without an index (or a stale
 *  half-written one). Carries the rebuild hint for CLI/HTTP surfacing.
 *
 *  DB-GAP-047: the read path rebuilds a missing/stale sidecar itself, so this
 *  now surfaces only when the bounded auto-build refuses (over-bound
 *  namespace) or the rebuild fails — `note` carries that reason so the
 *  operator sees why the manual path is still needed. */
export class SearchIndexMissingError extends Error {
  constructor(namespace: string, nsPath: string, note?: string) {
    super(
      `No keyword search index for namespace '${namespace}' at ${sidecarDir(nsPath)} — run 'duckbrain search-index rebuild${namespace !== "default" ? ` --namespace=${namespace}` : ""}' first${note ? ` (auto-build skipped: ${note})` : ""}`,
    );
    this.name = "SearchIndexMissingError";
  }
}
