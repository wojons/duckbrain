import fs from "fs";
import { Counter, type Registry } from "prom-client";
import os from "os";
import path from "path";
import { resolveNamespacesPath } from "../config/index";

export const DEFAULT_HEALTH_CHECK = "GET /health";

/**
 * OBSDB-005 — recall usefulness as counters: `duckbrain_recall_packs_total`
 * and `duckbrain_recall_packs_nonempty_total`.
 *
 * Spec §2 blind spot #7: the durable truth already exists — `recordRecallMetric`
 * appends one JSONL event per completed MCP recall to
 * `<data-dir>/metrics/recall-counter.jsonl` — but the ONLY consumer is the
 * human-run `duckbrain recall-metrics` rollup, so "is recall returning
 * anything?" had no series, and the alert file it writes is produced by a
 * person typing a command.
 *
 * WHY THE COUNTERS MIRROR THE FILE INSTEAD OF COUNTING IN-PROCESS. The events
 * are produced by the MCP server, which is a DIFFERENT process from the HTTP
 * daemon that serves `/metrics`. An in-process increment would read zero in
 * every deployment where the daemon and MCP are separate — i.e. all of them.
 * So the scrape reads the counter file incrementally (byte offset, only whole
 * lines) and increments by the DELTA it has not yet counted. That gives three
 * properties the naive "count the file and set a number" loses:
 *
 *   - monotonic: a counter never goes down, so PromQL `increase()` is valid;
 *     a truncated or replaced file resets the OFFSET, never the totals.
 *   - idempotent: two scrapes with no new events add nothing; a crash
 *     mid-scrape can only lose the events that arrived after the offset.
 *   - honest: a missing file means no recalls yet, which is genuinely 0 —
 *     unlike the storage gauges there is no "the store is 9 GB, not 0" lie.
 *
 * PROCESS-WIDE singletons with `registers: []`, attached to a scrape registry
 * by `registerRecallMetrics` — the same pattern as src/embedding/metrics.ts and
 * src/git/metrics.ts, and for the same reason: one process may host the CLI,
 * MCP and HTTP surfaces, and a second `createHttpServer()` must not throw.
 */
export const RECALL_PACKS_TOTAL = "duckbrain_recall_packs_total";
export const RECALL_PACKS_NONEMPTY_TOTAL = "duckbrain_recall_packs_nonempty_total";

/** The families this module owns, in exposition order. */
export const RECALL_METRIC_NAMES = [
  RECALL_PACKS_TOTAL,
  RECALL_PACKS_NONEMPTY_TOTAL,
] as const;

/** Every counted recall pack (one JSONL event = one pack). */
export const recallPacks = new Counter({
  name: RECALL_PACKS_TOTAL,
  help: "MCP recall packs recorded in metrics/recall-counter.jsonl (mirrored at scrape time, so it counts recalls served by another process).",
  registers: [],
});

/** The packs that returned at least one record. */
export const recallPacksNonEmpty = new Counter({
  name: RECALL_PACKS_NONEMPTY_TOTAL,
  help: "MCP recall packs that returned at least one record; divided by duckbrain_recall_packs_total it is the non-empty-pack rate.",
  registers: [],
});

/** Incremental mirror state — the file, how far it has been counted, totals. */
interface RecallMirrorState {
  file: string | null;
  offset: number;
  packs: number;
  nonEmpty: number;
}

let mirror: RecallMirrorState = { file: null, offset: 0, packs: 0, nonEmpty: 0 };

export interface RecallMirrorResult {
  /** Packs counted so far (monotonic for the process). */
  packs: number;
  /** Non-empty packs counted so far (monotonic for the process). */
  nonEmpty: number;
  /** New events counted by THIS sync call. */
  added: number;
}

