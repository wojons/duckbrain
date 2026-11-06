/**
 * S3-SYNC-STOPPED-001 — freshness as a first-class, observable fact.
 *
 * The mirror went eight days stale (2026-10-28 → 2026-11-05) while every
 * surface that could have said so was green: `s3 status` printed a
 * `lastSync=2026-10-28` timestamp nobody was comparing to a clock, nothing
 * counted the files written since, and `pull` verified completeness against a
 * checksum ledger published by the SAME stale push — so a mirror that had not
 * moved since October was indistinguishable from a current one.
 *
 * Two records fix that, and both live under `<namespacesPath>/.s3state/` next
 * to the sync manifests (never inside a namespace's git tree):
 *
 *   <ns>.push.json      — when THIS host last completed a push, whether it
 *                         was clean, and what it moved. Written by
 *                         pushNamespace; readable without parsing the
 *                         multi-megabyte sync manifest.
 *   last-push-run.json  — the `sync all push` pass record: started/finished,
 *                         ok, attempted/succeeded/failed, files transferred.
 *                         A run that dies mid-pass leaves a record with
 *                         `finishedAt: null`, so "started and never came back"
 *                         is visible instead of silent.
 *
 * Freshness of a namespace = age of the last CLEAN push + the set of local
 * syncable files whose mtime is newer than it (or that no push has ever
 * recorded). Both are numbers, so Prometheus can alert on them
 * (duckbrain_s3_last_push_age_seconds, duckbrain_s3_unpushed_files) and a
 * reader can see them in `s3 status`.
 */

import fs from "fs";
import path from "path";
import { walkLocal, type LocalFile } from "./walk.js";
import { loadManifest, type S3SyncManifest } from "./manifest.js";

/** Per-namespace, per-host push record. */
export interface PushState {
  version: 1;
  ns: string;
  /**
   * ISO time of the last push pass that was CLEAN (every planned object
   * uploaded/verified and the checksum ledger published). null = this host has
   * never completed a clean push of the namespace.
   */
  lastPushAt: string | null;
  /** ISO time of the most recent attempt, clean or not. */
  lastPushAttemptAt: string;
  /** Whether that attempt was clean. */
  lastPushOk: boolean;
  uploaded: number;
  skipped: number;
  /** Objects that failed to upload in the attempt (0 = clean transfer). */
  failedUploads: number;
  /** Object-mode failures (e.g. the checksum ledger could not be published). */
  failures: number;
}

/** `.s3state/<ns>.push.json` */
export function pushStatePath(namespacesPath: string, ns: string): string {
  return path.join(namespacesPath, ".s3state", `${ns}.push.json`);
}

