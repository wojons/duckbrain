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

const S3_USAGE = `duckbrain s3 — native S3 sync/query (status|sync|query|config).

Usage:
  duckbrain s3 status [ns]          — effective config + per-ns sync state
  duckbrain s3 sync [ns|all] [push|pull]
  duckbrain s3 query "SELECT ..."   — SQL over s3:// via DuckDB httpfs
  duckbrain s3 config               — print effective config (no secrets)`;

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
    default:
      console.error(`Unknown s3 subcommand: ${sub} (status|sync|query|config)`);
      process.exit(1);
  }
}
