/**
 * Namespace lifecycle — TWO DISTINCT DELETION PATHS (item 66, REVIEW-DUCKBRAIN-001/002).
 *
 * Bane, 2026-09-22: "we want namespaces removed from disk backups to of course
 * turn off but keep S3 version as needed" and "yes we need a path for deleting
 * name spaces from disk correctly and different for clearing from S3".
 *
 * Intended semantics:
 *  - deleteNamespaceFromDisk  — LOCAL ONLY. Removes the namespace directory
 *    (git repo + JSONL + embeddings), unregisters the config mapping, and
 *    prunes the per-namespace S3 sync manifest so no scheduled push ever
 *    touches the namespace again. The S3 objects remain untouched and fully
 *    retrievable (pull-on-demand restore path). Idempotent; refuses to run
 *    while a push is in flight.
 *  - clearNamespaceFromS3     — REMOTE ONLY. Lists every object under the
 *    namespace's S3 key prefix, requires an explicit confirm plus who/why,
 *    and deletes exactly those keys. Never touches local disk and is NOT
 *    reachable from the disk-deletion path (separate function, separate
 *    confirmation).
 *
 * Both paths log one JSONL line (who / what / why) to
 * `<namespacesPath>/.s3state/lifecycle.log`. Neither is wired into any
 * automatic flow: they are operator operations.
 */

import fs from "fs";
import path from "path";
import { deleteNamespace } from "./delete";
import {
  getConfig,
  resolveNamespacesPath,
  updateConfig,
} from "../config/index";
import type { S3Config } from "../s3/config";
import { resolveEffectiveEndpoint } from "../s3/config";
import { buildClient, listRemoteObjects, deleteObject } from "../s3/client";
import { stateDir, loadManifest, pruneSyncManifest } from "../s3/manifest";
import { namespacePath } from "../s3/sync";
import { hasInFlightPush } from "./inflight-push";

/** Where the who/why audit trail lives (JSONL, one line per operation). */
export function lifecycleLogPath(namespacesPath: string): string {
  return path.join(stateDir(namespacesPath), "lifecycle.log");
}

/** Append one JSONL audit line. Failures never break the operation. */
export function logLifecycle(
  namespacesPath: string,
  entry: Record<string, unknown>,
): void {
  try {
    fs.mkdirSync(path.dirname(lifecycleLogPath(namespacesPath)), {
      recursive: true,
    });
    fs.appendFileSync(
      lifecycleLogPath(namespacesPath),
      JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n",
      "utf-8",
    );
  } catch {
    // audit log is best-effort; the operation result is the source of truth
  }
}

/**
 * In-flight push detection moved to ./inflight-push (DF-0923-01) so the
 * shared deletion core can share it without an import cycle; re-exported
 * here for existing lifecycle importers.
 */
export { hasInFlightPush } from "./inflight-push";

/** Prune re-exported for lifecycle callers; implementation in s3/manifest. */

export interface DiskDeleteOptions {
  /** Must be true — the destructive gate. */
  confirm: boolean;
  /** Who asked (actor id, session, ticket). Recorded in the audit log. */
  requestedBy: string;
  /** Why. Recorded in the audit log. */
  reason?: string;
  /**
   * Override the config-resolved namespaces root (tests, tooling). Defaults to
   * the config value resolved against ".".
   */
  namespacesPath?: string;
}

export interface DiskDeleteResult {
  success: boolean;
  /** Absolute path of the removed local directory (when one existed). */
  path?: string;
  /** The S3 prefixes left untouched and still retrievable. */
  s3Preserved?: { bucket: string; prefix: string } | null;
  /** True when a scheduled-push manifest was pruned by this delete. */
  manifestPruned?: boolean;
  error?: string;
}

/**
 * Delete a namespace FROM DISK — local data, mapping, and sync manifest;
 * S3 objects are NOT touched.
 *
 * Idempotent: an already-gone namespace (mapping present, dir absent) still
 * succeeds and cleans the residue. Refuses while a push is in flight.
 */
