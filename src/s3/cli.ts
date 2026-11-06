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
import {
  freshnessFromFiles,
  loadPushRun,
  loadPushState,
  type PushRunRecord,
} from "./freshness";
import { censusOnDiskNamespaces } from "../namespaces/census";
import {
  walkLocal,
  syncNamespace,
  syncAllNamespacesResult,
  listRemoteNamespaces,
} from "./sync";
import { runS3Query } from "./query";
import {
  findGhostSyncState,
  sweepGhostSyncState,
  clearNamespaceFromS3,
  planS3Clear,
  logLifecycle,
} from "../namespaces/lifecycle";

import type { S3Client } from "@aws-sdk/client-s3";
import type { S3Config } from "./config";

/**
 * S3-STATUS-SCALE-001: the S3 SDK is imported LAZILY. `s3 status` without
 * `--verify` makes no bucket request, so loading @aws-sdk/client-s3 (~150ms of
 * startup on this host) on the recorded path was pure cost against the 2s
 * budget the row sets.
 */
type S3ClientModule = typeof import("./client.js");

/** Load the S3 SDK surface only when a verb actually talks to the bucket. */
async function loadS3ClientModule(): Promise<S3ClientModule> {
  return await import("./client.js");
}

/**
 * S3-STATUS-001: the human `s3 status` report caps itself at this many
 * namespace rows. The cap is a DISPLAY decision only — it is always announced
 * (total count + a "... and N more" marker) and both `--full` and `--json`
 * render the complete list. Before this, `resolved.slice(0, 20)` silently
 * dropped namespaces 21..N, so a truncated report was indistinguishable from
 * a complete one.
 */
export const STATUS_ROW_LIMIT = 20;

/**
 * S3-STATUS-SCALE-001: how many objects `s3 status --verify` lists when the
 * caller does not say, and the ceiling it REFUSES to cross without an explicit
 * `--allow-many-objects`.
 *
 * Status used to LIST every object in the namespace on every call. For
 * scheduler (258,578 objects) that is ~23 ListObjectsV2 pages — measured
 * 5,504ms for 10,002 objects, and `s3 status scheduler --json` produced no
 * output at all inside a 60s budget. The namespace most in need of a status
 * check was the one whose check could not finish, so the default path now
 * answers from the push manifest (already written on every push) and a bucket
 * comparison is a bounded SAMPLE the caller asks for.
 */
export const S3_VERIFY_SAMPLE_DEFAULT = 1000;
export const S3_VERIFY_SAMPLE_MAX = 5000;

/**
 * S3-STATUS-SCALE-001: the local half has the same pathology as the remote
 * half. Enumerating scheduler's 261,094 directory entries costs ~0.94s on this
 * host (and statSync-ing each file ~1.1s), all of it to produce `local=` and
 * `unpushed=` — so a namespace whose RECORD already says it holds more than
 * this many objects is not walked by default; the row says so and `--deep`
 * measures it on request. A recorded count is data-driven and deterministic;
 * a wall-clock budget would make the same command report different things.
 */
export const S3_LOCAL_WALK_MAX = 100_000;

/** `duckbrain s3 status` output options (S3-STATUS-001). */
export interface S3StatusOptions {
  /** Show every namespace instead of the first STATUS_ROW_LIMIT. */
  full?: boolean;
  /** Emit one JSON document (full list, no truncation) — machine-readable. */
  json?: boolean;
  /** S3-STATUS-SCALE-001: compare a bounded remote sample (--verify). */
  verify?: boolean;
  /** How many objects that sample may list (--sample=N). */
  sample?: number;
  /** Lift the S3_VERIFY_SAMPLE_MAX budget (--allow-many-objects). */
  allowManyObjects?: boolean;
  /**
   * S3-STATUS-SCALE-001: measure live local state (`local=`, `unpushed=`) even
   * for a namespace above the local-walk budget.
   */
  deep?: boolean;
  /** Override S3_LOCAL_WALK_MAX for this call (--local-walk-max=N). */
  localWalkMax?: number;
}

