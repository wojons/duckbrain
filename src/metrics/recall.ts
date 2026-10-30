import fs from "fs";
import os from "os";
import path from "path";
import { resolveNamespacesPath } from "../config/index";

export const DEFAULT_HEALTH_CHECK = "GET /health";

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
export function resolveRecallMetricsPaths(
  counterFile = process.env.DUCKBRAIN_RECALL_METRICS_PATH,
): RecallMetricsPaths {
  const resolvedCounter = counterFile
    ? path.resolve(counterFile)
    : path.join(
        path.dirname(resolveNamespacesPath()),
        "metrics",
        "recall-counter.jsonl",
      );
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