export function deleteNamespaceFromDisk(
  name: string,
  opts: DiskDeleteOptions,
): DiskDeleteResult {
  if (!opts.confirm) {
    return {
      success: false,
      error: "Confirmation required. Pass confirm=true to delete from disk.",
    };
  }
  if (!opts.requestedBy || !opts.requestedBy.trim()) {
    return {
      success: false,
      error: "requestedBy is required (who/why audit).",
    };
  }

  const config = getConfig(".");
  // GAP-062: the sync/lifecycle root comes from the config file's own
  // directory, never the caller's cwd.
  const nsRoot = path.resolve(opts.namespacesPath ?? resolveNamespacesPath());

  // Refuse while a push is in flight — deleting mid-push half-lands the
  // namespace on S3 and recreates the ghost state this module exists to fix.
  const inflight = hasInFlightPush(nsRoot, name);
  if (inflight.inFlight) {
    return {
      success: false,
      error: `Push in flight for '${name}' (${inflight.detail}). Retry after it completes.`,
    };
  }

  // Delegate guards (confirm/default/active/traversal/idempotency) + physical
  // removal + mapping unregister to the shared deletion core (DOGFOOD-004 /
  // DB-GAP-032). This call never touches S3. The core prunes the sync
  // manifest itself (shared by MCP/HTTP paths); we only observe whether a
  // manifest existed before, so the report is honest even when the core did
  // the unlink.
  const manifestFile = path.join(stateDir(nsRoot), `${name}.json`);
  const hadManifest = fs.existsSync(manifestFile);

  const core = deleteNamespace(name, true);
  if (!core.success) {
    return { success: false, error: core.error };
  }

  // Local copy is gone → scheduled pushes must stop for it. Belt-and-braces:
  // prune here too (no-op when the core already removed it).
  pruneSyncManifest(nsRoot, name);
  const manifestPruned = hadManifest && !fs.existsSync(manifestFile);

  const s3 = config.s3?.enabled
    ? { bucket: config.s3.bucket, prefix: `${config.s3.prefix}/${name}/` }
    : null;

  logLifecycle(nsRoot, {
    op: "delete-from-disk",
    ns: name,
    requestedBy: opts.requestedBy,
    reason: opts.reason ?? "",
    localPath: core.path ?? null,
    manifestPruned,
    s3Preserved: s3 ? `${s3.bucket}/${s3.prefix}` : null,
  });

  return {
    success: true,
    path: core.path,
    s3Preserved: s3,
    manifestPruned,
  };
}

/** One object that a clear would remove (dry-run line / delete target). */
export interface S3ClearObject {
  key: string;
  size: number;
}

export interface S3ClearPlan {
  ns: string;
  bucket: string;
  /** Full key prefix every object below shares. */
  prefix: string;
  endpoint: string;
  /** Effective sync prefixes by layer, for the human summary. */
  layers: string[];
  objectCount: number;
  totalBytes: number;
  /** All objects up to MAX_PLAN_OBJECTS, then truncated=true. */
  objects: S3ClearObject[];
  truncated: boolean;
  /** True when the local directory still exists (clear is remote-only). */
  localStillExists: boolean;
  manifests: string[];
}

const MAX_PLAN_OBJECTS = 5000;

/**
 * DRY-RUN: enumerate exactly what a clear of `ns` would destroy.
 * Read-only — no confirm, no deletes. Never throws for an empty/absent
 * prefix (an empty plan is a valid answer: nothing to destroy).
 */
