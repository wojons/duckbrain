/**
 * Native S3 support for DuckBrain — prepared but NOT activated (2026-08-07).
 *
 * Features (see docs/s3-native.md):
 *  - incremental raw-file sync (push/pull) to any S3-compatible bucket
 *  - pushOnCommit: piggyback on the gitBatching debounce window (~30s RPO)
 *  - SQL over S3 via DuckDB httpfs (query the backup without restoring)
 *  - per-namespace manifests + cross-process lock
 *
 * Activation: set "s3": { "enabled": true, ... } in duckbrain.config.json.
 * Everything is inert while enabled=false.
 */

export * from "./config";
export * from "./client";
export * from "./manifest";
export * from "./sync";
export * from "./query";

import path from "path";
import { getConfig } from "../config";
import { syncNamespace } from "./sync";

/**
 * Fire-and-forget hook for the autocommit flush path (src/git/autocommit.ts).
 * Guarded by s3.enabled && s3.pushOnCommit — completely inert by default.
 * Never blocks the write path: the sync runs on a zero-delay timer and all
 * failures are logged, never thrown.
 */
export function maybeSyncOnCommit(namespacePathArg: string): void {
  try {
    const cfg = getConfig(".");
    if (!cfg.s3?.enabled || !cfg.s3.pushOnCommit) return;
    const ns = path.basename(namespacePathArg);
    setTimeout(() => {
      const s3 = cfg.s3!;
      syncNamespace(s3, ns, cfg.namespacesPath, "push").catch((err) => {
        console.warn(`[S3] pushOnCommit failed for ${ns}: ${(err as Error).message}`);
      });
    }, 0);
  } catch {
    // config unreadable — stay inert
  }
}
