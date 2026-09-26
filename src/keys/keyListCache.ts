/**
 * Key-list materialization cache — PERF-001 (list_keys stop scanning the
 * full namespace corpus per call).
 *
 * `list_keys` (src/mcp/tools/list_keys.ts) re-runs a DuckDB GROUP BY over
 * EVERY partition JSONL on every call — 155ms on a 125MB namespace, 1.3s on
 * a 6.8GB one. This module materializes the key list once per namespace and
 * keeps it fresh, mirroring the `.search/` sidecar doctrine (RETR-001):
 *
 *   - Per-namespace sidecar at `<namespace>/.keys/` (gitignored, never
 *     committed — `ensureKeysGitignored`, same pattern as the search index
 *     and the embedding cache).
 *   - Artifact `keys.json`: a JSON array of `{key, latest}` objects, in
 *     EXACTLY the order the SQL read path produces (RETR-005:
     `__latest DESC NULLS LAST, key ASC`). No JS re-sorting anywhere on the
 *     warm path — the artifact IS the read order, so warm output is
 *     deep-equal to a cold full scan by construction.
 *   - `meta.json`: version, entryCount, builtAt, durationMs, fileSetHash
 *     (sha256 of the source-file list — catches squash/consolidation
 *     rewrites that rename files) and fingerprint (sha256 of per-file
 *     `path|size|mtimeMs` — catches appends and touch-class staleness).
 *
 * Freshness contract (the staleness signal):
 *   fresh    — meta exists, fileSetHash AND fingerprint match the current
 *              source list → serve the artifact.
 *   missing  — no meta (first read, cache deleted, or a write-path hook
 *              invalidated) → rebuild.
 *   stale    — fingerprint/fileSetHash mismatch → rebuild.
 * The rebuild is the SAME resilient SQL the cold path runs
 * (read_json ignore_errors=true, `action != 'tombstone'`, GROUP BY key,
 * ORDER BY MAX(try_cast(timestamp)) DESC NULLS LAST, key ASC), so a warm
 * answer can never drift from a cold one.
 *
 * Invalidation (write path): `invalidateKeysCache` is called after a
 * successful append batch (src/serialization/namespaceWriter.ts), after
 * squash/compaction rewrites (src/git/squash.ts) and after segment
 * consolidation (src/storage/segment-consolidation.ts). It clears BOTH the
 * in-process entry and the on-disk meta; the next read rebuilds. The hooks
 * are best-effort by design — a failure to invalidate degrades to the
 * fingerprint signal, never breaks a write (SUPA-1: no write-path cost
 * beyond one unlink attempt).
 *
 * Rebuild safety: the artifact is written to a `.tmp` path and atomically
 * renamed into place (a concurrent reader never sees a torn file), and
 * in-process rebuilds are single-flight per namespace (same pattern as
 * ensureFreshIndex). A failed rebuild returns null and the caller falls
 * back to the direct SQL path — the cache can only ever be a no-op or a
 * speedup, never a correctness change.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getDuckDBConnection } from "../duckdb/connection";

/** Sidecar directory name inside a namespace (mirrors SEARCH_INDEX_DIR). */
export const KEYS_CACHE_DIR = ".keys";

/** Artifact file: JSON array of {key, latest}, in read order. */
export const KEYS_ARTIFACT_NAME = "keys.json";

/** Meta file written after every successful rebuild. */
export const KEYS_META_NAME = "meta.json";

/** Env override that turns the cache off (cold SQL path on every call). */
export const KEYS_CACHE_ENABLED_ENV = "DUCKBRAIN_KEYS_CACHE";

/** Artifact schema version. */
export const KEYS_CACHE_VERSION = 1;

/**
 * Explicit all-VARCHAR read_json schema — verbatim copy of READ_JSON_COLUMNS
 * (src/duckdb/queries.ts) kept local to avoid a queries→namespaceWriter→
 * keys cycle; if that schema ever grows a column, this copy must move with
 * it (the rebuild SQL only needs `key`, `timestamp` and `action`).
 */
const READ_JSON_COLUMNS_COPY =
  "columns={id:'VARCHAR', key:'VARCHAR', domain:'VARCHAR', timestamp:'VARCHAR', valid_from:'VARCHAR', valid_until:'VARCHAR', author:'VARCHAR', action:'VARCHAR', embedding_text:'VARCHAR', attributes:'VARCHAR'}";

