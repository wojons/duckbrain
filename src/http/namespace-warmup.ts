/**
 * AUG-096: per-namespace warm-up at HTTP daemon startup — the DuckDB
 * singleton connections (attempt 1) AND the scoped-search cold path
 * (rework).
 *
 * Two cold cliffs exist on the first scoped request after a daemon restart:
 *
 *   1. DuckDB singleton connection (per-process scratch file in os.tmpdir(),
 *      see singletonDbPath in src/duckdb/connection.ts) PLUS the first
 *      read_json scan over the namespace's partition JSONL files. Measured
 *      2026-10-13 (live daemon, healthy embedding provider): a first scoped
 *      `GET /api/memories?namespace=<fresh>&q=...` cost 0.87-3.17s while the
 *      same query on the (already warm) default namespace cost 0.1-0.2s.
 *
 *   2. The keyword leg of ?q= (recallTool → keywordSearch → ensureFreshIndex
 *      → rebuildNamespaceIndex): a full JSON.parse of every source JSONL, a
 *      staged rows.tmp.jsonl, INSTALL/LOAD fts, CREATE TABLE, INSERT
 *      read_json, PRAGMA create_fts_index — measured 933ms for 3272 rows
 *      (namespaces/default/.search/meta.json durationMs). A namespace whose
 *      sidecar is missing or predates its newest source write pays the whole
 *      rebuild on the FIRST ?q=. The semantic leg's on-the-fly embedding of
 *      uncached candidates is per-request provider cost and is deliberately
 *      NOT warmed (no pre-embedding of arbitrary texts).
 *
 * The fix: at daemon startup, enumerate every manifest namespace
 * (listNamespaces from src/search/index.ts — directories carrying a
 * manifest.json; on-disk census as fallback) and, per namespace:
 *   1. create the singleton connection (getDuckDBConnection("singleton", ..))
 *   2. when the manifest lists partitions with JSONL chunks, run one trivial
 *      queryMemories page (limit 1) to force the first partition scan
 *   3. run the SAME bounded ensureFreshIndex the ?q= path calls, so the FTS
 *      sidecar is built at boot and the first request reads warm state
 *   4. initialize EmbeddingCache.forNamespace (cache dir open/warm — never
 *      pre-embedding)
 *
 * Contract (all load-bearing):
 *   - NON-BLOCKING: startNamespaceWarmup() is fire-and-forget — the caller
 *     never awaits it and listen() is never delayed.
 *   - FAILURE-TOLERANT PER NAMESPACE: a namespace that fails to warm is
 *     logged as a warning and skipped; its half-open connection is evicted
 *     so the first real request starts clean. The daemon never crashes or
 *     refuses traffic because of warm-up.
 *   - BOUNDED: the whole pass runs under an overall wall-clock budget
 *     (DUCKBRAIN_WARM_BUDGET_MS, default 300000) and each namespace under a
 *     per-namespace wait (DUCKBRAIN_WARM_PER_NAMESPACE_TIMEOUT_MS, default
 *     30000). A namespace already in flight when the budget expires is
 *     allowed to finish; nothing new starts after it. A per-namespace
 *     timeout stops WAITING (native DuckDB work is not cancellable — the
 *     background warm still finishes and leaves a good connection behind),
 *     logs the skip, and does NOT evict: slow is not broken.
 *   - PARALLEL, CAPPED: namespaces warm concurrently with a small worker
 *     pool (DUCKBRAIN_WARM_CONCURRENCY, default 4) so hundreds of
 *     namespaces do not serialize.
 *   - OPT-OUT: DUCKBRAIN_WARM_NAMESPACES=0 (or "false") disables the whole
 *     pass; unset or "1" keeps it on (default enabled).
 */

import fs from "fs";
import path from "path";
import { getDuckDBConnection, evictConnection } from "../duckdb/connection";
import { queryMemories, collectJsonlFiles } from "../duckdb/queries";
import { censusOnDiskNamespaces } from "../namespaces/census";
import { resolveNamespacesPath } from "../config/index";
import { ensureFreshIndex, listNamespaces } from "../search/index";
import { EmbeddingCache } from "../embedding/cache";

/**
 * DUCKBRAIN_WARM_NAMESPACES guard — default enabled.
 *
 * "0" / "false" (any case) disables; anything else (including unset)
 * enables. Lenient parsing matches the other boolean env knobs
 * (DUCKBRAIN_NAMESPACES_AUTOCREATE=false pattern).
 */
export function isNamespaceWarmupEnabled(): boolean {
  const value = process.env.DUCKBRAIN_WARM_NAMESPACES;
  if (value === undefined || value === "") return true;
  return value !== "0" && value.toLowerCase() !== "false";
}

