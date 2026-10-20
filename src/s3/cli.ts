/**
 * `duckbrain s3` CLI — status / sync / query / config.
 *
 * Inert until s3.enabled=true in duckbrain.config.json (see docs/s3-native.md).
 *
 * Usage:
 *   duckbrain s3 status [ns] [--full] [--json]
 *                                     — effective config + per-ns sync state
 *   duckbrain s3 sync [ns|all] [push|pull]
 *   duckbrain s3 query "SELECT ..."   — SQL over s3:// via DuckDB httpfs
 *   duckbrain s3 config               — print effective config (no secrets)
 */

import path from "path";
import { getConfig, resolveDuckbrainRoot, resolveNamespacesPath } from "../config";
import { safeJsonStringify } from "../utils/serialize";
import { S3ConfigSchema, resolveEffectiveEndpoint } from "./config";
import { loadManifest } from "./manifest";
import { censusOnDiskNamespaces } from "../namespaces/census";
import {
  walkLocal,
  syncNamespace,
  syncAllNamespaces,
  listRemoteNamespaces,
} from "./sync";
import { runS3Query } from "./query";
import { listRemoteObjects, buildClient } from "./client";
import {
  findGhostSyncState,
  sweepGhostSyncState,
  clearNamespaceFromS3,
  planS3Clear,
  logLifecycle,
} from "../namespaces/lifecycle";

/**
 * S3-STATUS-001: the human `s3 status` report caps itself at this many
 * namespace rows. The cap is a DISPLAY decision only — it is always announced
 * (total count + a "... and N more" marker) and both `--full` and `--json`
 * render the complete list. Before this, `resolved.slice(0, 20)` silently
 * dropped namespaces 21..N, so a truncated report was indistinguishable from
 * a complete one.
 */
export const STATUS_ROW_LIMIT = 20;

/** `duckbrain s3 status` output options (S3-STATUS-001). */
export interface S3StatusOptions {
  /** Show every namespace instead of the first STATUS_ROW_LIMIT. */
  full?: boolean;
  /** Emit one JSON document (full list, no truncation) — machine-readable. */
  json?: boolean;
}

/** One per-namespace status row (the shape both the text and JSON paths use). */
export interface S3StatusRow {
  ns: string;
  local: number;
  remote: number | null;
  lastSync: string | null;
  registered: boolean;
  /** Set when the remote listing failed for this namespace (remote is null). */
  listError?: string;
}

const S3_USAGE = `duckbrain s3 — native S3 sync/query (status|sync|query|config|clear|ghosts).

Usage:
  duckbrain s3 status [ns] [--full] [--json]
                                    — effective config + per-ns sync state
                                      (default: first ${STATUS_ROW_LIMIT} namespaces + a
                                       truncation marker; --full shows all,
                                       --json emits the full list as JSON)
  duckbrain s3 sync [ns|all] [push|pull]
  duckbrain s3 query "SELECT ..."   — SQL over s3:// via DuckDB httpfs
  duckbrain s3 config               — print effective config (no secrets)
  duckbrain s3 clear <ns> --dry-run | --yes --requested-by=<who> --reason=<why>
                                    — DESTROY the namespace's remote S3 objects
                                      (disk untouched; separate op from delete)
  duckbrain s3 ghosts [--sweep --yes --requested-by=<who>]
                                    — list (or prune) sync state that outlives
                                      its namespace dir (stops ghost pushes)`;

/**
 * DF-2026-4: the directory that owns `duckbrain.config.json` for this
 * invocation.
 *
 * The dispatcher (`runHumanCLI`) passes `"."` meaning "no explicit directory".
 * That must mean the duckbrain ROOT — the rule GAP-062 established for every
 * other verb — and never `process.cwd()`. An explicitly supplied directory
 * (tests, embedders) is honored verbatim.
 */
function configRoot(configDir: string): string {
  return configDir === "" || configDir === "."
    ? resolveDuckbrainRoot()
    : configDir;
}

