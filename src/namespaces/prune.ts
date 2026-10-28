/**
 * DB-GAP-065 — dead-mapping reaper for the namespace registry.
 *
 * `duckbrain.config.json` → `namespaceMappings` accumulates rows whose
 * resolved directory no longer exists on disk (namespace dirs removed
 * out-of-band, scratch dirs reaped, tmp trees cleaned). GET /api/namespaces
 * already FLAGS them (`directoryMissing: true`, REG-GONE-001) but nothing ever
 * removed them, so the registry grew without bound.
 *
 * This module computes and applies that removal. It is exposed to operators as
 * `duckbrain namespaces prune` (src/cli/namespaces-prune.ts) with dry-run as
 * the DEFAULT — nothing is written unless `--apply` is passed.
 *
 * Guarantees:
 *  - EXACT removal set: a mapping is removed if and only if its resolved path
 *    does not exist on disk. A mapping whose directory exists is never touched
 *    (values are carried through byte-identically).
 *  - Path safety: refuses (keeps, and reports as an error) any dead mapping
 *    whose resolved path escapes the namespaces root. The rule is the SAME
 *    guard the delete-namespace path uses (checkNamespacePathSafety in
 *    ./delete) — a prune must never be a way to reach foreign paths.
 *  - Idempotent: a second `--apply` after a successful run finds zero dead
 *    rows and writes nothing.
 *  - Crash-safe: exactly one config write per run, through updateConfig's
 *    tmp+fsync+rename path, guarded by the mtime/size stamp captured when the
 *    plan was computed (a concurrent writer aborts the apply instead of being
 *    clobbered).
 *  - Manifest hygiene: the matching `<namespacesRoot>/.s3state/<ns>.json`
 *    sync manifest is pruned for each removed namespace AFTER the config write
 *    lands, so scheduled pushes stop for rows that no longer exist (S3 objects
 *    themselves are never touched).
 */

import fs from "fs";
import path from "path";
import {
  getConfig,
  resolveNamespacesPath,
  statConfigFile,
  updateConfig,
} from "../config/index";
import type { ConfigFileStamp } from "../config/index";
import { checkNamespacePathSafety } from "./delete";
import { manifestFilePath, pruneSyncManifest } from "../s3/manifest";

/** One registry row examined by a prune plan. */
export interface PruneRow {
  /** Registry key (namespace name). */
  name: string;
  /** The raw value stored in namespaceMappings (relative or absolute). */
  path: string;
  /** Absolute path the value resolves to. */
  resolvedPath: string;
}

/** A dead row the prune REFUSES to remove (path escapes the namespaces root). */
export interface PruneRefusal extends PruneRow {
  reason: string;
}

/** Read-only view of what a prune would do. Computed without writing. */
export interface NamespacePrunePlan {
  /** Absolute namespaces root the path-safety guard is anchored to. */
  namespacesRoot: string;
  /** Mappings whose directory exists — never removed. */
  live: PruneRow[];
  /** Mappings whose directory is gone — the exact removal set. */
  dead: PruneRow[];
  /** Dead mappings refused by the path-safety guard (kept, reported). */
  refused: PruneRefusal[];
  /** Config file size in bytes when the plan was computed. */
  bytesBefore: number;
  /**
   * Config identity captured at plan time — handed to updateConfig so a
   * concurrent writer between read and write aborts the apply.
   */
  stamp: ConfigFileStamp | null;
}

/** Result of an applied prune. */
export interface NamespacePruneApplyResult {
  /** Rows removed from the registry (the plan's dead set). */
  removed: PruneRow[];
  /** Absolute paths of the `.s3state/<ns>.json` manifests pruned. */
  manifestsPruned: string[];
  /** Config size before / after the single atomic write. */
  bytesBefore: number;
  bytesAfter: number;
}

/**
 * Compute the prune plan for the ACTIVE config (honors DUCKBRAIN_CONFIG_PATH /
 * DUCKBRAIN_NAMESPACES_PATH). Pure read: no file is written or created.
 *
 * Dead rows are ordered by name so repeated runs print a stable set.
 */
