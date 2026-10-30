import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  checkRecallAlerts,
  dateRange,
  recordRecallMetric,
  rollupRecallMetrics,
} from "../../metrics/recall";

const original = {
  metrics: process.env.DUCKBRAIN_RECALL_METRICS_PATH,
  health: process.env.DUCKBRAIN_RECALL_HEALTH_FILE,
  alerts: process.env.DUCKBRAIN_RECALL_ALERTS_FILE,
};

function fixture(): {
  root: string;
  counter: string;
  health: string;
  alerts: string;
} {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "duckbrain-recall-metrics-"),
  );
  return {
    root,
    counter: path.join(root, "metrics", "recall-counter.jsonl"),
    health: path.join(root, "metrics", "health.jsonl"),
    alerts: path.join(root, "metrics", "recall-alerts.jsonl"),
  };
}

afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    const envKey =
      key === "metrics"
        ? "DUCKBRAIN_RECALL_METRICS_PATH"
        : key === "health"
          ? "DUCKBRAIN_RECALL_HEALTH_FILE"
          : "DUCKBRAIN_RECALL_ALERTS_FILE";
    if (value === undefined) delete process.env[envKey];
    else process.env[envKey] = value;
  }
});

describe("DF-2026-19 recall read metrics", () => {
  it("increments calls, non-empty packs, namespaces, and records", () => {
    const f = fixture();
    try {
      recordRecallMetric({
        counterFile: f.counter,
        timestamp: "2026-10-20T10:00:00Z",
        namespaces: ["alpha", "alpha", "beta"],
        recordsReturned: 2,
      });
      recordRecallMetric({
        counterFile: f.counter,
        timestamp: "2026-10-20T11:00:00Z",
        namespaces: ["alpha"],
        recordsReturned: 0,
      });
      const rows = rollupRecallMetrics({
        counterFile: f.counter,
        from: "2026-10-20",
        to: "2026-10-20",
      });
      expect(rows[0]).toMatchObject({
        prefetchCalls: 2,
        callsAnswered: 2,
        nonEmptyPacks: 1,
        distinctNamespaces: 2,
        recordsReturned: 2,
        rates: {
          answeredPerCall: "2/2",
          nonEmptyPackRate: "1/2",
          recordsPerCall: "2/2",
        },
      });
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("produces a seven-day series including empty days", () => {
    const f = fixture();
    try {
      recordRecallMetric({
        counterFile: f.counter,
        timestamp: "2026-10-20T10:00:00Z",
        namespaces: ["alpha"],
        recordsReturned: 1,
      });
      expect(dateRange("2026-10-20", "2026-10-26")).toHaveLength(7);
      const rows = rollupRecallMetrics({
        counterFile: f.counter,
        from: "2026-10-20",
        to: "2026-10-26",
      });
      expect(rows).toHaveLength(7);
      expect(rows[0].nonEmptyPacks).toBe(1);
      expect(rows[6]).toMatchObject({
        prefetchCalls: 0,
        nonEmptyPacks: 0,
        rates: {
          answeredPerCall: "0/0",
          nonEmptyPackRate: "0/0",
          recordsPerCall: "0/0",
        },
      });
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("alerts for a forced-empty healthy day and records both comparison paths", () => {
    const f = fixture();
    try {
      recordRecallMetric({
        counterFile: f.counter,
        timestamp: "2026-10-21T10:00:00Z",
        namespaces: ["alpha"],
        recordsReturned: 0,
      });
      fs.mkdirSync(path.dirname(f.health), { recursive: true });
      fs.writeFileSync(
        f.health,
        `${JSON.stringify({ day: "2026-10-21", healthy: true, source: "daemon-health.json", status: 200 })}\n` +
          `${JSON.stringify({ day: "2026-10-22", healthy: false, source: "daemon-health.json", status: 503 })}\n`,
      );
      const alerts = checkRecallAlerts({
        counterFile: f.counter,
        healthFile: f.health,
        alertsFile: f.alerts,
        from: "2026-10-21",
        to: "2026-10-22",
        healthCheck: "GET /health status=200",
      });
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        day: "2026-10-21",
        reason: "zero_non_empty_packs",
        counterFile: f.counter,
        healthFile: f.health,
        healthCheck: "GET /health status=200",
      });
      expect(fs.readFileSync(f.alerts, "utf8")).toContain(
        "zero_non_empty_packs",
      );
      expect(
        checkRecallAlerts({
          counterFile: f.counter,
          healthFile: f.health,
          alertsFile: f.alerts,
          from: "2026-10-21",
          to: "2026-10-22",
        }),
      ).toEqual([]);
      expect(
        rollupRecallMetrics({
          counterFile: f.counter,
          healthFile: f.health,
          from: "2026-10-21",
          to: "2026-10-22",
        })[1].healthy,
      ).toBe(false);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });
});
