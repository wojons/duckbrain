/**
 * `duckbrain s3` CLI — status / sync / query / config.
 *
 * Inert until s3.enabled=true in duckbrain.config.json (see docs/s3-native.md).
 *
 * Usage:
 *   duckbrain s3 status [ns]          — effective config + per-ns sync state
 *   duckbrain s3 sync [ns|all] [push|pull]
 *   duckbrain s3 query "SELECT ..."   — SQL over s3:// via DuckDB httpfs
 *   duckbrain s3 config               — print effective config (no secrets)
 */

import path from "path";
import { getConfig } from "../config";
import { safeJsonStringify } from "../utils/serialize";
import { S3ConfigSchema, resolveEffectiveEndpoint } from "./config";
import { loadManifest } from "./manifest";
import { walkLocal, syncNamespace, syncAllNamespaces } from "./sync";
import { runS3Query } from "./query";
import { listRemoteObjects, buildClient } from "./client";
import {
  findGhostSyncState,
  sweepGhostSyncState,
  clearNamespaceFromS3,
  planS3Clear,
  logLifecycle,
} from "../namespaces/lifecycle";

const S3_USAGE = `duckbrain s3 — native S3 sync/query (status|sync|query|config|clear|ghosts).

Usage:
  duckbrain s3 status [ns]          — effective config + per-ns sync state
  duckbrain s3 sync [ns|all] [push|pull]
  duckbrain s3 query "SELECT ..."   — SQL over s3:// via DuckDB httpfs
  duckbrain s3 config               — print effective config (no secrets)
  duckbrain s3 clear <ns> --dry-run | --yes --requested-by=<who> --reason=<why>
                                    — DESTROY the namespace's remote S3 objects
                                      (disk untouched; separate op from delete)
  duckbrain s3 ghosts [--sweep --yes --requested-by=<who>]
                                    — list (or prune) sync state that outlives
                                      its namespace dir (stops ghost pushes)`;

function namespacesPath(configDir: string): string {
  const cfg = getConfig(configDir);
  return path.resolve(configDir, cfg.namespacesPath);
}

function requireEnabled(configDir: string) {
  const cfg = getConfig(configDir);
  if (!cfg.s3?.enabled) {
    console.error(
      'S3 is disabled. Set "s3": { "enabled": true, ... } in duckbrain.config.json — see docs/s3-native.md',
    );
    process.exit(1);
  }
  return cfg.s3;
}

export async function s3Status(
  configDir: string,
  nsArg?: string,
): Promise<void> {
  const cfg = getConfig(configDir);
  const s3 = cfg.s3;
  const nsRoot = namespacesPath(configDir);
  console.log("S3 config:", s3?.enabled ? "ENABLED" : "disabled");
  if (!s3?.enabled) return;
  console.log(`  endpoint: ${resolveEffectiveEndpoint(s3) ?? "(AWS default)"}`);
  console.log(`  bucket:   ${s3.bucket}  prefix: ${s3.prefix}`);
  console.log(
    `  pushOnCommit: ${s3.pushOnCommit}  intervalSec: ${s3.intervalSec}`,
  );
  console.log(`  pathStyle: ${s3.forcePathStyle}`);

  const nsList = nsArg
    ? [nsArg]
    : Object.values(cfg.namespaceMappings).length > 0
      ? Object.keys(cfg.namespaceMappings)
      : [];

  const resolved = nsList.length > 0 ? nsList : [];
  if (resolved.length === 0) {
    // no mappings configured — scan the namespaces dir
    const fs = await import("fs");
    const dirs = fs
      .readdirSync(nsRoot, { withFileTypes: true })
      .filter((e: any) => e.isDirectory() && !e.name.startsWith("."))
      .map((e: any) => e.name);
    resolved.push(...dirs);
  }

  const client = buildClient(s3);
  for (const ns of resolved.slice(0, 20)) {
    const manifest = loadManifest(nsRoot, ns);
    const localCount = walkLocal(path.join(nsRoot, ns)).size;
    let remoteCount = -1;
    try {
      const remote = await listRemoteObjects(
        client,
        s3.bucket,
        `${s3.prefix}/${ns}/`,
      );
      remoteCount = remote.size;
    } catch (err) {
      remoteCount = -2;
      console.warn(`  (list failed for ${ns}: ${(err as Error).message})`);
    }
    console.log(
      `  ${ns}: local=${localCount} remote=${remoteCount >= 0 ? remoteCount : "?"} lastSync=${manifest?.lastSyncAt ?? "never"}`,
    );
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
  } else {
    const all = await syncAllNamespaces(s3, nsRoot, direction);
    const total = all.reduce((acc, s) => acc + s.uploaded + s.downloaded, 0);
    console.log(
      `[S3] ${direction} complete: ${all.length} namespaces, ${total} files transferred`,
    );
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
  const cfg = getConfig(configDir);
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
    case "status":
      await s3Status(configDir, args[1]);
      break;
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