export function keysCacheEnabled(): boolean {
  return process.env[KEYS_CACHE_ENABLED_ENV] !== "off";
}

export function keysCacheDir(namespacePath: string): string {
  return path.join(namespacePath, KEYS_CACHE_DIR);
}

export function keysArtifactPath(namespacePath: string): string {
  return path.join(keysCacheDir(namespacePath), KEYS_ARTIFACT_NAME);
}

export function keysMetaPath(namespacePath: string): string {
  return path.join(keysCacheDir(namespacePath), KEYS_META_NAME);
}

/** One materialized key entry (artifact line). */
export interface KeyListEntry {
  key: string;
  /**
   * The key's newest record timestamp as DuckDB renders a TIMESTAMP cast to
   * VARCHAR (wall-clock, microsecond precision, e.g.
   * "2026-08-21 12:00:00.676525"), or null when unparseable (NULLS LAST).
   * Informational — ordering is baked into the artifact line order.
   */
  latest: string | null;
}

export interface KeyListMeta {
  version: number;
  entryCount: number;
  builtAt: string;
  durationMs: number;
  /** sha256 of the newline-joined source file list. */
  fileSetHash: string;
  /** sha256 of per-file "path|size|mtimeMs" lines. */
  fingerprint: string;
}

/**
 * Ensure the namespace `.gitignore` excludes the key-list sidecar.
 * Mirrors ensureSearchGitignored (src/search/index.ts).
 */
export function ensureKeysGitignored(namespacePath: string): void {
  const giPath = path.join(namespacePath, ".gitignore");
  const entry = `/${KEYS_CACHE_DIR}/`;
  let content = "";
  if (fs.existsSync(giPath)) {
    content = fs.readFileSync(giPath, "utf8");
    if (
      content.includes(entry) ||
      content
        .split("\n")
        .map((l) => l.trim())
        .includes(KEYS_CACHE_DIR)
    ) {
      return;
    }
    content = content.endsWith("\n") ? content : `${content}\n`;
  }
  fs.writeFileSync(
    giPath,
    `${content}# DuckBrain key-list cache (rebuildable, never commit)\n${entry}\n`,
  );
}

/**
 * The EXACT source-file list the keys read path scans: for every manifest
 * partition, every `*.jsonl` chunk in readdir order (DB-GAP-050: this is
 * the same list runKeysQuery hands DuckDB — shared helper so the cache and
 * the SQL path can never disagree about what "the corpus" is). Parquet-only
 * partitions (post-squash) contribute nothing, matching the SQL path.
 */
export function collectKeysSourceFiles(namespacePath: string): string[] {
  const manifestPath = path.join(namespacePath, "manifest.json");
  const jsonlFiles: string[] = [];
  if (!fs.existsSync(manifestPath)) {
    return jsonlFiles;
  }
  let manifest: { partitions?: string[] };
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch {
    return jsonlFiles;
  }
  for (const p of manifest.partitions ?? []) {
    const partitionPath = path.join(namespacePath, p);
    if (!fs.existsSync(partitionPath)) continue;
    const files = fs
      .readdirSync(partitionPath)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(partitionPath, f).replace(/\\/g, "/"));
    jsonlFiles.push(...files);
  }
  return jsonlFiles;
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function fileSetHash(files: string[]): string {
  return sha256(files.join("\n"));
}

export function fingerprintFiles(files: string[]): string {
  const lines: string[] = [];
  for (const file of files) {
    try {
      const st = fs.statSync(file);
      lines.push(`${file}|${st.size}|${st.mtimeMs}`);
    } catch {
      // Unreadable file — include a stable marker so a vanished file still
      // changes the fingerprint (same doctrine as the SQL path's
      // existsSync skip: the file contributes nothing to the scan).
      lines.push(`${file}|missing`);
    }
  }
  return sha256(lines.join("\n"));
}