/**
 * Namespace storage root for every s3 verb.
 *
 * DF-2026-4: resolved through the SHARED resolver (`src/config/index.ts`,
 * GAP-062) instead of `path.resolve(configDir, cfg.namespacesPath)`. The old
 * arithmetic resolved a RELATIVE `namespacesPath` ("./namespaces") against
 * `process.cwd()` whenever configDir was ".", so `duckbrain s3 status|sync`
 * run from any other checkout looked at `<cwd>/namespaces` — reporting an
 * empty root (local=0, nothing to sync) while the real namespaces sat next to
 * the config file. `resolveNamespacesPath` honors DUCKBRAIN_CONFIG_PATH, then
 * DUCKBRAIN_HOME_ROOT, then the config-file walk, and never resolves the root
 * from the cwd for path arithmetic.
 */
function namespacesPath(configDir: string): string {
  return resolveNamespacesPath(configRoot(configDir));
}

function requireEnabled(configDir: string) {
  const cfg = getConfig(configRoot(configDir));
  if (!cfg.s3?.enabled) {
    console.error(
      'S3 is disabled. Set "s3": { "enabled": true, ... } in duckbrain.config.json — see docs/s3-native.md',
    );
    process.exit(1);
  }
  return cfg.s3;
}

/**
 * DF-0925-08: the `s3 status` namespace list is the UNION of the config
 * registry (`namespaceMappings`) and the on-disk namespaces root.
 *
 * The registry is not the whole truth: a namespace created through the HTTP /
 * MCP API exists as a directory under the namespaces root that may carry NO
 * mapping (the DB-GAP-057 registry split-brain shape). The previous
 * implementation listed the CONFIG keys whenever any mapping existed and only
 * scanned the directory when that list was empty — so such a namespace, which
 * exists, accepts writes and is actively pushed to S3, was invisible on its
 * own status surface.
 *
 * This reuses the same census the DB-GAP-057 listing surfaces share
 * (`src/namespaces/census.ts`), so every registry surface agrees about what
 * exists. Config-registered names keep their order; on-disk-only names are
 * appended once, so a name present in both halves is listed exactly once.
 */
