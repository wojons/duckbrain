/**
 * S3-READ-AMPLIFICATION-001 — a read plan for wildcard `s3 query` statements.
 *
 * Fragmentation is cheap to create and expensive to READ: one production
 * partition (coding-hermes/config/2026-08) holds 10,002 objects — one 46MB
 * segment plus ~10,000 three-line files — and 112,311 rows in total. Measured
 * against the live bucket on 2026-11-05: one object = 10.27s wall, five =
 * 16.10s, twenty = 17.36s, so the marginal cost is ~0.3-0.4s per object and is
 * dominated by per-request overhead, not bytes. A wildcard read of that
 * partition therefore needs ~10,000 GETs (~an hour) and does not finish inside
 * a five-minute budget.
 *
 * httpfs will happily start that scan and say nothing for an hour. This module
 * is the CHEAP question asked first: a LIST of the pattern's prefix (ten pages
 * of 1,000 keys for 10,002 objects, ~5.5s measured) turned into
 *   - how many objects the pattern matches,
 *   - their total and typical size and the single largest object,
 *   - the wall-clock estimate at the MEASURED per-object cost,
 * and a loud refusal above a budget, naming the compaction that makes the read
 * cheap (duckbrain squash --segments merges near-empty segments at the
 * 1000-line/1MB rotation bound).
 *
 * Non-wildcard paths cost nothing: no LIST is issued and behaviour is
 * unchanged. A plan that cannot be built (no credentials, endpoint down) never
 * blocks the query — it warns and lets the read report its own failure, so
 * this preflight can only add information, never a new way to fail.
 */

import type { S3Config } from "./config";
import { buildClient, listRemoteObjects } from "./client";

/**
 * Measured per-object cost of an httpfs wildcard read (2026-11-05 probe:
 * 10.27s / 16.10s / 17.36s for 1 / 5 / 20 objects in
 * coding-hermes/config/2026-08 — ~6.7s fixed + ~0.35s per object). The midpoint
 * is used so an estimate is never optimistic by a factor of two.
 */
export const MEASURED_PER_OBJECT_SECONDS = 0.35;

/** Objects a wildcard read may cover before it must be asked for explicitly. */
export const DEFAULT_MAX_WILDCARD_OBJECTS = 500;

export interface ReadPlanObject {
  /** Full object address, `s3://bucket/key` — what the pattern is matched against. */
  key: string;
  bytes: number;
}

/** Lists every object under an `s3://bucket/prefix` path. */
export type ObjectLister = (pathPrefix: string) => Promise<ReadPlanObject[]>;

export interface S3PathRef {
  /** The `s3://...` path exactly as it appears in the SQL. */
  path: string;
  /** Longest wildcard-free prefix of the path (`s3://bucket/a/b/`). */
  prefix: string;
  wildcard: boolean;
}

export interface WildcardReadPlan {
  path: string;
  prefix: string;
  /** Objects the glob matches (not merely objects under the prefix). */
  objectCount: number;
  totalBytes: number;
  largest: ReadPlanObject | undefined;
  /** Wall-clock estimate at MEASURED_PER_OBJECT_SECONDS. */
  estimatedSeconds: number;
  maxObjects: number;
  overBudget: boolean;
  /** `<namespace>` / `<domain>/<YYYY-MM>` when the path has the namespace shape. */
  namespace: string | undefined;
  partition: string | undefined;
}

/** Refusal carrying the plan that produced it, so callers can print or test it. */
export class S3ManyObjectsError extends Error {
  readonly plan: WildcardReadPlan;
  constructor(message: string, plan: WildcardReadPlan) {
    super(message);
    this.name = "S3ManyObjectsError";
    this.plan = plan;
  }
}