/**
 * S3-STATUS-SCALE-001: the outcome of comparing a bounded remote sample with
 * the push manifest. `drift` is the number of sampled objects the record does
 * not explain, so "recorded" can never masquerade as "verified".
 */
export interface S3VerifySample {
  /** Objects the caller allowed us to list. */
  requested: number;
  /** Objects actually listed (<= requested). */
  listed: number;
  /** True when S3 says the prefix holds more than this page. */
  truncated: boolean;
  /** Listed objects absent from the manifest (written by someone else/since). */
  unrecorded: number;
  /** Listed objects whose size disagrees with the manifest record. */
  mismatched: number;
  /** unrecorded + mismatched — the sample's disagreement with the record. */
  drift: number;
  /** Up to five example keys behind `drift`, relative to the namespace. */
  examples: string[];
  elapsedMs: number;
}

/** One per-namespace status row (the shape both the text and JSON paths use). */
export interface S3StatusRow {
  ns: string;
  /**
   * Live syncable files on disk. `null` when the tree was not walked because
   * its recorded population exceeds S3_LOCAL_WALK_MAX — `localOmitted` says so
   * and `--deep` measures it (S3-STATUS-SCALE-001).
   */
  local: number | null;
  /** Why `local` is null (never a bare null — the reason travels with it). */
  localOmitted?: string;
  remote: number | null;
  /**
   * S3-SYNC-STOPPED-001: staleness as a number, not an inference. `lastSync`
   * (the manifest) is written by pull as well as push, so it cannot answer
   * "when did this host last PUT these bytes" — `lastPushAt` can.
   */
  lastPushAt?: string | null;
  lastPushAgeSeconds?: number | null;
  lastPushOk?: boolean | null;
  /** Local syncable files not covered by the last clean push (names in JSON). */
  unpushed?: number;
  unpushedSample?: string[];
  lastSync: string | null;
  registered: boolean;
  /**
   * S3-STATUS-SCALE-001: object count and bytes as RECORDED by the last push
   * manifest. Free (the manifest is already open), and the count the default
   * `s3 status` path answers with — no bucket request.
   */
  objectsRecorded?: number | null;
  bytesRecorded?: number | null;
  /**
   * Where this row's object count came from: "recorded" (manifest — may be
   * stale) or "verified" (a live, bounded sample). Never assume freshness of
   * a recorded count; the label is the difference.
   */
  countSource?: "recorded" | "verified";
  /** Present only when --verify ran: what the sample found. */
  verify?: S3VerifySample;
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
  duckbrain s3 status [ns] --verify [--sample=N] [--allow-many-objects]
                                    — compare a BOUNDED remote sample against
                                      the push manifest and report drift.
                                      Default path never lists the bucket;
                                      --sample defaults to ${S3_VERIFY_SAMPLE_DEFAULT},
                                      above ${S3_VERIFY_SAMPLE_MAX} requires --allow-many-objects
  duckbrain s3 status [ns] --deep    — also walk the live local tree for
                                      local=/unpushed= on a namespace above
                                      ${S3_LOCAL_WALK_MAX} recorded objects
                                      (--local-walk-max=N overrides the budget)
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

/**
 * SURFACE-HTTP-OPS-001: the machine-readable `s3 status` report.
 *
 * The CLI renders this; GET /api/ops/s3/status returns it verbatim. One
 * implementation, two surfaces — the network route can never drift from the
 * verb an operator runs by hand.
 */
export interface S3StatusReport {
  enabled: boolean;
  endpoint: string | null;
  bucket: string | null;
  prefix: string | null;
  pushOnCommit: boolean | null;
  intervalSec: number | null;
  pathStyle: boolean | null;
  /** Total namespace population (not the rendered row count). */
  total: number;
  namespaces: S3StatusRow[];
  /** Rows the text renderer hides behind STATUS_ROW_LIMIT (0 = complete). */
  hidden: number;
  /**
   * S3-SYNC-STOPPED-001: the last `sync all push` pass this host recorded.
   * `finishedAt: null` means the pass STARTED and never wrote a terminal
   * state (killed / hung / host died) — the difference between "the schedule
   * is firing" and "the schedule fired once, in October".
   */
  lastRun: PushRunRecord | null;
  /**
   * S3-STATUS-SCALE-001: the read plan this report was built under. `null`
   * means every count on every row came from the recorded state and no bucket
   * listing happened.
   */
  verifyPlan: S3VerifyPlan | null;
}

export interface S3StatusReportOptions {
  /** Show every namespace instead of the first STATUS_ROW_LIMIT. */
  full?: boolean;
  /**
   * S3-STATUS-SCALE-001: compare a BOUNDED remote sample against the manifest.
   * Default false — the default path never lists the namespace, because a
   * listing is O(objects) and the largest namespace cannot afford it.
   */
  verify?: boolean;
  /** How many objects that sample may list (default S3_VERIFY_SAMPLE_DEFAULT). */
  sample?: number;
  /** Consent to exceed S3_VERIFY_SAMPLE_MAX. */
  allowManyObjects?: boolean;
  /** Walk the local tree even above the local-walk budget (--deep). */
  deep?: boolean;
  /** Override S3_LOCAL_WALK_MAX for this report (--local-walk-max=N). */
  localWalkMax?: number;
  /**
   * Legacy alias for `verify` (SURFACE-HTTP-OPS-001 `?probe=`). It used to
   * default to TRUE, which is exactly the unbounded listing this row removed;
   * it is now opt-in like `verify`.
   */
  probeRemote?: boolean;
}

/** The verified-sample plan, resolved once per report. */
export interface S3VerifyPlan {
  sample: number;
  allowManyObjects: boolean;
}

/**
 * Resolve `--verify --sample=N --allow-many-objects` into a budgeted plan, or
 * null when the caller did not ask for a listing.
 *
 * Refusal is the point (S3-STATUS-SCALE-001 AC-2): an unbounded listing is
 * indistinguishable from a hang, so a request above the budget throws with the
 * number, the budget and the escape hatch named — instead of starting work it
 * cannot finish.
 */
export function resolveVerifyPlan(
  options: S3StatusReportOptions,
): S3VerifyPlan | null {
  const asked = options.verify === true || options.probeRemote === true;
  if (!asked) return null;
  const requested = options.sample ?? S3_VERIFY_SAMPLE_DEFAULT;
  if (!Number.isFinite(requested) || requested < 1) {
    throw new Error(
      `invalid --sample=${String(options.sample)}: expected a positive object count`,
    );
  }
  const sample = Math.floor(requested);
  const allowManyObjects = options.allowManyObjects === true;
  if (sample > S3_VERIFY_SAMPLE_MAX && !allowManyObjects) {
    throw new Error(
      `refusing to list ${sample} objects: the --verify budget is ${S3_VERIFY_SAMPLE_MAX} ` +
        `(status listing is O(objects) and a whole-namespace listing is how 's3 status' stopped returning). ` +
        `Re-run with --sample=${S3_VERIFY_SAMPLE_MAX} for a bounded sample, or --allow-many-objects to pay for all ${sample}.`,
    );
  }
  return { sample, allowManyObjects };
}

/**
 * What the last push recorded: object count and total bytes, straight out of
 * the manifest. No filesystem walk, no bucket request — the answer exists
 * because every push already wrote it.
 */
export function recordedPopulation(
  manifest: S3SyncManifestLike | null,
): { objects: number | null; bytes: number | null } {
  if (!manifest) return { objects: null, bytes: null };
  let objects = 0;
  let bytes = 0;
  for (const rel of Object.keys(manifest.files)) {
    objects += 1;
    bytes += manifest.files[rel]?.size ?? 0;
  }
  return { objects, bytes };
}

/** Minimal shape `recordedPopulation` needs (keeps it importable from tests). */
export interface S3SyncManifestLike {
  files: Record<string, { size?: number }>;
}

/**
 * Compare a bounded remote page with the manifest record.
 *
 * Drift is deliberately one-directional: the sample can prove an object is
 * UNRECORDED (present remotely, absent from the manifest) or CHANGED (size
 * disagrees), but a page cannot prove an object is missing remotely — that
 * would need the full listing this row exists to avoid.
 */
export function compareSample(
  sampled: { objects: Map<string, { key: string; size: number }>; truncated: boolean },
  manifest: S3SyncManifestLike | null,
  prefix: string,
  requested: number,
  elapsedMs: number,
): S3VerifySample {
  let unrecorded = 0;
  let mismatched = 0;
  const examples: string[] = [];
  for (const [key, obj] of sampled.objects) {
    const rel = key.startsWith(prefix) ? key.slice(prefix.length) : key;
    // The push's OWN artifacts live in the prefix but are not namespace files:
    // `.s3state/checksums.json` (sync.ts LEDGER_REL_PATH) is published by every
    // push and excluded from the manifest by construction, so counting it as
    // drift would raise an alarm that can never clear — the fastest way to
    // teach a reader to ignore drift.
    if (rel.startsWith(".s3state/")) continue;
    const record = manifest?.files?.[rel];
    const differs =
      record === undefined
        ? "unrecorded"
        : record.size !== undefined && record.size !== obj.size
          ? "mismatched"
          : null;
    if (differs === "unrecorded") unrecorded += 1;
    if (differs === "mismatched") mismatched += 1;
    if (differs !== null && examples.length < 5) examples.push(rel);
  }
  return {
    requested,
    listed: sampled.objects.size,
    truncated: sampled.truncated,
    unrecorded,
    mismatched,
    drift: unrecorded + mismatched,
    examples,
    elapsedMs,
  };
}

/**
 * Build the status report without formatting it. Pure read: no file is
 * written, and the only network call is the per-namespace object listing the
 * CLI's `--json` path also makes.
 */
export async function collectS3StatusReport(
  configDir: string,
  nsArg?: string,
  options: S3StatusReportOptions = {},
): Promise<S3StatusReport> {
  const full = options.full === true;
  // S3-STATUS-SCALE-001: resolved BEFORE anything is listed, so a request over
  // budget refuses instead of starting work it cannot finish.
  const plan = resolveVerifyPlan(options);
  const cfg = getConfig(configRoot(configDir));
  const s3 = cfg.s3;
  const nsRoot = namespacesPath(configDir);

  if (!s3?.enabled) {
    return {
      enabled: false,
      endpoint: null,
      bucket: null,
      prefix: null,
      pushOnCommit: null,
      intervalSec: null,
      pathStyle: null,
      total: 0,
      namespaces: [],
      hidden: 0,
      lastRun: null,
      verifyPlan: null,
    };
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
  // the original 20-listing network profile; `--full` lifts the cap.
  const limit = full ? resolved.length : Math.min(resolved.length, STATUS_ROW_LIMIT);

  let client: S3Client | null = null;
  let listBounded: S3ClientModule["listRemoteObjectsBounded"] | null = null;
  if (plan) {
    const mod = await loadS3ClientModule();
    const cfgForClient: S3Config = s3;
    client = mod.buildClient(cfgForClient);
    listBounded = mod.listRemoteObjectsBounded;
  }
  const nowMs = Date.now();
  const rows: S3StatusRow[] = [];
  for (const ns of resolved.slice(0, limit)) {
    const manifest = loadManifest(nsRoot, ns);
    // S3-STATUS-SCALE-001: the recorded population answers "how many objects
    // does the bucket hold" without a single bucket request — and it also
    // decides whether walking the local tree is affordable.
    const recorded = recordedPopulation(manifest);
    const recordedObjects = recorded.objects ?? 0;
    const walkMax = options.localWalkMax ?? S3_LOCAL_WALK_MAX;
    const walk = options.deep === true || recordedObjects <= walkMax;
    // ONE walk feeds both `local=` and the freshness measurement.
    const localFiles = walk ? walkLocal(path.join(nsRoot, ns)) : null;
    const push = loadPushState(nsRoot, ns);
    const freshness = localFiles
      ? freshnessFromFiles(ns, localFiles, push, { now: nowMs, manifest })
      : null;
    const localOmitted = walk
      ? undefined
      : `${recordedObjects} recorded objects exceed the ${walkMax} local-walk budget — pass --deep to measure the live tree`;
    let remoteCount: number | null = null;
    let verify: S3VerifySample | undefined;
    let listError: string | undefined;
    if (client && plan && listBounded) {
      const prefix = `${s3.prefix}/${ns}/`;
      const startedAt = Date.now();
      try {
        const sampled = await listBounded(
          client,
          s3.bucket,
          prefix,
          plan.sample,
        );
        remoteCount = sampled.objects.size;
        verify = compareSample(
          sampled,
          manifest,
          prefix,
          plan.sample,
          Date.now() - startedAt,
        );
      } catch (err) {
        remoteCount = null;
        listError = (err as Error).message;
        // stderr, so a `--json` document on stdout stays parseable.
        console.warn(`  (sample failed for ${ns}: ${listError})`);
      }
    }
    rows.push({
      ns,
      local: localFiles ? localFiles.size : null,
      remote: remoteCount,
      lastSync: manifest?.lastSyncAt ?? null,
      registered: registered.has(ns),
      // The push record answers "when did this host last push" and its age —
      // neither needs the walk, which is the point of the recorded path.
      lastPushAt: push?.lastPushAt ?? null,
      lastPushAgeSeconds: push?.lastPushAt
        ? Math.max(0, Math.round((nowMs - Date.parse(push.lastPushAt)) / 1000))
        : null,
      lastPushOk: push?.lastPushOk ?? null,
      ...(freshness === null
        ? {}
        : {
            unpushed: freshness.unpushed,
            unpushedSample: freshness.unpushedSample,
          }),
      ...(localOmitted === undefined ? {} : { localOmitted }),
      objectsRecorded: recorded.objects,
      bytesRecorded: recorded.bytes,
      countSource: verify === undefined ? "recorded" : "verified",
      ...(verify === undefined ? {} : { verify }),
      ...(listError === undefined ? {} : { listError }),
    });
  }

  return {
    enabled: true,
    endpoint: resolveEffectiveEndpoint(s3) ?? null,
    bucket: s3.bucket,
    prefix: s3.prefix,
    pushOnCommit: s3.pushOnCommit,
    intervalSec: s3.intervalSec,
    pathStyle: s3.forcePathStyle,
    total: resolved.length,
    namespaces: rows,
    hidden: resolved.length - rows.length,
    lastRun: loadPushRun(nsRoot),
    verifyPlan: plan,
  };
}

/** "2.16 GiB" / "912 KiB" — recorded bytes without a 10-digit integer. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return "unknown";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(2)} ${units[unit]}`;
}

/** "8d 3h" / "12m" / "45s" — an age a human can compare to a calendar. */
export function formatAge(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "unknown";
  const s = Math.max(0, Math.round(seconds));
  if (s < 120) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 120) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** One line describing the last `sync all push` pass (S3-SYNC-STOPPED-001). */
export function describePushRun(
  run: PushRunRecord | null,
  nowMs: number,
): string {
  if (!run) {
    return "NEVER — no `sync all push` pass has recorded a run on this host";
  }
  const startedMs = Date.parse(run.startedAt);
  const startedAge = Number.isFinite(startedMs)
    ? formatAge((nowMs - startedMs) / 1000)
    : "unknown";
  if (run.finishedAt === null) {
    return `RUNNING/DIED — started ${run.startedAt} (${startedAge} ago), never finished`;
  }
  const state = run.ok ? "ok" : "FAILED";
  const counts =
    run.attempted === null
      ? ""
      : ` attempted=${run.attempted} succeeded=${run.succeeded} failed=${run.failed} uploaded=${run.uploaded ?? 0}`;
  const error = run.error ? ` — ${run.error}` : "";
  const finishedAge = Number.isFinite(Date.parse(run.finishedAt))
    ? formatAge((nowMs - Date.parse(run.finishedAt)) / 1000)
    : "unknown";
  return `${state} at ${run.finishedAt} (${finishedAge} ago)${counts}${error}`;
}

export async function s3Status(
  configDir: string,
  nsArg?: string,
  options: S3StatusOptions = {},
): Promise<void> {
  const json = options.json === true;

  // `--json` always renders the FULL population (S3-STATUS-001), so ask for it
  // at collection time rather than truncating then remembering to un-truncate.
  // S3-STATUS-SCALE-001: a --verify request over budget REFUSES here, before
  // any network call, with the number and the escape hatch named.
  let report: S3StatusReport;
  try {
    report = await collectS3StatusReport(configDir, nsArg, {
      full: options.full === true || json,
      verify: options.verify === true,
      ...(options.sample === undefined ? {} : { sample: options.sample }),
      allowManyObjects: options.allowManyObjects === true,
      deep: options.deep === true,
      ...(options.localWalkMax === undefined
        ? {}
        : { localWalkMax: options.localWalkMax }),
    });
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
    // Unreachable in a real process; keeps the refusal total for embedders
    // (and tests) that stub process.exit.
    return;
  }

  // S3-STATUS-001: `--json` owns stdout — one JSON document and nothing else,
  // so the output is machine-readable (no header lines to strip).
  if (!json) {
    console.log("S3 config:", report.enabled ? "ENABLED" : "disabled");
  }
  if (!report.enabled) {
    if (json) {
      console.log(
        JSON.stringify({ enabled: false, total: 0, namespaces: [] }, null, 2),
      );
    }
    return;
  }

  if (!json) {
    console.log(`  endpoint: ${report.endpoint ?? "(AWS default)"}`);
    console.log(`  bucket:   ${report.bucket}  prefix: ${report.prefix}`);
    console.log(
      `  pushOnCommit: ${report.pushOnCommit}  intervalSec: ${report.intervalSec}`,
    );
    console.log(`  pathStyle: ${report.pathStyle}`);
    // S3-STATUS-SCALE-001: say which counts the reader is looking at. A
    // recorded count can be stale; a verified one is a bounded sample.
    console.log(
      report.verifyPlan
        ? `  remote check: bounded sample of ${report.verifyPlan.sample} object(s) per namespace (--verify)`
        : `  remote check: recorded state only, no bucket listing (pass --verify --sample=${S3_VERIFY_SAMPLE_DEFAULT} to compare a sample)`,
    );
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          enabled: true,
          endpoint: report.endpoint,
          bucket: report.bucket,
          prefix: report.prefix,
          total: report.namespaces.length,
          lastRun: report.lastRun,
          namespaces: report.namespaces,
        },
        null,
        2,
      ),
    );
    return;
  }

  // Total count is always printed — a cap without a denominator is exactly the
  // "looks complete but isn't" failure S3-STATUS-001 exists to kill.
  console.log(`Namespaces: ${report.total}`);
  // S3-SYNC-STOPPED-001: the pass record sits ABOVE the rows because it is the
  // schedule's own heartbeat — a namespace row can look fine while nothing has
  // run for eight days.
  console.log(`Last pushed run: ${describePushRun(report.lastRun, Date.now())}`);
  for (const row of report.namespaces) {
    // `unpushed=?` is not zero: an unmeasured count and a clean count are
    // different facts (S3-STATUS-SCALE-001).
    const unpushed = row.unpushed === undefined ? "?" : String(row.unpushed);
    const push =
      row.lastPushAt === null || row.lastPushAt === undefined
        ? `lastPush=never (this host) unpushed=${unpushed}`
        : `lastPush=${row.lastPushAt} (${formatAge(row.lastPushAgeSeconds ?? null)} ago)${row.lastPushOk === false ? " [last attempt FAILED]" : ""} unpushed=${unpushed}`;
    const local =
      row.local === null
        ? `local=? (not measured: ${row.localOmitted ?? "over the walk budget"})`
        : `local=${row.local}`;
    // S3-STATUS-SCALE-001: the count is labelled with where it came from, so a
    // stale record is not read as a fresh listing.
    const objects =
      row.countSource === "verified"
        ? `objects=${row.remote} (verified sample: ${row.verify?.listed ?? 0}/${row.verify?.requested ?? 0} listed in ${row.verify?.elapsedMs ?? 0}ms${row.verify?.truncated ? ", prefix holds more" : ""})`
        : `objects=${row.objectsRecorded ?? "?"}${row.bytesRecorded === null || row.bytesRecorded === undefined ? "" : ` ${formatBytes(row.bytesRecorded)}`} (recorded${row.lastSync ? ` ${row.lastSync}` : ", never pushed"})`;
    console.log(
      `  ${row.ns}: ${local} ${objects} lastSync=${row.lastSync ?? "never"} ${push}${row.registered ? "" : " (on-disk only — no config mapping)"}`,
    );
    if (row.verify && row.verify.drift > 0) {
      console.log(
        `    drift: ${row.verify.drift}/${row.verify.listed} sampled objects disagree with the record (unrecorded=${row.verify.unrecorded}, size-changed=${row.verify.mismatched}): ${row.verify.examples.join(", ")}${row.verify.drift > row.verify.examples.length ? ", …" : ""}`,
      );
    }
    if (row.verify && row.verify.drift === 0) {
      console.log(
        `    drift: none in ${row.verify.listed} sampled object(s) (${row.verify.elapsedMs}ms) — the record matches the bucket for this sample`,
      );
    }
    if (row.listError !== undefined) {
      console.log(`    sample FAILED: ${row.listError} — count above is the record, not the bucket`);
    }
    if ((row.unpushed ?? 0) > 0 && (row.unpushedSample?.length ?? 0) > 0) {
      console.log(`    unpushed: ${row.unpushedSample!.join(", ")}${(row.unpushed ?? 0) > row.unpushedSample!.length ? `, … (+${(row.unpushed ?? 0) - row.unpushedSample!.length} more)` : ""}`);
    }
  }
  if (report.hidden > 0) {
    console.log(`  ... and ${report.hidden} more (use --full to see all)`);
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
      const failed = stats.failed ?? 0;
      const detail =
        direction === "pull"
          ? ` verified=${stats.verified ?? 0} unverified=${stats.unverified ?? 0} failed=${failed}`
          : failed > 0
            ? ` failed=${failed}`
            : "";
      console.log(
        `[S3] ${direction} ${stats.ns}: uploaded=${stats.uploaded} downloaded=${stats.downloaded} skipped=${stats.skipped}${detail} in ${stats.durationMs}ms`,
      );
      // S3-PULL-INTEGRITY-001: an object that failed verification (or its
      // transfer) is not a warning — the restore is incomplete, so name every
      // failed key and exit nonzero.
      if (failed > 0) {
        console.error(`Failed objects (${failed}) in namespace ${stats.ns}:`);
        for (const failure of stats.failures) {
          console.error(
            `  ${failure.key} [${failure.kind}] ${failure.detail}`,
          );
        }
        process.exit(Math.min(failed, 125));
      }
    }
    return;
  }

  // `all pull` reports restored-vs-skipped and NEVER reports a silent zero:
  // if the remote prefix holds namespaces but nothing was restored (every
  // per-namespace sync failed), that is a failed restore — warn loudly and
  // exit nonzero. (DF-0925-07; the push summary stays as-is.)
  //
  // S3-CLI-001: `sync all` is an AGGREGATE command. Per-namespace failures are
  // collected by the engine (syncAllNamespacesResult) instead of only being
  // warned, so the summary states attempted/succeeded/failed, every failed
  // namespace is listed with its error, and the process exits nonzero —
  // min(failed, 125) — so a PARTIAL push/pull can never look like success.
  const result = await syncAllNamespacesResult(s3, nsRoot, direction);
  const all = result.stats;
  const total = all.reduce((acc, s) => acc + s.uploaded + s.downloaded, 0);
  console.log(
    `[S3] ${direction} complete: ${all.length} namespaces, ${total} files transferred`,
  );
  // DF-0925-07: "remote data exists but nothing restored" is its own failure —
  // tracked separately from per-namespace throws so both paths exit nonzero
  // through the single exit decision below.
  let emptyRestore = false;
  if (direction === "pull") {
    for (const s of all) {
      console.log(
        `[S3] pull ${s.ns}: downloaded=${s.downloaded} skipped=${s.skipped} verified=${s.verified ?? 0} unverified=${s.unverified ?? 0} failed=${s.failed ?? 0} in ${s.durationMs}ms`,
      );
      // S3-PULL-INTEGRITY-001: name every object the restore could not put on
      // disk. The aggregate failure count below already makes the exit nonzero.
      for (const failure of s.failures ?? []) {
        console.error(
          `  NOT RESTORED ${failure.key} [${failure.kind}] ${failure.detail}`,
        );
      }
    }
    const unverifiedTotal = all.reduce(
      (acc, s) => acc + (s.unverified ?? 0),
      0,
    );
    if (unverifiedTotal > 0) {
      console.warn(
        `[S3] WARNING: ${unverifiedTotal} restored object(s) carried NO checksum evidence (fresh machine with no sync manifest, multipart ETag, or legacy record). They were written because a restore must run on a machine that has nothing, but their bytes are trusted, not proven.`,
      );
      for (const s of all) {
        for (const key of (s.unverifiedKeys ?? []).slice(0, 10)) {
          console.warn(`  UNVERIFIED ${key}`);
        }
      }
    }
    let remoteCount = -1;
    try {
      const { buildClient } = await loadS3ClientModule();
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
      emptyRestore = true;
    }
  }

  console.log(
    `Sync complete: ${result.attempted} attempted, ${result.succeeded} succeeded, ${result.failed} failed`,
  );
  if (result.failed > 0) {
    console.error(`Failed namespaces (${result.failed}):`);
    for (const failure of result.failures) {
      console.error(`  ${failure.namespace}: ${failure.error}`);
    }
  }

  // Exit code carries the failure count (capped at 125 — shell-safe; 126+ is
  // reserved) so scripts can distinguish "some failed" from "all failed".
  if (result.failed > 0) {
    process.exit(Math.min(result.failed, 125));
  }
  if (emptyRestore) process.exit(1);
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