/**
 * Count any recall events appended since the last call, and return the totals.
 *
 * Reads only whole lines from the last byte offset: a partially written final
 * line is left for the next scrape rather than parsed (and mis-counted). A file
 * that shrank below the offset was truncated or replaced — the offset restarts
 * at 0 while the counters keep their totals, because a Prometheus counter
 * cannot go back.
 */
export function syncRecallPacksFromCounterFile(
  counterFile?: string,
): RecallMirrorResult {
  const file = counterFile
    ? path.resolve(counterFile)
    : resolveRecallMetricsPaths().counterFile;
  if (mirror.file !== file) {
    // A different counter file is a different population: start its offset at
    // 0 and COUNT it, but keep the totals monotonic (a counter never regress).
    mirror = { file, offset: 0, packs: mirror.packs, nonEmpty: mirror.nonEmpty };
  }

  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { packs: mirror.packs, nonEmpty: mirror.nonEmpty, added: 0 };
  }
  if (size < mirror.offset) mirror.offset = 0;
  if (size === mirror.offset) {
    return { packs: mirror.packs, nonEmpty: mirror.nonEmpty, added: 0 };
  }

  let text = "";
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(size - mirror.offset);
      const read = fs.readSync(fd, buffer, 0, buffer.length, mirror.offset);
      text = buffer.subarray(0, read).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { packs: mirror.packs, nonEmpty: mirror.nonEmpty, added: 0 };
  }

  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline < 0) {
    return { packs: mirror.packs, nonEmpty: mirror.nonEmpty, added: 0 };
  }
  const complete = text.slice(0, lastNewline);
  let added = 0;
  let addedNonEmpty = 0;
  for (const line of complete.split("\n")) {
    if (line.trim() === "") continue;
    let event: Partial<RecallMetricEvent>;
    try {
      event = JSON.parse(line) as Partial<RecallMetricEvent>;
    } catch {
      continue; // a torn/garbled line is skipped, never fatal to the scrape
    }
    added += 1;
    if (event.nonEmptyPacks === 1 || (event.recordsReturned ?? 0) > 0) {
      addedNonEmpty += 1;
    }
  }

  // Advance by the bytes actually consumed (the complete lines), so the
  // partial tail is re-read on the next call.
  mirror.offset += Buffer.byteLength(text.slice(0, lastNewline + 1), "utf8");
  if (added > 0) recallPacks.inc(added);
  if (addedNonEmpty > 0) recallPacksNonEmpty.inc(addedNonEmpty);
  mirror.packs += added;
  mirror.nonEmpty += addedNonEmpty;

  return { packs: mirror.packs, nonEmpty: mirror.nonEmpty, added };
}

/** Attach the recall families to a scrape registry (idempotent). */
export function registerRecallMetrics(registry: Registry): void {
  for (const metric of [recallPacks, recallPacksNonEmpty]) {
    try {
      registry.registerMetric(metric);
    } catch {
      // Same metric object already registered on this registry — nothing to do.
    }
  }
}

/** Reset the counters and the mirror (test seam; production resets by restart). */
export function resetRecallMetrics(): void {
  recallPacks.reset();
  recallPacksNonEmpty.reset();
  mirror = { file: null, offset: 0, packs: 0, nonEmpty: 0 };
}

export interface RecallMetricEvent {
  ts: string;
  day: string;
  namespaces: string[];
  calls: 1;
  callsAnswered: 0 | 1;
  nonEmptyPacks: 0 | 1;
  recordsReturned: number;
}

export interface HealthSignal {
  day: string;
  healthy: boolean;
  source?: string;
  status?: number;
}

export interface RecallDailyRollup {
  day: string;
  prefetchCalls: number;
  callsAnswered: number;
  nonEmptyPacks: number;
  distinctNamespaces: number;
  recordsReturned: number;
  healthy: boolean | null;
  healthSource: string;
  rates: {
    answeredPerCall: string;
    nonEmptyPackRate: string;
    recordsPerCall: string;
  };
}