const S3_PATH_RE = /s3:\/\/[^\s"'`),;]+/g;

/**
 * Every distinct `s3://` path in the statement, with its wildcard-free prefix.
 *
 * Paths are taken verbatim out of the SQL text: this reads the statement the
 * caller is about to run, not a paraphrase of it.
 */
export function extractS3Paths(sql: string): S3PathRef[] {
  const seen = new Set<string>();
  const out: S3PathRef[] = [];
  for (const match of sql.matchAll(S3_PATH_RE)) {
    const raw = match[0];
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push({
      path: raw,
      prefix: wildcardFreePrefix(raw),
      wildcard: isWildcard(raw),
    });
  }
  return out;
}

export function isWildcard(path: string): boolean {
  return /[*?[]/.test(path);
}

/**
 * The path truncated at the first segment that contains a wildcard.
 *
 * `s3://b/ns/config/2026-08/*.jsonl` -> `s3://b/ns/config/2026-08/`. Only this
 * prefix is LISTed; the glob decides which of its keys are read.
 */
export function wildcardFreePrefix(path: string): string {
  const scheme = "s3://";
  if (!path.startsWith(scheme)) return path;
  const rest = path.slice(scheme.length);
  const segments = rest.split("/");
  const keep: string[] = [];
  for (const seg of segments) {
    if (isWildcard(seg)) break;
    keep.push(seg);
  }
  // A fully wildcard-free path IS its own prefix.
  if (keep.length === segments.length) return path;
  const joined = keep.join("/");
  return `${scheme}${joined.endsWith("/") || joined === "" ? joined : `${joined}/`}`;
}

/**
 * Glob -> RegExp, shell semantics: `*` and `?` stop at `/`, `**` crosses them,
 * `[...]` is a character class. A wildcard read of a partition is a flat
 * `*.jsonl` in practice; the recursive form stays honest for `**`.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i += 1;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (ch === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close === -1) {
        re += "\\[";
      } else {
        re += glob.slice(i, close + 1);
        i = close;
      }
    } else {
      re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${re}$`);
}

/** `<namespace>` and `<domain>/<YYYY-MM>` from the standard namespace layout. */
export function describePartition(
  path: string,
  cfg: Pick<S3Config, "bucket" | "prefix">,
): { namespace: string | undefined; partition: string | undefined } {
  const rest = path.startsWith("s3://") ? path.slice("s3://".length) : path;
  const slash = rest.indexOf("/");
  const key = slash === -1 ? "" : rest.slice(slash + 1);
  const prefix = (cfg.prefix ?? "").replace(/^\/+|\/+$/g, "");
  const rel = prefix && key.startsWith(`${prefix}/`) ? key.slice(prefix.length + 1) : key;
  const segments = rel.split("/");
  if (segments.length >= 4 && /^\d{4}-\d{2}$/.test(segments[2]!)) {
    return { namespace: segments[0], partition: `${segments[1]}/${segments[2]}` };
  }
  return { namespace: undefined, partition: undefined };
}

/** `10002` -> `10,002` — grouping is fixed, never locale-dependent. */
export function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Seconds -> `2s` / `1m 05s` / `58m 21s` / `1h 02m`. */
export function formatEstimate(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  if (minutes < 60) return `${minutes}m ${String(secs).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** The default lister: the SDK chain, one paginated LIST of the prefix. */
export function sdkLister(cfg: S3Config): ObjectLister {
  return async (pathPrefix: string) => {
    const rest = pathPrefix.startsWith("s3://")
      ? pathPrefix.slice("s3://".length)
      : pathPrefix;
    const slash = rest.indexOf("/");
    const bucket = slash === -1 ? rest : rest.slice(0, slash);
    const keyPrefix = slash === -1 ? "" : rest.slice(slash + 1);
    const client = buildClient(cfg);
    try {
      const objects = await listRemoteObjects(client, bucket || cfg.bucket, keyPrefix);
      return Array.from(objects.values(), (o) => ({
        key: `s3://${bucket || cfg.bucket}/${o.key}`,
        bytes: o.size,
      }));
    } finally {
      client.destroy();
    }
  };
}

export interface PlanOptions {
  listObjects?: ObjectLister;
  maxObjects?: number;
  perObjectSeconds?: number;
}

/**
 * Build one plan per wildcard path in the statement (none -> no LIST at all).
 *
 * Listing failures are returned as `error` on the plan rather than thrown: a
 * preflight that cannot see the bucket must not become a new way for the query
 * to fail before it starts.
 */