export async function planS3Clear(
  s3: S3Config,
  ns: string,
  opts?: { namespacesPath?: string },
): Promise<S3ClearPlan> {
  if (!ns || ns.includes("/") || ns === "." || ns === "..") {
    throw new Error(`Invalid namespace name: '${ns}'`);
  }
  const client = buildClient(s3);
  const prefix = `${s3.prefix}/${ns}/`;
  const remote = await listRemoteObjects(client, s3.bucket, prefix);

  // GAP-062: root from the config file's own directory (same rule as the
  // write paths), never the caller's cwd.
  const nsRoot = path.resolve(opts?.namespacesPath ?? resolveNamespacesPath());
  const manifests: string[] = [];
  for (const layer of ["current/git", "archives/git"]) {
    manifests.push(`s3://${s3.bucket}/${layer}/${ns} (git bundle layer)`);
  }

  const objects = [...remote.values()]
    .slice(0, MAX_PLAN_OBJECTS)
    .map((o) => ({ key: o.key, size: o.size }))
    .sort((a, b) => a.key.localeCompare(b.key));

  return {
    ns,
    bucket: s3.bucket,
    prefix,
    endpoint: resolveEffectiveEndpoint(s3) ?? "(AWS default endpoint)",
    layers: [
      `s3://${s3.bucket}/${prefix} (native delta sync objects)`,
      ...manifests,
    ],
    objectCount: remote.size,
    totalBytes: [...remote.values()].reduce((acc, o) => acc + o.size, 0),
    objects,
    truncated: remote.size > MAX_PLAN_OBJECTS,
    localStillExists: fs.existsSync(namespacePath(nsRoot, ns)),
    manifests,
  };
}

export interface S3ClearOptions {
  /** Must be true — the destructive gate. */
  confirm: boolean;
  /** Who asked. Required — the destructive op refuses without it. */
  requestedBy: string;
  /** Why. Required — the destructive op refuses without it. */
  reason: string;
  namespacesPath?: string;
}

export interface S3ClearResult {
  success: boolean;
  deleted: number;
  failed: number;
  plan: S3ClearPlan | null;
  error?: string;
}

/**
 * CLEAR A NAMESPACE FROM S3 — remote only; disk is never touched. Explicitly
 * NOT reachable from deleteNamespaceFromDisk: it lives here, takes its own
 * confirmation and its own who/why, and re-lists the prefix at execution time
 * so it destroys exactly what it announced.
 */
export async function clearNamespaceFromS3(
  s3: S3Config,
  ns: string,
  opts: S3ClearOptions,
): Promise<S3ClearResult> {
  if (!opts.confirm) {
    return {
      success: false,
      deleted: 0,
      failed: 0,
      plan: null,
      error:
        "Confirmation required. Run the dry-run (planS3Clear / 's3 clear <ns> --dry-run') first, then pass confirm=true.",
    };
  }
  if (!opts.requestedBy?.trim() || !opts.reason?.trim()) {
    return {
      success: false,
      deleted: 0,
      failed: 0,
      plan: null,
      error:
        "requestedBy and reason are required: a destructive S3 clear must record who and why.",
    };
  }

  // Re-list at execution time (TOCTOU-safe: destroys what exists NOW).
  const plan = await planS3Clear(s3, ns, opts);
  const client = buildClient(s3);
  let deleted = 0;
  let failed = 0;
  for (const obj of plan.objects) {
    try {
      await deleteObject(client, s3.bucket, obj.key);
      deleted++;
    } catch {
      failed++;
    }
  }

  // GAP-062: root from the config file's own directory, never the caller's cwd.
  const nsRoot = path.resolve(opts.namespacesPath ?? resolveNamespacesPath());
  // A cleared namespace must not be re-pushed by stale local state either.
  const manifestPruned = pruneSyncManifest(nsRoot, ns);

  logLifecycle(nsRoot, {
    op: "clear-from-s3",
    ns,
    requestedBy: opts.requestedBy,
    reason: opts.reason,
    bucket: s3.bucket,
    prefix: plan.prefix,
    objectCount: plan.objectCount,
    totalBytes: plan.totalBytes,
    deleted,
    failed,
    manifestPruned,
    localStillExists: plan.localStillExists,
  });

  return { success: failed === 0, deleted, failed, plan };
}

export interface GhostSweepPlan {
  /** Manifests whose namespace dir is gone (the ENOENT ghost class). */
  ghostManifests: { ns: string; lastSyncAt: string | null }[];
  /** Config mappings whose namespace dir is gone (board litter class). */
  ghostMappings: { name: string; recordedPath: string }[];
}