/** Overall wall-clock budget for the whole warm-up pass (see header). */
export const WARM_BUDGET_ENV = "DUCKBRAIN_WARM_BUDGET_MS";
export const DEFAULT_WARM_BUDGET_MS = 300_000;

/** Per-namespace wait bound (see header). */
export const WARM_PER_NAMESPACE_TIMEOUT_ENV =
  "DUCKBRAIN_WARM_PER_NAMESPACE_TIMEOUT_MS";
export const DEFAULT_WARM_PER_NAMESPACE_TIMEOUT_MS = 30_000;

/** Concurrent namespace warm-ups (worker-pool width). */
export const WARM_CONCURRENCY_ENV = "DUCKBRAIN_WARM_CONCURRENCY";
export const DEFAULT_WARM_CONCURRENCY = 4;

/**
 * Positive-integer env parsing: unset / empty / non-numeric / <= 0 →
 * fallback. Every warm-up knob uses the same lenient contract (a malformed
 * value never disables or unbounds warm-up; it falls back to the default).
 */
function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function warmBudgetMs(): number {
  return positiveIntEnv(WARM_BUDGET_ENV, DEFAULT_WARM_BUDGET_MS);
}

export function warmPerNamespaceTimeoutMs(): number {
  return positiveIntEnv(
    WARM_PER_NAMESPACE_TIMEOUT_ENV,
    DEFAULT_WARM_PER_NAMESPACE_TIMEOUT_MS,
  );
}

export function warmConcurrency(): number {
  return positiveIntEnv(WARM_CONCURRENCY_ENV, DEFAULT_WARM_CONCURRENCY);
}

/** Per-namespace warm-up outcome, one row per enumerated namespace. */
export interface NamespaceWarmResult {
  /** Namespace directory name (also the ?namespace= request value). */
  namespace: string;
  /** Absolute namespace directory (the singleton cache key). */
  namespacePath: string;
  /** true when connection (+ first scan, when data exists) completed. */
  warmed: boolean;
  /** Wall-clock ms spent on this namespace. */
  warmMs: number;
  /** Whether a trivial queryMemories page was actually run. */
  scanned: boolean;
  /**
   * Search-leg freshness as observed BEFORE warm ("missing" | "stale" |
   * "fresh" from indexFreshness). Present after the search leg ran.
   */
  searchFreshness?: string;
  /** True when warm-up itself rebuilt the FTS sidecar. */
  searchRebuilt?: boolean;
  /**
   * Set when the search leg could not be warmed (ensureFreshIndex refusal
   * such as an over-bound row count, or a failure). The first request will
   * retry through its own ensureFreshIndex as before.
   */
  searchSkipReason?: string;
  /** True when the embedding cache directory was opened/created. */
  embeddingCacheReady?: boolean;
  /** Present only when the namespace failed to warm (skipped). */
  error?: string;
}

/**
 * Warm ONE namespace: create its singleton DuckDB connection and, when the
 * manifest lists partitions that actually hold JSONL chunks, run one trivial
 * queryMemories page (limit 1) to force DuckDB's first read_json scan; then
 * warm the search leg — the SAME bounded ensureFreshIndex the ?q= path
 * calls (so a boot-built sidecar is exactly what the first request reads)
 * — and open the EmbeddingCache directory.
 *
 * Never throws: any failure evicts the half-open connection (so the first
 * real request starts from a clean slate) and is reported on the result.
 * The search leg is failure-tolerant independently of the connection leg: a
 * refused/failed rebuild records `searchSkipReason` and the request path
 * keeps its pre-existing rebuild-before-answer behavior.
 *
 * The manifest is validated: a PRESENT but unparseable manifest.json is a
 * warm-up FAILURE (warmed:false, error string, connection evicted) — DF-1013-02.
 * Grading a corrupt namespace as warmed lied at boot while the API correctly
 * rejects the namespace at request time; the failure is now warned and
 * SKIPPED per the failure-tolerant contract. An ABSENT manifest stays
 * legitimate connection-only warm-up (manifest namespaces always carry one;
 * bare directories are enumerated only via the census fallback).
 *
 * @param namespacePath - Absolute namespace directory (singleton cache key)
 */