export interface RecallAlert {
  day: string;
  reason: "zero_non_empty_packs";
  counterFile: string;
  healthFile: string;
  healthCheck: string;
  createdAt: string;
}

export interface RecallMetricsPaths {
  counterFile: string;
  healthFile: string;
  alertsFile: string;
}

function utcDay(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime()))
    throw new Error(`Invalid timestamp: ${value}`);
  return date.toISOString().slice(0, 10);
}

function addDays(day: string, amount: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return utcDay(date);
}

function fraction(numerator: number, denominator: number): string {
  return `${numerator}/${denominator}`;
}

/**
 * Resolve the read-metric files. DUCKBRAIN_RECALL_METRICS_PATH may point at
 * the counter JSONL file. Otherwise metrics live beside the configured
 * namespaces directory (the default is <data-dir>/metrics/recall-counter.jsonl).
 */
export function recallCounterFileFor(namespacesPath: string): string {
  const override = process.env.DUCKBRAIN_RECALL_METRICS_PATH;
  return override
    ? path.resolve(override)
    : path.join(
        path.dirname(path.resolve(namespacesPath)),
        "metrics",
        "recall-counter.jsonl",
      );
}

export function resolveRecallMetricsPaths(
  counterFile = process.env.DUCKBRAIN_RECALL_METRICS_PATH,
): RecallMetricsPaths {
  const resolvedCounter = counterFile
    ? path.resolve(counterFile)
    : recallCounterFileFor(resolveNamespacesPath());
  const dir = path.dirname(resolvedCounter);
  return {
    counterFile: resolvedCounter,
    healthFile:
      process.env.DUCKBRAIN_RECALL_HEALTH_FILE ??
      path.join(dir, "health.jsonl"),
    alertsFile:
      process.env.DUCKBRAIN_RECALL_ALERTS_FILE ??
      path.join(dir, "recall-alerts.jsonl"),
  };
}

function ensureParent(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
}

/** Append one completed MCP-side recall observation without affecting recall. */
export function recordRecallMetric(options: {
  counterFile?: string;
  timestamp?: string | Date;
  namespaces: string[];
  recordsReturned: number;
  completed?: boolean;
}): RecallMetricEvent {
  const paths = resolveRecallMetricsPaths(options.counterFile);
  const timestamp =
    options.timestamp instanceof Date
      ? options.timestamp.toISOString()
      : (options.timestamp ?? new Date().toISOString());
  const event: RecallMetricEvent = {
    ts: timestamp,
    day: utcDay(timestamp),
    namespaces: [
      ...new Set(options.namespaces.filter((name) => name.trim() !== "")),
    ],
    calls: 1,
    callsAnswered: options.completed === false ? 0 : 1,
    nonEmptyPacks: options.recordsReturned > 0 ? 1 : 0,
    recordsReturned: Math.max(0, Math.trunc(options.recordsReturned)),
  };
  ensureParent(paths.counterFile);
  fs.appendFileSync(paths.counterFile, `${JSON.stringify(event)}${os.EOL}`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return event;
}

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      try {
        return JSON.parse(line) as T;
      } catch (error) {
        throw new Error(
          `${file}:${index + 1} is not valid JSON: ${String(error)}`,
        );
      }
    });
}

export function readRecallMetricEvents(
  counterFile?: string,
): RecallMetricEvent[] {
  return readJsonl<RecallMetricEvent>(
    resolveRecallMetricsPaths(counterFile).counterFile,
  );
}

export function readHealthSignals(
  healthFile?: string,
): Map<string, HealthSignal> {
  const resolved = healthFile ?? resolveRecallMetricsPaths().healthFile;
  const signals = readJsonl<HealthSignal>(resolved);
  return new Map(signals.map((signal) => [signal.day, signal]));
}

export function dateRange(from: string, to: string): string[] {
  const start = utcDay(from);
  const end = utcDay(to);
  if (start > end)
    throw new Error(`from date ${start} is after to date ${end}`);
  const days: string[] = [];
  for (let day = start; day <= end; day = addDays(day, 1)) days.push(day);
  return days;
}