export async function planWildcardReads(
  sql: string,
  cfg: S3Config,
  options: PlanOptions = {},
): Promise<Array<{ plan?: WildcardReadPlan; error?: string; path: string }>> {
  const wildcards = extractS3Paths(sql).filter((p) => p.wildcard);
  if (wildcards.length === 0) return [];
  const list = options.listObjects ?? sdkLister(cfg);
  const maxObjects = options.maxObjects ?? DEFAULT_MAX_WILDCARD_OBJECTS;
  const perObjectSeconds = options.perObjectSeconds ?? MEASURED_PER_OBJECT_SECONDS;

  const out: Array<{ plan?: WildcardReadPlan; error?: string; path: string }> = [];
  for (const ref of wildcards) {
    let objects: ReadPlanObject[];
    try {
      objects = await list(ref.prefix);
    } catch (err) {
      out.push({
        path: ref.path,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const matcher = globToRegExp(ref.path);
    const matched = objects.filter((o) => matcher.test(o.key));
    let totalBytes = 0;
    let largest: ReadPlanObject | undefined;
    for (const o of matched) {
      totalBytes += o.bytes;
      if (!largest || o.bytes > largest.bytes) largest = o;
    }
    const { namespace, partition } = describePartition(ref.path, cfg);
    out.push({
      path: ref.path,
      plan: {
        path: ref.path,
        prefix: ref.prefix,
        objectCount: matched.length,
        totalBytes,
        largest,
        estimatedSeconds: matched.length * perObjectSeconds,
        maxObjects,
        overBudget: matched.length > maxObjects,
        namespace,
        partition,
      },
    });
  }
  return out;
}

/** The refusal/warning body: count, cost, layout, and the cheap alternative. */
export function formatReadPlanWarning(plan: WildcardReadPlan): string {
  const lines: string[] = [];
  lines.push(
    `s3 query: this wildcard read of ${plan.path} matches ${formatCount(plan.objectCount)} ` +
      `object${plan.objectCount === 1 ? "" : "s"} (${formatCount(plan.totalBytes)} bytes). ` +
      `At the measured ~${MEASURED_PER_OBJECT_SECONDS}s per-object GET that is about ` +
      `${formatEstimate(plan.estimatedSeconds)} before the first row comes back.`,
  );
  if (plan.largest) {
    const others = plan.objectCount - 1;
    const otherAvg = others > 0 ? Math.round((plan.totalBytes - plan.largest.bytes) / others) : 0;
    lines.push(
      `Fragment layout: the largest object is ${plan.largest.key} at ` +
        `${formatCount(plan.largest.bytes)} bytes` +
        (others > 0
          ? `; the other ${formatCount(others)} object${others === 1 ? "" : "s"} average ` +
            `${formatCount(otherAvg)} bytes each — this partition is thousands of near-empty segments, ` +
            `not a few big files.`
          : `.`),
    );
  }
  const target =
    plan.namespace && plan.partition
      ? ` --partition=${plan.partition} --namespace=${plan.namespace}`
      : "";
  lines.push(
    `Compacted alternative: \`duckbrain squash --segments${target}\` merges near-empty segments up to ` +
      `the 1000-line/1MB rotation bound, so at the byte bound alone these ${formatCount(plan.totalBytes)} ` +
      `bytes become ~${formatCount(estimatedCompactedObjects(plan))} objects instead of ` +
      `${formatCount(plan.objectCount)} and the read drops from ${formatEstimate(plan.estimatedSeconds)} to ` +
      `seconds (the 1000-line bound can leave more; --dry-run prints the exact segment count).`,
  );
  lines.push(
    `Re-run with --allow-many-objects to pay for the full scan, or --max-objects=<N> to raise the ` +
      `budget above ${formatCount(plan.maxObjects)}.`,
  );
  return lines.join("\n");
}

/**
 * What compaction would leave behind: segments at the 1000-line / 1MB rotation
 * bound, i.e. total bytes / 1MB, floored at one object per non-empty partition.
 */
export function estimatedCompactedObjects(plan: WildcardReadPlan): number {
  const MB = 1024 * 1024;
  return Math.max(1, Math.ceil(plan.totalBytes / MB));
}
