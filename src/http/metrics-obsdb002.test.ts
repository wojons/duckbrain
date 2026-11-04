/**
 * OBSDB-002 — read latency and refusals become series.
 *
 * Two things were structurally invisible before this row: `how long does a
 * recall take` (the ledger stored dur_ms but the only aggregation dropped it)
 * and every request REFUSED by the rate limiter or the DNS-rebinding guard
 * (both run upstream of the read ledger, so no sink saw them at all).
 *
 * These tests pin the parts a reviewer would otherwise have to trust: the
 * histogram measures what the ledger measured, refusals are counted from the
 * upstream hooks, and no raw path can become a label.
 */
import { describe, it, expect } from "vitest";
import {
  createHttpMetrics,
  REJECTION_ROUTE_SENTINEL,
  rejectionReasonLabel,
  rejectionRouteLabel,
  REJECTION_REASONS,
  type HealthSnapshot,
} from "./metrics";

const healthySnapshot = (): HealthSnapshot => ({
  status: "healthy",
  providers: [{ id: "openai", healthy: true }],
  durationsMs: { embedding: 12, keys: 1, total: 13 },
});

function metricsWith(evaluateHealth: () => Promise<HealthSnapshot>) {
  return createHttpMetrics({ evaluateHealth, version: "test" });
}

async function scrape(m: { render(): Promise<string> }): Promise<string> {
  return m.render();
}

/** Cumulative count in one named bucket, parsed straight out of the text. */
function bucketCount(
  text: string,
  metric: string,
  le: string,
  labels: RegExp,
): number {
  const line = text
    .split("\n")
    .find(
      (l) =>
        l.startsWith(`${metric}_bucket`) &&
        l.includes(`le="${le}"`) &&
        labels.test(l),
    );
  if (!line) return -1;
  return Number(line.trim().split(" ").pop());
}