export function unionNamespaceList(
  configNames: string[],
  onDiskNames: string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of configNames) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  for (const name of onDiskNames) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export async function s3Status(
  configDir: string,
  nsArg?: string,
  options: S3StatusOptions = {},
): Promise<void> {
  const full = options.full === true;
  const json = options.json === true;
  const cfg = getConfig(configRoot(configDir));
  const s3 = cfg.s3;
  const nsRoot = namespacesPath(configDir);

  // S3-STATUS-001: `--json` owns stdout — one JSON document and nothing else,
  // so the output is machine-readable (no header lines to strip).
  if (!json) {
    console.log("S3 config:", s3?.enabled ? "ENABLED" : "disabled");
  }
  if (!s3?.enabled) {
    if (json) {
      console.log(
        JSON.stringify({ enabled: false, total: 0, namespaces: [] }, null, 2),
      );
    }
    return;
  }

  if (!json) {
    console.log(`  endpoint: ${resolveEffectiveEndpoint(s3) ?? "(AWS default)"}`);
    console.log(`  bucket:   ${s3.bucket}  prefix: ${s3.prefix}`);
    console.log(
      `  pushOnCommit: ${s3.pushOnCommit}  intervalSec: ${s3.intervalSec}`,
    );
    console.log(`  pathStyle: ${s3.forcePathStyle}`);
  }

  // DF-0925-08: union the config registry with the on-disk census (never one
  // INSTEAD of the other). An explicit namespace argument still resolves to
  // exactly that namespace.
  const configNames = nsArg ? [nsArg] : Object.keys(cfg.namespaceMappings);
  const onDiskNames = nsArg ? [] : [...censusOnDiskNamespaces(nsRoot).keys()];
  const resolved = unionNamespaceList(configNames, onDiskNames);
  const registered = new Set(configNames);

  // S3-STATUS-001: a truncated report still has to look truncated. Only the
  // rows that will actually be rendered are probed, so the default path keeps
  // the original 20-listing network profile; `--full` / `--json` lift the cap
  // and therefore probe every namespace.
  const limit =
    full || json ? resolved.length : Math.min(resolved.length, STATUS_ROW_LIMIT);

  const client = buildClient(s3);
  const rows: S3StatusRow[] = [];
  for (const ns of resolved.slice(0, limit)) {
    const manifest = loadManifest(nsRoot, ns);
    const localCount = walkLocal(path.join(nsRoot, ns)).size;
    let remoteCount: number | null = null;
    let listError: string | undefined;
    try {
      const remote = await listRemoteObjects(
        client,
        s3.bucket,
        `${s3.prefix}/${ns}/`,
      );
      remoteCount = remote.size;
    } catch (err) {
      remoteCount = null;
      listError = (err as Error).message;
      // stderr, so a `--json` document on stdout stays parseable.
      console.warn(`  (list failed for ${ns}: ${listError})`);
    }
    rows.push({
      ns,
      local: localCount,
      remote: remoteCount,
      lastSync: manifest?.lastSyncAt ?? null,
      registered: registered.has(ns),
      ...(listError === undefined ? {} : { listError }),
    });
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          enabled: true,
          endpoint: resolveEffectiveEndpoint(s3) ?? null,
          bucket: s3.bucket,
          prefix: s3.prefix,
          total: rows.length,
          namespaces: rows,
        },
        null,
        2,
      ),
    );
    return;
  }

  // Total count is always printed — a cap without a denominator is exactly the
  // "looks complete but isn't" failure S3-STATUS-001 exists to kill.
  console.log(`Namespaces: ${resolved.length}`);
  for (const row of rows) {
    console.log(
      `  ${row.ns}: local=${row.local} remote=${row.remote ?? "?"} lastSync=${row.lastSync ?? "never"}${row.registered ? "" : " (on-disk only — no config mapping)"}`,
    );
  }
  const hidden = resolved.length - rows.length;
  if (hidden > 0) {
    console.log(`  ... and ${hidden} more (use --full to see all)`);
  }
}

export async function s3Sync(
  configDir: string,
  nsArg: string | undefined,
  direction: "push" | "pull",
): Promise<void> {
  const s3 = requireEnabled(configDir);
  const nsRoot = namespacesPath(configDir);
  if (nsArg && nsArg !== "all") {
    const stats = await syncNamespace(s3, nsArg, nsRoot, direction);
    if (stats) {
      console.log(
        `[S3] ${direction} ${stats.ns}: uploaded=${stats.uploaded} downloaded=${stats.downloaded} skipped=${stats.skipped} in ${stats.durationMs}ms`,
      );
    }
    return;
  }

  // `all pull` reports restored-vs-skipped and NEVER reports a silent zero:
  // if the remote prefix holds namespaces but nothing was restored (every
  // per-namespace sync failed), that is a failed restore — warn loudly and
  // exit nonzero. (DF-0925-07; the push summary stays as-is.)
  const all = await syncAllNamespaces(s3, nsRoot, direction);
  const total = all.reduce((acc, s) => acc + s.uploaded + s.downloaded, 0);
  console.log(
    `[S3] ${direction} complete: ${all.length} namespaces, ${total} files transferred`,
  );
  if (direction === "pull") {
    for (const s of all) {
      console.log(
        `[S3] pull ${s.ns}: downloaded=${s.downloaded} skipped=${s.skipped} in ${s.durationMs}ms`,
      );
    }
    let remoteCount = -1;
    try {
      remoteCount = (await listRemoteNamespaces(buildClient(s3), s3)).length;
    } catch (err) {
      console.warn(
        `[S3] remote listing for the restore summary failed: ${(err as Error).message}`,
      );
    }
    if (remoteCount > 0 && all.length === 0) {
      console.error(
        `[S3] WARNING: ${remoteCount} namespace(s) exist on S3 but ALL failed to restore (0 restored). Your namespaces root was NOT repopulated — check the per-namespace errors above.`,
      );
      process.exit(1);
    }
  }
}