/** Read meta.json, tolerating a missing/corrupt one. */
export function readKeysMeta(namespacePath: string): KeyListMeta | null {
  try {
    const raw = fs.readFileSync(keysMetaPath(namespacePath), "utf8");
    const parsed = JSON.parse(raw) as KeyListMeta;
    if (
      parsed?.version !== KEYS_CACHE_VERSION ||
      typeof parsed?.fingerprint !== "string" ||
      typeof parsed?.fileSetHash !== "string" ||
      typeof parsed?.entryCount !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export type KeyListFreshnessState = "missing" | "stale" | "fresh" | "empty";

export interface KeyListFreshness {
  state: KeyListFreshnessState;
  sourceFiles: number;
}

/**
 * Classify the sidecar for the CURRENT source list (read-only): `empty`
 * when the namespace has no source files (no sidecar is ever built),
 * `missing` when there is no verifiable meta, `stale` on a
 * fingerprint/fileSetHash mismatch, `fresh` otherwise. Decides; never
 * rebuilds.
 */
export function keysCacheFreshness(namespacePath: string): KeyListFreshness {
  const files = collectKeysSourceFiles(namespacePath);
  if (files.length === 0) {
    return { state: "empty", sourceFiles: 0 };
  }
  const meta = readKeysMeta(namespacePath);
  if (!meta) {
    return { state: "missing", sourceFiles: files.length };
  }
  const fresh =
    meta.fileSetHash === fileSetHash(files) &&
    meta.fingerprint === fingerprintFiles(files);
  return {
    state: fresh ? "fresh" : "stale",
    sourceFiles: files.length,
  };
}

/**
 * Invalidate the key-list cache for a namespace: drop the in-process entry
 * AND the on-disk meta. Best-effort by design — never throws, so write-path
 * callers (namespaceWriter, squash, consolidation) can call it fire-and-
 * forget. The artifact file is left in place (it is dead without meta and
 * gets overwritten by the next rebuild).
 */
const memoryCache = new Map<string, KeyListEntry[]>();

export function invalidateKeysCache(namespacePath: string): void {
  try {
    memoryCache.delete(path.resolve(namespacePath));
  } catch {
    // Never throw.
  }
  try {
    fs.rmSync(keysMetaPath(namespacePath), { force: true });
  } catch {
    // Never throw.
  }
}

/** Load the artifact into entries, preserving order. Null on any error. */
function loadArtifact(namespacePath: string): KeyListEntry[] | null {
  try {
    const raw = fs.readFileSync(keysArtifactPath(namespacePath), "utf-8");
    const parsed = JSON.parse(raw) as { key?: unknown; latest?: unknown }[];
    if (!Array.isArray(parsed)) return null;
    const entries: KeyListEntry[] = [];
    for (const rec of parsed) {
      if (typeof rec?.key !== "string") return null;
      entries.push({
        key: rec.key,
        latest: typeof rec.latest === "string" ? rec.latest : null,
      });
    }
    return entries;
  } catch {
    return null;
  }
}

function execAll(db: unknown, sql: string): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const stmt = (
      db as {
        prepare: (s: string) => {
          all: (...args: unknown[]) => void;
        };
      }
    ).prepare(sql);
    stmt.all((err: unknown, res: Record<string, unknown>[]) => {
      if (err) reject(err);
      else resolve(res || []);
    });
  });
}

/**
 * Rebuild the artifact with the SAME resilient SQL the cold keys path runs
 * (identical file list, ignore_errors, tombstone filter, GROUP BY, and
 * RETR-005 ordering), then atomically swap it into place. Returns the
 * entries in read order, or null when the DuckDB scan fails (the caller
 * falls back to the direct SQL path).
 */
