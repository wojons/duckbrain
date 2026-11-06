/**
 * OBSDB-005 — storage-footprint measurement for the scrape surface.
 *
 * `docs/observability-spec.md` §2 blind spot #8 ("is data growing? will the
 * disk fill?") and §3.2 rows `duckbrain_storage_namespaces_bytes` /
 * `duckbrain_storage_embedding_cache_bytes`. The facts already exist on disk —
 * `namespaces/` is the fleet's memory substrate and `EmbeddingCache.sizeBytes()`
 * (src/embedding/cache.ts) can measure one namespace's `.embeddings` tree — but
 * nothing ever turned them into a number a scraper can read. Sharp edge: the
 * only code that calls `sizeBytes()` today is a human, and the live directory is
 * 9.2 GB, so "nobody noticed" is a disk-full incident waiting for a date.
 *
 * DESIGN — collect-time, never a background timer. The spec is explicit that
 * the daemon must not gain a loop, so measurement happens when a scrape asks
 * for it (prom-client `collect`), with two guards that make that safe:
 *
 *   - TTL cache (default 60 s): a 15 s scrape interval must not re-walk half a
 *     million files fifteen times a minute. The cached value is the LAST REAL
 *     MEASUREMENT — never a fabricated 0 — and `createStorageSampler` returns
 *     `null` (⇒ no sample at all) until the first measurement completes.
 *   - single-flight: concurrent scrapes share one walk instead of racing N
 *     walks over the same tree; the second caller gets the previous completed
 *     value rather than blocking a scrape indefinitely.
 *
 * BYTES ARE THE WHOLE NAMESPACES TREE. `duckbrain_storage_namespaces_bytes` is
 * the sum of every regular file under the configured namespaces path — JSONL
 * memories, DuckDB files, `.duckbrain-audit/` ledgers, `.embeddings/` caches —
 * because that is exactly what `du -sb <namespaces>` reports and what fills the
 * disk. `duckbrain_storage_embedding_cache_bytes` is the SUBSET under
 * `.embeddings/` directories, i.e. the derivable-artifact footprint a rebuild
 * could reclaim (cache.ts's own contract: embeddings are never source of
 * truth). Symlinks are not followed and not followed-through: `du` does not
 * follow them either, and following them would let a stray link make one tree
 * look like another.
 *
 * FAILURE BEHAVIOUR — a walk that throws (EACCES on one namespace, a race with
 * a delete) never turns into a zero: the failing entry is skipped, and a total
 * failure leaves the sampler returning `null`, which the metrics layer renders
 * as NO SAMPLE rather than "0 bytes of memory". A green 0 on a 9 GB store is
 * the exact lie this row exists to prevent.
 */

import fs from "fs";
import path from "path";

/** The per-namespace embedding cache directory (src/embedding/cache.ts). */
export const EMBEDDING_CACHE_DIR = ".embeddings";

/** Steady-state reuse window for one storage walk (a scrape is not a walk). */
export const STORAGE_SCAN_TTL_MS = 60_000;

/** Parallel `stat` calls per directory chunk. Bounded, so a huge directory
 * cannot open thousands of descriptors at once, and serial enough that the
 * event loop keeps serving requests while the walk runs. */
const STAT_CONCURRENCY = 64;

export interface StorageUsage {
  /** Every regular file under the namespaces root (the `du -sb` number). */
  namespacesBytes: number;
  /** The `.embeddings/` subset of the above (derivable cache footprint). */
  embeddingCacheBytes: number;
  /** Files counted — proof the walk actually traversed the tree. */
  files: number;
}

/** One empty measurement — used as the accumulator, never published. */
function emptyUsage(): StorageUsage {
  return { namespacesBytes: 0, embeddingCacheBytes: 0, files: 0 };
}

/** True when `file` sits anywhere below a `.embeddings/` directory. */
export function isEmbeddingCachePath(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  if (rel === "" || rel.startsWith("..")) return false;
  return rel.split(path.sep).includes(EMBEDDING_CACHE_DIR);
}

/**
 * Sum every regular file under `namespacesPath`.
 *
 * Never throws for a per-entry failure (a namespace deleted mid-walk, a
 * permission hole): that entry is skipped. It throws only when the root
 * itself cannot be read, which is the caller's cue that no measurement
 * exists — not that the store is empty.
 */
export async function measureStorageUsage(
  namespacesPath: string,
): Promise<StorageUsage> {
  const root = path.resolve(namespacesPath);
  const usage = emptyUsage();

  const addFiles = async (dir: string, names: string[]): Promise<void> => {
    for (let index = 0; index < names.length; index += STAT_CONCURRENCY) {
      const chunk = names.slice(index, index + STAT_CONCURRENCY);
      const stats = await Promise.all(
        chunk.map(async (name) => {
          const full = path.join(dir, name);
          try {
            const stat = await fs.promises.stat(full);
            return { full, stat };
          } catch {
            return null; // vanished or unreadable — skipped, never zeroed
          }
        }),
      );
      for (const entry of stats) {
        if (!entry || !entry.stat.isFile()) continue;
        usage.namespacesBytes += entry.stat.size;
        usage.files += 1;
        if (isEmbeddingCachePath(root, entry.full)) {
          usage.embeddingCacheBytes += entry.stat.size;
        }
      }
    }
  };

  const walk = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (dir === root) throw error;
      return; // a single unreadable subtree is skipped, not fatal
    }
    const files: string[] = [];
    const dirs: string[] = [];
    for (const entry of entries) {
      // Symlinks are neither followed nor counted: du does not follow them.
      if (entry.isDirectory()) dirs.push(path.join(dir, entry.name));
      else if (entry.isFile()) files.push(entry.name);
    }
    await addFiles(dir, files);
    for (const child of dirs) await walk(child);
  };

  await walk(root);
  return usage;
}

export interface StorageSamplerOptions {
  /** Resolved namespaces root. A getter so the daemon can pass a late value. */
  namespacesPath: () => string;
  /** Reuse window (default STORAGE_SCAN_TTL_MS). */
  ttlMs?: number;
  /** Clock seam (tests). */
  now?: () => number;
  /** Measurement seam (tests): defaults to measureStorageUsage. */
  measure?: (namespacesPath: string) => Promise<StorageUsage>;
}

export interface StorageSampler {
  /**
   * The current measurement, or `null` when none has ever completed.
   * Never fabricates a value: no measurement means no sample.
   */
  read(): Promise<StorageUsage | null>;
}

/**
 * TTL-cached, single-flight wrapper around `measureStorageUsage`.
 *
 * A scrape with a warm cache costs nothing; a cold scrape starts one walk; a
 * scrape that arrives while a walk is in flight gets the previous completed
 * value (or `null`) instead of stacking a second walk over the same tree.
 */
export function createStorageSampler(
  options: StorageSamplerOptions,
): StorageSampler {
  const ttlMs = options.ttlMs ?? STORAGE_SCAN_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const measure = options.measure ?? measureStorageUsage;

  let cached: { at: number; usage: StorageUsage } | null = null;
  let inFlight: Promise<StorageUsage | null> | null = null;

  return {
    async read(): Promise<StorageUsage | null> {
      if (cached && now() - cached.at < ttlMs) return cached.usage;
      if (inFlight) return cached?.usage ?? null;
      inFlight = (async () => {
        try {
          const usage = await measure(options.namespacesPath());
          // A failed walk keeps the previous value (a stale-but-real number)
          // instead of publishing a 0 the store does not have.
          cached = { at: now(), usage };
          return usage;
        } catch {
          return cached?.usage ?? null;
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    },
  };
}