/**
 * Find ghost sync state + ghost mappings: state that outlives its namespace
 * dir. These manifests are what keep dead namespaces on every push cadence
 * (the "Namespace not found"/ENOENT retry class).
 */
export function findGhostSyncState(
  namespacesPath: string,
  opts?: { configDir?: string },
): GhostSweepPlan {
  const nsRoot = path.resolve(namespacesPath);
  const stateDirPath = stateDir(nsRoot);
  const ghostManifests: GhostSweepPlan["ghostManifests"] = [];

  let manifestNames: string[] = [];
  try {
    manifestNames = fs
      .readdirSync(stateDirPath)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length));
  } catch {
    // no state dir — no ghosts possible
  }
  for (const ns of manifestNames) {
    if (!fs.existsSync(namespacePath(nsRoot, ns))) {
      const m = loadManifest(nsRoot, ns);
      ghostManifests.push({ ns, lastSyncAt: m?.lastSyncAt ?? null });
    }
  }

  // Mappings pointing at dirs that no longer exist. Protected: the default
  // namespace and the current defaultNamespace (a vanished default is an
  // incident to repair, not litter to sweep).
  const cfg = getConfig(opts?.configDir ?? ".");
  const protectedNames = new Set<string>(["default"]);
  if (cfg.defaultNamespace) protectedNames.add(cfg.defaultNamespace);
  const ghostMappings: GhostSweepPlan["ghostMappings"] = [];
  for (const [name, recorded] of Object.entries(cfg.namespaceMappings ?? {})) {
    if (protectedNames.has(name)) continue;
    if (!fs.existsSync(path.resolve(recorded))) {
      ghostMappings.push({ name, recordedPath: recorded });
    }
  }

  return { ghostManifests, ghostMappings };
}

export interface GhostSweepResult {
  success: boolean;
  manifestsPruned: string[];
  mappingsRemoved: string[];
  error?: string;
}

/**
 * Sweep ghost manifests + ghost mappings. Confirm-gated + audited like the
 * destructive ops, though its blast radius is confined to state files:
 * manifests and mapping entries whose namespace dir is ALREADY gone.
 */
export function sweepGhostSyncState(
  namespacesPath: string,
  opts: {
    confirm: boolean;
    requestedBy: string;
    reason?: string;
    configDir?: string;
  },
): GhostSweepResult {
  if (!opts.confirm) {
    return {
      success: false,
      manifestsPruned: [],
      mappingsRemoved: [],
      error:
        "Confirmation required. Run findGhostSyncState for the dry-run listing, then pass confirm=true.",
    };
  }
  if (!opts.requestedBy?.trim()) {
    return {
      success: false,
      manifestsPruned: [],
      mappingsRemoved: [],
      error: "requestedBy is required (who/why audit).",
    };
  }

  const nsRoot = path.resolve(namespacesPath);
  const found = findGhostSyncState(nsRoot, {
    configDir: opts.configDir ?? ".",
  });

  const manifestsPruned: string[] = [];
  for (const g of found.ghostManifests) {
    if (pruneSyncManifest(nsRoot, g.ns)) manifestsPruned.push(g.ns);
  }

  // Mapping removal reuses updateConfig (atomic tmp+rename), removing exactly
  // the ghost names discovered above.
  const mappingsRemoved: string[] = [];
  if (found.ghostMappings.length > 0) {
    const cfg = getConfig(opts.configDir ?? ".");
    const ghostNames = new Set(found.ghostMappings.map((g) => g.name));
    const rest: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg.namespaceMappings ?? {})) {
      if (!ghostNames.has(k)) rest[k] = v;
    }
    updateConfig(opts.configDir ?? ".", { namespaceMappings: rest });
    mappingsRemoved.push(...found.ghostMappings.map((g) => g.name));
  }

  logLifecycle(nsRoot, {
    op: "sweep-ghost-sync-state",
    requestedBy: opts.requestedBy,
    reason: opts.reason ?? "",
    manifestsPruned,
    mappingsRemoved,
  });

  return { success: true, manifestsPruned, mappingsRemoved };
}