export function rollupRecallMetrics(options: {
  counterFile?: string;
  healthFile?: string;
  from: string;
  to: string;
  healthCheck?: string;
}): RecallDailyRollup[] {
  const paths = resolveRecallMetricsPaths(options.counterFile);
  const events = readRecallMetricEvents(paths.counterFile);
  const health = readHealthSignals(options.healthFile ?? paths.healthFile);
  const byDay = new Map<string, RecallMetricEvent[]>();
  for (const event of events) {
    const bucket = byDay.get(event.day) ?? [];
    bucket.push(event);
    byDay.set(event.day, bucket);
  }
  const healthCheck = options.healthCheck ?? DEFAULT_HEALTH_CHECK;
  return dateRange(options.from, options.to).map((day) => {
    const dayEvents = byDay.get(day) ?? [];
    const prefetchCalls = dayEvents.reduce(
      (sum, event) => sum + event.calls,
      0,
    );
    const callsAnswered = dayEvents.reduce(
      (sum, event) => sum + event.callsAnswered,
      0,
    );
    const nonEmptyPacks = dayEvents.reduce(
      (sum, event) => sum + event.nonEmptyPacks,
      0,
    );
    const recordsReturned = dayEvents.reduce(
      (sum, event) => sum + event.recordsReturned,
      0,
    );
    const namespaces = new Set(dayEvents.flatMap((event) => event.namespaces));
    const signal = health.get(day);
    return {
      day,
      prefetchCalls,
      callsAnswered,
      nonEmptyPacks,
      distinctNamespaces: namespaces.size,
      recordsReturned,
      healthy: signal?.healthy ?? null,
      healthSource: signal?.source ?? healthCheck,
      rates: {
        answeredPerCall: fraction(callsAnswered, prefetchCalls),
        nonEmptyPackRate: fraction(nonEmptyPacks, prefetchCalls),
        recordsPerCall: fraction(recordsReturned, prefetchCalls),
      },
    };
  });
}

export function checkRecallAlerts(options: {
  counterFile?: string;
  healthFile?: string;
  alertsFile?: string;
  from: string;
  to: string;
  healthCheck?: string;
}): RecallAlert[] {
  const paths = resolveRecallMetricsPaths(options.counterFile);
  const healthFile = options.healthFile ?? paths.healthFile;
  const alertsFile = options.alertsFile ?? paths.alertsFile;
  const rollup = rollupRecallMetrics({
    ...options,
    healthFile,
  });
  const existing = new Set(
    readJsonl<RecallAlert>(alertsFile).map(
      (alert) => `${alert.day}:${alert.reason}`,
    ),
  );
  const alerts = rollup
    .filter(
      (day) =>
        day.healthy === true &&
        day.prefetchCalls > 0 &&
        day.nonEmptyPacks === 0,
    )
    .filter((day) => !existing.has(`${day.day}:zero_non_empty_packs`))
    .map((day): RecallAlert => ({
      day: day.day,
      reason: "zero_non_empty_packs",
      counterFile: paths.counterFile,
      healthFile: path.resolve(healthFile),
      healthCheck: options.healthCheck ?? DEFAULT_HEALTH_CHECK,
      createdAt: new Date().toISOString(),
    }));
  if (alerts.length > 0) {
    ensureParent(alertsFile);
    fs.appendFileSync(
      alertsFile,
      alerts.map((alert) => JSON.stringify(alert)).join(os.EOL) + os.EOL,
      { encoding: "utf8", mode: 0o600 },
    );
  }
  return alerts;
}

export function defaultRecallMetricsDates(
  days = 7,
  now = new Date(),
): {
  from: string;
  to: string;
} {
  const to = addDays(utcDay(now), -1);
  return { from: addDays(to, -(days - 1)), to };
}