export async function warmNamespace(
  namespacePath: string,
): Promise<NamespaceWarmResult> {
  const startedAt = Date.now();
  const namespace = path.basename(namespacePath);
  let scanned = false;
  const result: NamespaceWarmResult = {
    namespace,
    namespacePath,
    warmed: false,
    warmMs: 0,
    scanned: false,
  };
  try {
    // 1. Connection creation: scratch file + VSS-free Database init — the
    // first half of the cold cliff.
    const db = getDuckDBConnection("singleton", namespacePath);

    // 2. First-scan forcing — mirror exactly how recallTool derives
    // partitionPaths from the manifest (relative entries joined onto the
    // namespace dir), then pay one limit-1 page so DuckDB opens and binds
    // every chunk file once in THIS process.
    const manifestPath = path.join(namespacePath, "manifest.json");
    let partitionPaths: string[] = [];
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
        partitionPaths = (manifest.partitions ?? []).map((p: string) =>
          path.join(namespacePath, p),
        );
      } catch (error) {
        // PRESENT but unparseable manifest = warm-up FAILURE (DF-1013-02):
        // grading this namespace "warmed" lied at boot — the API rejects it
        // at request time. Throw into the outer handler: it evicts the
        // half-open connection and returns warmed:false + error, which
        // logNamespaceWarmup() renders as a skipped warning.
        throw new Error(
          `manifest.json is corrupt (unparseable): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (collectJsonlFiles(partitionPaths).length > 0) {
      scanned = true;
      await queryMemories(db, partitionPaths, { limit: 1 });
    }
    result.scanned = scanned;

    // 3. Search leg (AUG-096 rework): build the FTS sidecar at boot when it
    // is missing/stale, with the exact bounded, single-flight seam the ?q=
    // path calls (measured: 933ms rebuild for 3272 rows landed on the first
    // scoped request before this). Never throws; a refusal (over-bound row
    // count) or failure is recorded and retried by the request path.
    try {
      const ensured = await ensureFreshIndex(namespacePath);
      result.searchFreshness = ensured.freshness.state;
      result.searchRebuilt = ensured.rebuilt;
      if (ensured.reason) result.searchSkipReason = ensured.reason;
    } catch (error) {
      result.searchSkipReason =
        error instanceof Error ? error.message : String(error);
    }

    // 4. Embedding cache: open/warm the per-namespace cache directory so
    // the first semantic request does not pay first-touch creation. Vectors
    // are NEVER pre-embedded — that would be arbitrary provider spend.
    try {
      const cache = EmbeddingCache.forNamespace(namespacePath);
      fs.mkdirSync(cache.root, { recursive: true });
      result.embeddingCacheReady = true;
    } catch (error) {
      result.embeddingCacheReady = false;
      if (!result.searchSkipReason) {
        result.searchSkipReason = `embedding cache: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }

    result.warmed = true;
    result.warmMs = Date.now() - startedAt;
    return result;
  } catch (error) {
    // Drop the possibly-broken cached connection so the first REAL request
    // recreates it instead of inheriting a warm-up-time failure.
    try {
      evictConnection(namespacePath);
    } catch {
      // Never let cleanup shadow the original failure.
    }
    return {
      namespace,
      namespacePath,
      warmed: false,
      warmMs: Date.now() - startedAt,
      scanned,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Run `fn` over `items` with at most `limit` concurrent invocations
 * (worker-pool: each worker dequeues the next index when its current item
 * settles). `fn` must never reject (callers handle their own errors).
 */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        await fn(items[index]);
      }
    },
  );
  await Promise.all(workers);
}

/**
 * Resolve a namespace's warm result under a time bound. The bound stops
 * WAITING only — native DuckDB work cannot be cancelled, so the background
 * warm still finishes and leaves a valid connection behind. That is why a
 * timeout does NOT evict (slow is not broken) and reports itself loudly.
 */