export function loadPushState(
  namespacesPath: string,
  ns: string,
): PushState | null {
  try {
    const raw = fs.readFileSync(pushStatePath(namespacesPath, ns), "utf-8");
    const parsed = JSON.parse(raw) as PushState;
    if (parsed.version !== 1 || parsed.ns !== ns) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function savePushState(namespacesPath: string, state: PushState): void {
  const file = pushStatePath(namespacesPath, state.ns);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

/** What one namespace's freshness measurement says. */
export interface NamespaceFreshness {
  ns: string;
  /** Syncable local files (walkLocal's set — what a push would consider). */
  localFiles: number;
  lastPushAt: string | null;
  lastPushAttemptAt: string | null;
  lastPushOk: boolean | null;
  /** Seconds since lastPushAt; null when this host has no clean push on record. */
  pushAgeSeconds: number | null;
  /**
   * Local syncable files with mtime later than lastPushAt, or every file when
   * no clean push is on record (their bytes were never proven to be in the
   * mirror). This is the "would be lost in a restore" set.
   */
  unpushed: number;
  /** First `sampleLimit` unpushed relPaths, sorted — names, not just a count. */
  unpushedSample: string[];
  newestLocalMtimeMs: number | null;
}

export interface FreshnessMeasureOptions {
  now?: number;
  /** How many unpushed paths to name (default 10). */
  sampleLimit?: number;
  /**
   * The namespace's sync manifest, when the caller already has it. It is the
   * fallback marker for a host that has no push record yet (the pre-existing
   * install, whose last push predates this record) and the authority for
   * "which paths are known to exist remotely": every entry the manifest keeps
   * was either uploaded or verified against the remote listing.
   */
  manifest?: S3SyncManifest | null;
}

/**
 * Measure one namespace from local state only: no network, no manifest parse.
 * Pure read; safe for a status verb and for a metrics sampler.
 */
export function measureNamespaceFreshness(
  namespacesPath: string,
  ns: string,
  options: FreshnessMeasureOptions = {},
): NamespaceFreshness {
  return freshnessFromFiles(
    ns,
    walkLocal(path.join(namespacesPath, ns)),
    loadPushState(namespacesPath, ns),
    { manifest: loadManifest(namespacesPath, ns), ...options },
  );
}

/**
 * The same measurement from an ALREADY-WALKED file map + push record. `s3
 * status` walks each namespace anyway to print `local=N`; re-walking it for
 * freshness would double the stat cost on the scheduler namespace (258k
 * files), so both numbers are derived from one walk.
 */
export function freshnessFromFiles(
  ns: string,
  files: Map<string, LocalFile>,
  state: PushState | null,
  options: FreshnessMeasureOptions = {},
): NamespaceFreshness {
  const now = options.now ?? Date.now();
  const sampleLimit = options.sampleLimit ?? 10;
  const manifest = options.manifest ?? null;
  const lastPushAt = state?.lastPushAt ?? null;
  // Push record first (it alone distinguishes push from pull); a host whose
  // last push predates the record falls back to the manifest's sync time and
  // the paths that manifest already covers, so an existing install does not
  // report its whole tree as unpushed on the first status after the upgrade.
  const markerIso = lastPushAt ?? manifest?.lastSyncAt ?? null;
  const markerMs = markerIso ? Date.parse(markerIso) : NaN;
  const hasMarker = Number.isFinite(markerMs);
  const covered = manifest ? new Set(Object.keys(manifest.files)) : null;

  let newest: number | null = null;
  const unpushedPaths: string[] = [];
  for (const [relPath, file] of files) {
    if (newest === null || file.mtimeMs > newest) newest = file.mtimeMs;
    // A file is unproven when any of these holds:
    //   newer      — written after the last known sync (no push can hold it);
    //   notCovered — the manifest (the remote-coverage record) does not list
    //                it, so no push or pull ever confirmed it exists remotely;
    //   unprovable — neither a push record nor a manifest: nothing on this host
    //                can testify that ANY of the tree reached the mirror.
    // mtimeMs is fractional, an ISO timestamp is whole milliseconds: a file
    // written in the same millisecond as the sync marker must not read as
    // "newer" (that is how a re-pull looked like drift). Floor the mtime and
    // compare at the resolution the record actually has.
    const newer = hasMarker && Math.floor(file.mtimeMs) > markerMs;
    const notCovered = covered !== null && !covered.has(relPath);
    const unprovable = !hasMarker && covered === null;
    if (newer || notCovered || unprovable) unpushedPaths.push(relPath);
  }
  unpushedPaths.sort();

  return {
    ns,
    localFiles: files.size,
    lastPushAt,
    lastPushAttemptAt: state?.lastPushAttemptAt ?? null,
    lastPushOk: state?.lastPushOk ?? null,
    pushAgeSeconds:
      hasMarker && Number.isFinite(now)
        ? Math.max(0, Math.round((now - markerMs) / 1000))
        : null,
    unpushed: unpushedPaths.length,
    unpushedSample: unpushedPaths.slice(0, sampleLimit),
    newestLocalMtimeMs: newest,
  };
}

/** Aggregate freshness — the shape the two Prometheus gauges publish. */
export interface FreshnessSummary {
  namespaces: number;
  /** Age of the OLDEST clean push across namespaces (the alerting number). */
  maxPushAgeSeconds: number | null;
  /** Namespaces with no clean push from this host on record. */
  neverPushed: number;
  /** Total syncable local files not covered by a clean push. */
  unpushedFiles: number;
}

export function summarizeFreshness(
  rows: NamespaceFreshness[],
): FreshnessSummary {
  let maxAge: number | null = null;
  let neverPushed = 0;
  let unpushed = 0;
  for (const row of rows) {
    if (row.pushAgeSeconds === null) neverPushed += 1;
    else if (maxAge === null || row.pushAgeSeconds > maxAge)
      maxAge = row.pushAgeSeconds;
    unpushed += row.unpushed;
  }
  return {
    namespaces: rows.length,
    maxPushAgeSeconds: maxAge,
    neverPushed,
    unpushedFiles: unpushed,
  };
}

/** Namespace dirs under the root (same population `sync all` walks). */
export function listNamespaceDirs(namespacesPath: string): string[] {
  try {
    return fs
      .readdirSync(namespacesPath, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** The `sync all push` pass record. */
export interface PushRunRecord {
  version: 1;
  command: "sync all push";
  startedAt: string;
  /** null = the pass never wrote a terminal state (killed, hung, host died). */
  finishedAt: string | null;
  ok: boolean | null;
  attempted: number | null;
  succeeded: number | null;
  failed: number | null;
  /** Files uploaded by the pass (null while running). */
  uploaded: number | null;
  /** First failure message when ok === false. */
  error: string | null;
}

export function pushRunPath(namespacesPath: string): string {
  return path.join(namespacesPath, ".s3state", "last-push-run.json");
}

export function loadPushRun(namespacesPath: string): PushRunRecord | null {
  try {
    const raw = fs.readFileSync(pushRunPath(namespacesPath), "utf-8");
    const parsed = JSON.parse(raw) as PushRunRecord;
    if (parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function savePushRun(
  namespacesPath: string,
  record: PushRunRecord,
): void {
  const file = pushRunPath(namespacesPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n", "utf-8");
}

/**
 * Freshness sampler for the metrics endpoint.
 *
 * The scrape must not walk half a million files on every request, so the
 * measurement is cached for `ttlMs` and single-flighted. A walk that cannot
 * finish inside `budgetMs` yields NO measurement (the caller withdraws the
 * series) — "unknown" is the honest state; a partial sum would read as a
 * number that means nothing.
 */
export interface FreshnessSampler {
  read(): Promise<FreshnessSummary | null>;
}

export interface FreshnessSamplerOptions {
  /** Root, or a resolver (the daemon re-reads config, so its root can move). */
  namespacesPath: string | (() => string);
  ttlMs?: number;
  budgetMs?: number;
  now?: () => number;
}

export const FRESHNESS_SCAN_TTL_MS = 300_000;
export const FRESHNESS_SCAN_BUDGET_MS = 15_000;

export function createFreshnessSampler(
  options: FreshnessSamplerOptions,
): FreshnessSampler {
  const ttlMs = options.ttlMs ?? FRESHNESS_SCAN_TTL_MS;
  const budgetMs = options.budgetMs ?? FRESHNESS_SCAN_BUDGET_MS;
  const now = options.now ?? (() => Date.now());
  let cached: { at: number; value: FreshnessSummary | null } | null = null;
  let inflight: Promise<FreshnessSummary | null> | null = null;

  const root = (): string =>
    typeof options.namespacesPath === "function"
      ? options.namespacesPath()
      : options.namespacesPath;

  const measure = (): FreshnessSummary | null => {
    const started = Date.now();
    const namespacesPath = root();
    const rows: NamespaceFreshness[] = [];
    for (const ns of listNamespaceDirs(namespacesPath)) {
      if (Date.now() - started > budgetMs) return null;
      rows.push(measureNamespaceFreshness(namespacesPath, ns, { now: now() }));
    }
    return summarizeFreshness(rows);
  };

  return {
    async read(): Promise<FreshnessSummary | null> {
      if (cached && now() - cached.at < ttlMs) return cached.value;
      if (inflight) return inflight;
      const run = Promise.resolve()
        .then(measure)
        .catch(() => null)
        .then((value) => {
          cached = { at: now(), value };
          inflight = null;
          return value;
        });
      inflight = run;
      return run;
    },
  };
}