/**
 * Parse `--flag` booleans and `--key=value` pairs from CLI args.
 *
 * S3-STATUS-SCALE-001: flags named in `valueFlags` also accept the space form
 * (`--sample 100`), because that is how the row documents the call and reading
 * `100` as a namespace name would silently point the sample at nothing.
 */
function parseCliFlags(
  args: string[],
  valueFlags: Set<string> = new Set(),
): {
  flags: Record<string, string>;
  positional: string[];
} {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 2) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const name = a.slice(2);
        const next = args[i + 1];
        if (valueFlags.has(name) && next !== undefined && !next.startsWith("--")) {
          flags[name] = next;
          i += 1;
        } else {
          flags[name] = "true";
        }
      }
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
      const { flags, positional } = parseCliFlags(
        args.slice(1),
        new Set(["sample", "local-walk-max"]),
      );
      const sample =
        flags["sample"] === undefined ? undefined : Number(flags["sample"]);
      const localWalkMax =
        flags["local-walk-max"] === undefined
          ? undefined
          : Number(flags["local-walk-max"]);
      await s3Status(configDir, positional[0], {
        full: flags["full"] !== undefined,
        json: flags["json"] !== undefined,
        verify: flags["verify"] !== undefined,
        ...(sample === undefined ? {} : { sample }),
        allowManyObjects: flags["allow-many-objects"] !== undefined,
        deep: flags["deep"] !== undefined,
        ...(localWalkMax === undefined ? {} : { localWalkMax }),
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
