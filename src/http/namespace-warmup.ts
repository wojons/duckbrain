/**
 * AUG-096: per-namespace DuckDB connection warm-up at HTTP daemon startup.
 *
 * Per-namespace singleton connections are LAZY: the first scoped semantic
 * request in a process pays connection creation (per-process scratch file in
 * os.tmpdir(), see singletonDbPath in src/duckdb/connection.ts) PLUS the
 * first read_json scan over the namespace's partition JSONL files. Measured
 * 2026-10-13 (live daemon, healthy embedding provider): a first scoped
 * `GET /api/memories?namespace=<fresh>&q=...` cost 0.87-3.17s while the same
 * query on the (already warm) default namespace cost 0.1-0.2s. Every
 * auger recall-bearing surface (recall, check, /api/recall, POST /check,
 * serve search) pays that cliff once per namespace per daemon restart.
 *
 * The fix: at daemon startup, enumerate every on-disk namespace (the SAME
 * census GET /api/namespaces unions — src/namespaces/census.ts, which is
 * also the directory-aware truth request-time resolution lands on via
 * resolveNamespacePath = <namespacesPath>/<name>) and, per namespace:
 *   1. create the singleton connection (getDuckDBConnection("singleton", ..))
 *   2. when the manifest lists partitions with JSONL chunks, run one trivial
 *      queryMemories page (limit 1) to force the first partition scan
 *
 * Contract (all three load-bearing):
 *   - NON-BLOCKING: startNamespaceWarmup() is fire-and-forget — the caller
 *     never awaits it and listen() is never delayed.
 *   - FAILURE-TOLERANT: a namespace that fails to warm is logged as a
 *     warning and skipped; its half-open connection is evicted so the first
 *     real request starts clean. The daemon never crashes or refuses
 *     traffic because of warm-up.
 *   - OPT-OUT: DUCKBRAIN_WARM_NAMESPACES=0 (or "false") disables the whole
 *     pass; unset or "1" keeps it on (default enabled).
 */

import fs from "fs";
import path from "path";
import { getDuckDBConnection, evictConnection } from "../duckdb/connection";
import { queryMemories, collectJsonlFiles } from "../duckdb/queries";
import { censusOnDiskNamespaces } from "../namespaces/census";
import { resolveNamespacesPath } from "../config/index";

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

/** Per-namespace warm-up outcome, one row per census entry. */
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
  /** Present only when the namespace failed to warm (skipped). */
  error?: string;
}

/**
 * Warm ONE namespace: create its singleton DuckDB connection and, when the
 * manifest lists partitions that actually hold JSONL chunks, run one trivial
 * queryMemories page (limit 1) to force DuckDB's first read_json scan.
 *
 * Never throws: any failure evicts the half-open connection (so the first
 * real request starts from a clean slate) and is reported on the result.
 *
 * The manifest is parsed defensively — a corrupted manifest yields zero
 * partitions (connection-only warm-up), exactly like the request path's
 * `JSON.parse(fs.readFileSync(manifestPath))` falling back to `[]` in
 * recallTool; a warm-up must never be stricter than the request it fronts.
 *
 * @param namespacePath - Absolute namespace directory (singleton cache key)
 */
export async function warmNamespace(
  namespacePath: string,
): Promise<NamespaceWarmResult> {
  const startedAt = Date.now();
  const namespace = path.basename(namespacePath);
  let scanned = false;
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
      } catch {
        // Corrupted manifest → connection-only warm-up (request path does
        // the same fallback).
        partitionPaths = [];
      }
    }

    if (collectJsonlFiles(partitionPaths).length > 0) {
      scanned = true;
      await queryMemories(db, partitionPaths, { limit: 1 });
    }

    return {
      namespace,
      namespacePath,
      warmed: true,
      warmMs: Date.now() - startedAt,
      scanned,
    };
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
 * Warm every on-disk namespace, sequentially.
 *
 * Sequential keeps the cold-path cost (DuckDB Database init + extension
 * load) single-stream and each per-ns timing meaningful; the whole pass
 * runs in the background after listen(), so total duration does not delay
 * readiness. The census is the SAME one the namespaces REST route unions
 * (DB-GAP-057): directories under resolveNamespacesPath() — which is also
 * where request-time resolution (resolveNamespacePath) sends every
 * ?namespace=<name> lookup.
 *
 * @returns One result row per census entry, census (readdir) order.
 */
export async function warmManifestNamespaces(): Promise<NamespaceWarmResult[]> {
  try {
    const nsRoot = resolveNamespacesPath();
    const census = censusOnDiskNamespaces(nsRoot);
    const results: NamespaceWarmResult[] = [];
    for (const [, namespacePath] of census) {
      results.push(await warmNamespace(namespacePath));
    }
    return results;
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
 *   [default=812ms scanned, df15=1900ms scanned, tiny=0ms connection-only]
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
    .map(
      (r) =>
        `${r.namespace}=${r.warmMs}ms${r.warmed ? (r.scanned ? " scanned" : " connection-only") : " SKIPPED"}`,
    )
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