export function planNamespacePrune(): NamespacePrunePlan {
  const config = getConfig(".");
  const mappings = config.namespaceMappings ?? {};
  const namespacesRoot = path.resolve(resolveNamespacesPath());
  const stamp = statConfigFile(".");

  const live: PruneRow[] = [];
  const dead: PruneRow[] = [];
  const refused: PruneRefusal[] = [];

  for (const [name, recordedPath] of Object.entries(mappings)) {
    // Same guard the deletion path uses (DB-GAP-065 AC-3): resolution is
    // anchored to the config-file-owned root, not the process cwd, so relative
    // registry values (`namespaces/<ns>`) resolve exactly like the HTTP/MCP
    // surfaces do.
    const safety = checkNamespacePathSafety(recordedPath, namespacesRoot);
    const row: PruneRow = {
      name,
      path: recordedPath,
      resolvedPath: safety.resolvedPath,
    };

    // A broken symlink is "no directory" — existsSync follows the link, so a
    // dangling target is correctly treated as gone.
    if (fs.existsSync(safety.resolvedPath)) {
      live.push(row);
      continue;
    }

    if (!safety.inside) {
      refused.push({
        ...row,
        reason: `resolved path escapes the namespaces root (${namespacesRoot})`,
      });
      continue;
    }

    dead.push(row);
  }

  dead.sort((a, b) => a.name.localeCompare(b.name));
  refused.sort((a, b) => a.name.localeCompare(b.name));
  live.sort((a, b) => a.name.localeCompare(b.name));

  return {
    namespacesRoot,
    live,
    dead,
    refused,
    bytesBefore: stamp?.size ?? 0,
    stamp,
  };
}

/**
 * Apply a plan: one atomic config write removing exactly the dead rows, then
 * manifest cleanup for those names.
 *
 * Throws when the config file changed between plan and apply (concurrent
 * writer) — nothing is written in that case. Refused rows are NOT removed and
 * are not an error here; callers report them and decide the exit code.
 */
export function applyNamespacePrune(
  plan: NamespacePrunePlan,
): NamespacePruneApplyResult {
  if (plan.dead.length === 0) {
    // Nothing to do — and deliberately no write, so a no-op run cannot bump
    // the config's mtime (idempotency is observable, not just logical).
    return {
      removed: [],
      manifestsPruned: [],
      bytesBefore: plan.bytesBefore,
      bytesAfter: plan.bytesBefore,
    };
  }

  const current = getConfig(".").namespaceMappings ?? {};
  const deadNames = new Set(plan.dead.map((row) => row.name));

  const remaining: Record<string, string> = {};
  for (const [name, recordedPath] of Object.entries(current)) {
    if (deadNames.has(name)) continue;
    remaining[name] = recordedPath;
  }

  // Defensive: the removal set must be exactly the dead set. If a row we mean
  // to remove is no longer present, or the surviving count is inconsistent,
  // the registry changed on disk under us — abort rather than write a set we
  // did not compute (updateConfig's own stamp guard is the primary check;
  // this one catches a semantic change that leaves size/mtime equal).
  if (Object.keys(remaining).length !== Object.keys(current).length - deadNames.size) {
    throw new Error(
      "Namespace registry changed on disk since the prune plan was computed — re-run 'duckbrain namespaces prune'.",
    );
  }

  updateConfig(
    ".",
    { namespaceMappings: remaining },
    { expectedStamp: plan.stamp, fsync: true },
  );

  // Only AFTER the registry write landed: stop scheduled pushes for names that
  // no longer exist. A crash between the two leaves a stale manifest (swept by
  // `duckbrain s3 ghosts`), never a live namespace without its manifest.
  const manifestsPruned: string[] = [];
  for (const row of plan.dead) {
    if (pruneSyncManifest(plan.namespacesRoot, row.name)) {
      manifestsPruned.push(manifestFilePath(plan.namespacesRoot, row.name));
    }
  }

  return {
    removed: plan.dead,
    manifestsPruned,
    bytesBefore: plan.bytesBefore,
    bytesAfter: statConfigFile(".")?.size ?? plan.bytesBefore,
  };
}