export async function rebuildKeysCache(
  namespacePath: string,
): Promise<KeyListEntry[] | null> {
  const start = Date.now();
  // Snapshot the source list and its fingerprints BEFORE the scan: the meta
  // must describe the corpus the artifact was actually built from. A write
  // landing mid-rebuild changes the live fingerprint, the NEXT read sees a
  // mismatch and rebuilds again — the cache self-heals instead of serving
  // an artifact that silently predates the write.
  const files = collectKeysSourceFiles(namespacePath);
  if (files.length === 0) return [];
  const snapshotFileSetHash = fileSetHash(files);
  const snapshotFingerprint = fingerprintFiles(files);
  try {
    ensureKeysGitignored(namespacePath);
    const db = getDuckDBConnection("singleton", namespacePath);
    const fileList = files.map((f) => `'${f}'`).join(", ");
    const sql = `
      SELECT key, CAST(MAX(try_cast(timestamp AS TIMESTAMP)) AS VARCHAR) AS latest
      FROM read_json([${fileList}], format='newline_delimited', ignore_errors=true, ${READ_JSON_COLUMNS_COPY})
      WHERE action != 'tombstone'
      GROUP BY key
      ORDER BY MAX(try_cast(timestamp AS TIMESTAMP)) DESC NULLS LAST, key ASC
    `;
    const rows = await execAll(db, sql);
    const entries: KeyListEntry[] = rows.map((row) => ({
      key: String(row.key),
      latest:
        row.latest === null || row.latest === undefined
          ? null
          : String(row.latest),
    }));

    const dir = keysCacheDir(namespacePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpArtifact = path.join(dir, `${KEYS_ARTIFACT_NAME}.tmp`);
    fs.writeFileSync(tmpArtifact, JSON.stringify(entries), "utf-8");
    fs.renameSync(tmpArtifact, keysArtifactPath(namespacePath));

    const meta: KeyListMeta = {
      version: KEYS_CACHE_VERSION,
      entryCount: entries.length,
      builtAt: new Date().toISOString(),
      durationMs: Date.now() - start,
      fileSetHash: snapshotFileSetHash,
      fingerprint: snapshotFingerprint,
    };
    const tmpMeta = path.join(dir, `${KEYS_META_NAME}.tmp`);
    fs.writeFileSync(tmpMeta, JSON.stringify(meta, null, 2) + "\n", "utf-8");
    fs.renameSync(tmpMeta, keysMetaPath(namespacePath));

    memoryCache.set(path.resolve(namespacePath), entries);
    return entries;
  } catch (error) {
    console.error(
      `[keys-cache] rebuild failed for ${namespacePath} — falling back to the SQL path: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

export interface EnsureFreshKeyListResult {
  /**
   * Entries in read order — null means "no cache answer, use the SQL path"
   * (cache disabled, rebuild failed, or a namespace whose freshness could
   * not be established).
   */
  entries: KeyListEntry[] | null;
  /** Freshness as observed before any rebuild this call performed. */
  state: KeyListFreshnessState;
  /** True when THIS call rebuilt the artifact. */
  rebuilt: boolean;
}

/** In-process single-flight registry: one rebuild per namespace at a time. */
const rebuildInFlight = new Map<string, Promise<KeyListEntry[] | null>>();

/**
 * Serve the key list from cache when fresh, rebuilding (lazily, single-
 * flight) when missing/stale. Never throws — null means fall back to SQL.
 */
export async function ensureFreshKeyList(
  namespacePath: string,
): Promise<EnsureFreshKeyListResult> {
  if (!keysCacheEnabled()) {
    return { entries: null, state: "missing", rebuilt: false };
  }
  const key = path.resolve(namespacePath);
  const freshness = keysCacheFreshness(namespacePath);
  if (freshness.state === "empty") {
    memoryCache.delete(key);
    return { entries: [], state: "empty", rebuilt: false };
  }
  if (freshness.state === "fresh") {
    let entries = memoryCache.get(key);
    if (entries === undefined) {
      const loaded = loadArtifact(namespacePath);
      if (loaded) {
        entries = loaded;
        memoryCache.set(key, loaded);
      }
    }
    if (entries) {
      return { entries, state: "fresh", rebuilt: false };
    }
    // Meta says fresh but the artifact is unreadable — rebuild below.
  }
  const inFlight = rebuildInFlight.get(key);
  if (inFlight) {
    const entries = await inFlight;
    return {
      entries,
      state: freshness.state,
      rebuilt: false,
    };
  }
  const run = rebuildKeysCache(namespacePath).finally(() => {
    rebuildInFlight.delete(key);
  });
  rebuildInFlight.set(key, run);
  const entries = await run;
  return { entries, state: freshness.state, rebuilt: entries !== null };
}

/**
 * Namespace path owning a partition path — walk up to the first directory
 * carrying manifest.json (same walk as squash.ts's private
 * findNamespacePath; shared here so rewrite hooks outside squash.ts can
 * invalidate without reaching into git/squash internals).
 */
export function namespacePathForPartition(
  partitionPath: string,
): string | null {
  let current = partitionPath;
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, "manifest.json"))) {
      return current;
    }
    current = path.dirname(current);
  }
  return null;
}