describe("OBSDB-002: duckbrain_read_duration_seconds", () => {
  it("records per-route latency, with _count and a non-zero _sum", async () => {
    const m = metricsWith(async () => healthySnapshot());
    m.observeRead({ route: "GET /api/memories", method: "GET", status: 200, durMs: 12 });
    m.observeRead({ route: "GET /api/memories", method: "GET", status: 200, durMs: 18 });
    m.observeRead({ route: "GET /api/namespaces", method: "GET", status: 200, durMs: 4 });
    const text = await scrape(m);

    expect(text).toMatch(/^# TYPE duckbrain_read_duration_seconds histogram$/m);
    expect(text).toContain(
      'duckbrain_read_duration_seconds_count{route="GET /api/memories",method="GET"} 2',
    );
    expect(text).toContain(
      'duckbrain_read_duration_seconds_count{route="GET /api/namespaces",method="GET"} 1',
    );
    // 12 + 18 = 30 ms = 0.03 s, not zero
    const sumLine = text
      .split("\n")
      .find(
        (l) =>
          l.startsWith("duckbrain_read_duration_seconds_sum{") &&
          l.includes("api/memories"),
      );
    expect(sumLine).toBeDefined();
    const sum = Number(sumLine!.trim().split(/\s+/).pop());
    expect(sum).toBeCloseTo(0.03, 3);
  });

  it("puts a slow read in a strictly higher bucket than a fast one", async () => {
    const m = metricsWith(async () => healthySnapshot());
    m.observeRead({ route: "GET /api/memories", method: "GET", status: 200, durMs: 12 });
    m.observeRead({ route: "GET /api/memories", method: "GET", status: 200, durMs: 5_000 });
    const text = await scrape(m);

    const fast = bucketCount(text, "duckbrain_read_duration_seconds", "0.05", /api\/memories/);
    const slow = bucketCount(text, "duckbrain_read_duration_seconds", "10", /api\/memories/);
    // One sample under 50 ms, both under 10 s — a histogram that measured the
    // right thing cannot report these as equal.
    expect(fast).toBe(1);
    expect(slow).toBe(2);
  });

  it("does not invent a duration when none was measured", async () => {
    const m = metricsWith(async () => healthySnapshot());
    // A read recorded without a duration (e.g. an aborted request) must not
    // silently become a zero-latency sample — that would flatter p50 forever.
    m.observeRead({ route: "GET /api/memories", method: "GET", status: 499 });
    const text = await scrape(m);
    expect(text).toContain(
      'duckbrain_reads_total{route="GET /api/memories",method="GET",status_class="4xx"} 1',
    );
    expect(text).not.toContain(
      'duckbrain_read_duration_seconds_count{route="GET /api/memories",method="GET"} 1',
    );
  });
});

describe("OBSDB-002: duckbrain_rejected_total", () => {
  it("counts a refused request by reason and normalized route", async () => {
    const m = metricsWith(async () => healthySnapshot());
    m.observeRejection({ reason: "rate_limit", method: "GET", rawPath: "/api/namespaces" });
    m.observeRejection({ reason: "rate_limit", method: "GET", rawPath: "/api/namespaces" });
    m.observeRejection({ reason: "dns_rebind", method: "POST", rawPath: "/api/memories" });
    const text = await scrape(m);

    expect(text).toMatch(/^# TYPE duckbrain_rejected_total counter$/m);
    expect(text).toContain(
      'duckbrain_rejected_total{reason="rate_limit",route="GET /api/namespaces"} 2',
    );
    // The route classifier is the READ truth table (a refused request never
    // reached a mounted route), so a refused WRITE is legitimately unmatched —
    // the sentinel, not a fabricated template.
    expect(text).toContain(
      'duckbrain_rejected_total{reason="dns_rebind",route="(unmatched)"} 1',
    );
  });

  it("collapses an attacker-chosen path to the sentinel — no secret becomes a label", async () => {
    const m = metricsWith(async () => healthySnapshot());
    m.observeRejection({
      reason: "dns_rebind",
      method: "GET",
      rawPath: "/api/memories/key/sk-live-SECRET-4242?token=abc",
    });
    const text = await scrape(m);

    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("token=");
    // /api/memories/key/:key IS a known template, so it may appear as the
    // template — but never with the substituted value.
    expect(text).toMatch(
      /duckbrain_rejected_total\{reason="dns_rebind",route="GET \/api\/memories\/key\/:key"\} 1/,
    );
  });

  it("drops a reason outside the fixed enum instead of inventing a label", async () => {
    const m = metricsWith(async () => healthySnapshot());
    // @ts-expect-error — deliberately outside the enum, as a hostile caller would
    m.observeRejection({ reason: "because-i-said-so", method: "GET", rawPath: "/api/namespaces" });
    const text = await scrape(m);
    expect(text).not.toContain("because-i-said-so");
    expect(text).toContain(
      'duckbrain_rejected_total{reason="unknown",route="GET /api/namespaces"} 1',
    );
  });

  it("keeps the reason domain to exactly the two guards that can refuse", () => {
    expect([...REJECTION_REASONS]).toEqual(["rate_limit", "dns_rebind"]);
    expect(rejectionReasonLabel("rate_limit")).toBe("rate_limit");
    expect(rejectionReasonLabel(undefined)).toBe("unknown");
    expect(rejectionRouteLabel("GET", "/nope/at/all")).toBe(REJECTION_ROUTE_SENTINEL);
    expect(rejectionRouteLabel(undefined, undefined)).toBe(REJECTION_ROUTE_SENTINEL);
  });
});

describe("OBSDB-002: label discipline across the new families", () => {
  it("exposes only route/method/reason/le labels — nothing identifying", async () => {
    const m = metricsWith(async () => healthySnapshot());
    m.observeRead({ route: "GET /api/memories", method: "GET", status: 500, durMs: 30 });
    m.observeRejection({ reason: "rate_limit", method: "GET", rawPath: "/api/memories" });
    const text = await scrape(m);

    const series = text
      .split("\n")
      .filter((l) => /^duckbrain_(read_duration_seconds|rejected_total)/.test(l));
    expect(series.length).toBeGreaterThan(0);
    for (const line of series) {
      const labelText = line.slice(0, line.lastIndexOf("}") + 1);
      const names = [...labelText.matchAll(/([a-z_]+)=/g)].map((mm) => mm[1]);
      for (const name of names) {
        expect(["route", "method", "reason", "le"]).toContain(name);
      }
      expect(labelText).not.toMatch(/namespace=|key=|id=|path=|ts=/);
    }
  });

  it("leaves the six OBSDB-001 families intact", async () => {
    const m = metricsWith(async () => healthySnapshot());
    const text = await scrape(m);
    for (const family of [
      "duckbrain_http_up",
      "duckbrain_health_status",
      "duckbrain_health_probe_duration_seconds",
      "duckbrain_embedding_provider_healthy",
      "duckbrain_build_info",
    ]) {
      expect(text).toMatch(new RegExp(`^# TYPE ${family} `, "m"));
    }
    // reads_total is a labeled counter: no series until its first observation.
    expect(text).toMatch(/^# TYPE duckbrain_reads_total /m);
  });
});