function withTimeout(
  pending: Promise<NamespaceWarmResult>,
  namespace: string,
  namespacePath: string,
  ms: number,
): Promise<NamespaceWarmResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<NamespaceWarmResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        namespace,
        namespacePath,
        warmed: false,
        warmMs: ms,
        scanned: false,
        error: `timed out after ${ms}ms (${WARM_PER_NAMESPACE_TIMEOUT_ENV}) — still warming in the background`,
      });
    }, ms);
    timer.unref?.();
  });
  return Promise.race([pending, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Warm every manifest namespace under the namespaces root.
 *
 * Enumeration: listNamespaces() (directories carrying a manifest.json — the
 * same definition the search tooling uses) is PRIMARY; when it yields
 * nothing but the on-disk census finds directories, the census is used as a
 * fallback so a root of not-yet-manifested namespaces still warms. Namespace
 * warm-ups run through a worker pool (DUCKBRAIN_WARM_CONCURRENCY, default
 * 4), the whole pass under an overall budget (DUCKBRAIN_WARM_BUDGET_MS,
 * default 300s) checked before each start, and each namespace under a
 * per-namespace wait (DUCKBRAIN_WARM_PER_NAMESPACE_TIMEOUT_MS, default 30s).
 *
 * @returns One result row per enumerated namespace, sorted by name.
 */
export async function warmManifestNamespaces(): Promise<NamespaceWarmResult[]> {
  try {
    const nsRoot = resolveNamespacesPath();
    let names = listNamespaces(nsRoot);
    if (names.length === 0) {
      const census = censusOnDiskNamespaces(nsRoot);
      if (census.size > 0) {
        console.error(
          `[duckbrain] Namespace warm-up: no manifest namespaces under ${nsRoot} — falling back to the on-disk census (${census.size} dir(s))`,
        );
        names = [...census.keys()].sort();
      }
    }

    const results: NamespaceWarmResult[] = [];
    const deadline = Date.now() + warmBudgetMs();
    const perNsTimeoutMs = warmPerNamespaceTimeoutMs();
    let budgetExhausted = false;
    const budgetMessage = `warm-up budget exhausted before start (${WARM_BUDGET_ENV})`;

    await mapWithConcurrency(names, warmConcurrency(), async (name) => {
      const namespacePath = path.join(nsRoot, name);
      if (budgetExhausted || Date.now() >= deadline) {
        budgetExhausted = true;
        results.push({
          namespace: name,
          namespacePath,
          warmed: false,
          warmMs: 0,
          scanned: false,
          error: budgetMessage,
        });
        return;
      }
      const remaining = deadline - Date.now();
      const bound = Math.min(perNsTimeoutMs, remaining);
      results.push(
        await withTimeout(
          warmNamespace(namespacePath),
          name,
          namespacePath,
          bound,
        ),
      );
    });

    return results.sort((a, b) => a.namespace.localeCompare(b.namespace));
  } catch (error) {
    // Enumeration itself failed (config/root resolution) — warn and warm
    // nothing; the daemon serves lazily-created connections as before.
    console.error(
      `[duckbrain] Namespace warm-up skipped: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}

/**
 * Log the warm-up summary: per-namespace warm-up ms on one line, failures
 * as individual warnings.
 *
 * Format (single line, greppable):
 *   [duckbrain] Namespace warm-up: 3 namespace(s) warmed in 2712ms
 *   [default=812ms scanned idx=rebuilt, df15=1900ms scanned, tiny=0ms connection-only]
 *   [duckbrain] Namespace warm-up: namespace 'broken' failed in 12ms and was
 *   skipped: <error message>
 */
export function logNamespaceWarmup(results: NamespaceWarmResult[]): void {
  const failures = results.filter((r) => !r.warmed);
  for (const failure of failures) {
    console.error(
      `[duckbrain] Namespace warm-up: namespace '${failure.namespace}' failed in ${failure.warmMs}ms and was skipped: ${failure.error}`,
    );
  }
  const warmed = results.filter((r) => r.warmed);
  if (warmed.length === 0 && failures.length === 0) return;
  const totalMs = results.reduce((sum, r) => sum + r.warmMs, 0);
  const detail = results
    .map((r) => {
      let tag = `${r.namespace}=${r.warmMs}ms`;
      tag += r.warmed
        ? r.scanned
          ? " scanned"
          : " connection-only"
        : " SKIPPED";
      if (r.warmed && r.searchRebuilt) tag += " idx=rebuilt";
      else if (r.warmed && r.searchFreshness === "fresh") tag += " idx=fresh";
      if (r.warmed && r.searchSkipReason) {
        tag += ` idx=skipped(${r.searchSkipReason})`;
      }
      return tag;
    })
    .join(", ");
  console.error(
    `[duckbrain] Namespace warm-up: ${warmed.length} namespace(s) warmed, ${failures.length} skipped, ${totalMs}ms total [${detail}]`,
  );
}

/**
 * Fire-and-forget startup warm-up for the HTTP daemon.
 *
 * Called from startHttpMode AFTER the listeners are bound — it never delays
 * listen() and its failures never affect traffic (every path above is
 * failure-tolerant by contract). DUCKBRAIN_WARM_NAMESPACES=0 disables the
 * whole pass.
 *
 * @returns The warm-up promise (callers may ignore it; it never rejects).
 */
export function startNamespaceWarmup(): Promise<NamespaceWarmResult[]> {
  if (!isNamespaceWarmupEnabled()) {
    console.error(
      "[duckbrain] Namespace warm-up disabled (DUCKBRAIN_WARM_NAMESPACES)",
    );
    return Promise.resolve([]);
  }
  return warmManifestNamespaces()
    .then((results) => {
      logNamespaceWarmup(results);
      return results;
    })
    .catch((error) => {
      // Belt-and-braces: warmManifestNamespaces already catches internally;
      // this guard only keeps an unexpected rejection unhandled.
      console.error(
        `[duckbrain] Namespace warm-up failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    });
}