export function formatS3Row(row: Record<string, unknown>): string {
  return safeJsonStringify(row);
}

export async function s3Query(configDir: string, sql: string): Promise<void> {
  const s3 = requireEnabled(configDir);
  if (!sql.trim()) {
    console.error(
      "Usage: duckbrain s3 query \"SELECT ... FROM read_json_auto('s3://bucket/prefix/ns/**/*.jsonl')\"",
    );
    process.exit(1);
  }
  const result = await runS3Query(s3, sql);
  console.log(`columns: ${result.columns.join(", ")}`);
  console.log(`rows: ${result.count}`);
  for (const row of result.rows.slice(0, 50)) {
    console.log(formatS3Row(row));
  }
  if (result.count > 50) console.log(`... ${result.count - 50} more`);
}

export function s3ConfigShow(configDir: string): void {
  const cfg = getConfig(configRoot(configDir));
  const parsed = S3ConfigSchema.parse(cfg.s3 ?? {});
  console.log(JSON.stringify(parsed, null, 2));
}

/** Parse `--flag` booleans and `--key=value` pairs from CLI args. */
function parseCliFlags(args: string[]): {
  flags: Record<string, string>;
  positional: string[];
} {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (const a of args) {
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 2) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else flags[a.slice(2)] = "true";
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

/**
 * `duckbrain s3 clear <ns>` — DESTROY the namespace's remote S3 objects.
 * Remote-only: local disk is never touched. Dry-run by default; the real run
 * requires --yes plus --requested-by and --reason (who/why audit).
 */
export async function s3Clear(
  configDir: string,
  args: string[],
): Promise<void> {
  const s3 = requireEnabled(configDir);
  const nsRoot = namespacesPath(configDir);
  const { flags, positional } = parseCliFlags(args);
  const ns = positional[0];
  if (!ns) {
    console.error(
      "Usage: duckbrain s3 clear <ns> --dry-run | --yes --requested-by=<who> --reason=<why>",
    );
    process.exit(1);
  }

  const dryRun = flags["dry-run"] !== undefined;
  const confirmed = flags["yes"] !== undefined;
  const requestedBy = flags["requested-by"] ?? "";
  const reason = flags["reason"] ?? "";

  if (dryRun) {
    const plan = await planS3Clear(s3, ns, { namespacesPath: nsRoot });
    console.log(`DRY-RUN — s3 clear ${ns} would destroy:`);
    console.log(`  endpoint: ${plan.endpoint}`);
    console.log(`  bucket:   ${plan.bucket}`);
    console.log(`  prefix:   ${plan.prefix}`);
    for (const layer of plan.layers) console.log(`  layer:    ${layer}`);
    console.log(
      `  objects:  ${plan.objectCount} (${plan.totalBytes} bytes)${plan.truncated ? " (listing truncated at 5000)" : ""}`,
    );
    console.log(
      `  local dir still exists: ${plan.localStillExists} (clear NEVER touches disk)`,
    );
    for (const o of plan.objects.slice(0, 20)) {
      console.log(`    ${o.key} (${o.size}B)`);
    }
    if (plan.objectCount > 20) {
      console.log(`    ... and ${plan.objectCount - 20} more`);
    }
    console.log(
      `Re-run with --yes --requested-by=<who> --reason=<why> to destroy these ${plan.objectCount} objects.`,
    );
    return;
  }

  const result = await clearNamespaceFromS3(s3, ns, {
    confirm: confirmed,
    requestedBy,
    reason,
    namespacesPath: nsRoot,
  });
  if (!result.success && result.error) {
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }
  console.log(
    `[S3] cleared ${ns}: deleted=${result.deleted} failed=${result.failed} (prefix ${result.plan?.prefix}, bucket ${result.plan?.bucket})`,
  );
  if (result.failed > 0) process.exit(1);
}

/**
 * `duckbrain s3 ghosts` — list sync state whose namespace dir is gone (the
 * ENOENT ghost-push class). `--sweep --yes` prunes the ghost manifests +
 * ghost mappings (never touches S3 objects, never touches a live namespace).
 */
export async function s3Ghosts(
  configDir: string,
  args: string[],
): Promise<void> {
  const nsRoot = namespacesPath(configDir);
  const { flags } = parseCliFlags(args);
  const sweep = flags["sweep"] !== undefined;

  if (!sweep) {
    const found = findGhostSyncState(nsRoot, { configDir });
    console.log(
      `Ghost sync manifests (dir gone, still on the push cadence): ${found.ghostManifests.length}`,
    );
    for (const g of found.ghostManifests) {
      console.log(`  ${g.ns} (lastSync ${g.lastSyncAt ?? "?"})`);
    }
    console.log(
      `Ghost config mappings (recorded path gone): ${found.ghostMappings.length}`,
    );
    for (const g of found.ghostMappings) {
      console.log(`  ${g.name} -> ${g.recordedPath}`);
    }
    if (found.ghostManifests.length === 0 && found.ghostMappings.length === 0) {
      console.log("No ghost sync state found.");
    } else {
      console.log(
        "Run with --sweep --yes --requested-by=<who> to prune this state (S3 objects untouched).",
      );
    }
    return;
  }

  const result = sweepGhostSyncState(nsRoot, {
    confirm: flags["yes"] !== undefined,
    requestedBy: flags["requested-by"] ?? "",
    reason: flags["reason"] ?? "ghost sync state sweep (s3 ghosts --sweep)",
    configDir,
  });
  if (!result.success && result.error) {
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }
  logLifecycle(nsRoot, {
    op: "s3-ghosts-sweep",
    manifestsPruned: result.manifestsPruned,
    mappingsRemoved: result.mappingsRemoved,
  });
  console.log(
    `[S3] ghost sweep: manifests pruned=${result.manifestsPruned.length}, mappings removed=${result.mappingsRemoved.length}`,
  );
  for (const ns of result.manifestsPruned) console.log(`  manifest: ${ns}`);
  for (const ns of result.mappingsRemoved) console.log(`  mapping:  ${ns}`);
}

export async function s3Command(
  args: string[],
  configDir = ".",
): Promise<void> {
  const sub = args[0];
  if (sub === undefined || sub === "" || sub === "--help" || sub === "-h") {
    console.log(S3_USAGE);
    return;
  }
  switch (sub) {
    case "status": {
      // S3-STATUS-001: `status` takes an optional namespace plus display
      // flags. Parsing here (not `args[1]`) keeps `s3 status --full` from
      // treating the flag as a namespace name.
      const { flags, positional } = parseCliFlags(args.slice(1));
      await s3Status(configDir, positional[0], {
        full: flags["full"] !== undefined,
        json: flags["json"] !== undefined,
      });
      break;
    }
    case "sync":
      await s3Sync(configDir, args[1], (args[2] as "push" | "pull") ?? "push");
      break;
    case "query":
      await s3Query(configDir, args.slice(1).join(" "));
      break;
    case "config":
      s3ConfigShow(configDir);
      break;
    case "clear":
      await s3Clear(configDir, args.slice(1));
      break;
    case "ghosts":
      await s3Ghosts(configDir, args.slice(1));
      break;
    default:
      console.error(
        `Unknown s3 subcommand: ${sub} (status|sync|query|config|clear|ghosts)`,
      );
      process.exit(1);
  }
}
