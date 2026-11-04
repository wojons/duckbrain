/**
 * OBSDB-001 — the Prometheus `/metrics` surface.
 *
 * What is under test (spec `docs/observability-spec.md` §3.1, §4, §6):
 *   1. exactly the six MVP families render, `duckbrain_http_up` first, with the
 *      documented types (gauge/gauge/histogram/gauge/counter/gauge);
 *   2. the health gauge carries the SAME three-way verdict the /health code
 *      already defines (2 healthy / 1 degraded / 0 hung) and comes from the
 *      shared evaluator, not a second probe;
 *   3. the probe histogram is labelled probe=embedding|keys|total and a value
 *      that never settles degrades to 0 instead of hanging the scrape;
 *   4. every label value comes from a fixed enum or a normalized route
 *      template — a raw path/key/namespace is DROPPED, and no ISO timestamp
 *      ever appears in a label;
 *   5. the read counter is fed by the read-ledger middleware (the same
 *      classification the ledger uses) and only counts what the ledger counts;
 *   6. mount order, proven on the real `createHttpServer()` app: /metrics
 *      answers with NO credentials and is NOT rate-limited, while the sibling
 *      API route behind auth/rate-limit still answers 401 and then 429.
 *
 * The unit half is hermetic (injected evaluator, fake Response); the mount
 * order half uses the production assembler on an ephemeral port, like
 * `src/http/readLedger.integration.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import type { Server } from "http";
import { createHttpServer } from "../cli/http";
import {
  createHttpMetrics,
  isRouteTemplate,
  METRIC_NAMES,
  providerLabel,
  statusClass,
  type HealthSnapshot,
  type HttpMetrics,
} from "./metrics";

/** Minimal express Response double: header + status + body capture. */
function fakeRes() {
  const captured = {
    body: "",
    headers: {} as Record<string, string>,
  };
  const res: any = {
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
      return res;
    },
    status(code: number) {
      (captured as any).statusCode = code;
      return res;
    },
    end(body?: string) {
      captured.body = body ?? "";
      return res;
    },
  };
  return { res: res as any, captured };
}

/** Run one scrape through the real handler and return the exposition text. */
async function scrape(metrics: HttpMetrics): Promise<string> {
  const { res, captured } = fakeRes();
  await metrics.handler({} as any, res);
  return captured.body;
}

interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** Parse the text exposition format 0.0.4 into samples (comments skipped). */
function parseSamples(text: string): Sample[] {
  const out: Sample[] = [];
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const braceAt = line.indexOf("{");
    let name: string;
    let labels: Record<string, string> = {};
    let rest: string;
    if (braceAt === -1) {
      const space = line.indexOf(" ");
      name = line.slice(0, space);
      rest = line.slice(space + 1);
    } else {
      name = line.slice(0, braceAt);
      const close = line.lastIndexOf("}");
      const labelText = line.slice(braceAt + 1, close);
      rest = line.slice(close + 1);
      for (const pair of labelText.split(",")) {
        const eq = pair.indexOf("=");
        const key = pair.slice(0, eq);
        const value = pair.slice(eq + 1);
        labels[key] = value.replace(/^"|"$/g, "");
      }
    }
    out.push({ name, labels, value: Number.parseFloat(rest.trim()) });
  }
  return out;
}

const healthySnapshot = (): HealthSnapshot => ({
  status: "healthy",
  providers: [{ id: "lmstudio", healthy: true }],
  durationsMs: { embedding: 12, keys: 3, total: 15 },
});

const metricsWith = (
  evaluateHealth: () => Promise<HealthSnapshot>,
  overrides: Partial<Parameters<typeof createHttpMetrics>[0]> = {},
): HttpMetrics =>
  createHttpMetrics({
    evaluateHealth,
    version: "1.1.0",
    nodeVersion: "v22.0.0",
    ...overrides,
  });

describe("OBSDB-001: /metrics exposition shape", () => {
  it("renders exactly the metric families, duckbrain_http_up first", async () => {
    const metrics = metricsWith(async () => healthySnapshot());
    // A read must have been recorded for the counter family to exist — a
    // counter with no observation genuinely has no series, so this test seeds
    // one instead of pretending the family is always present.
    metrics.observeRead({
      route: "GET /api/memories",
      method: "GET",
      status: 200,
    });
    const text = await scrape(metrics);

    expect(text.split("\n")[0]).toMatch(/^# HELP duckbrain_http_up /);
    const families = text
      .split("\n")
      .filter((line) => line.startsWith("# TYPE "))
      .map((line) => line.replace("# TYPE ", ""));
    // OBSDB-002 grew the set from six families to eight: read latency and
    // refusals. The assertion stays exact on purpose — a family appearing
    // without a row and a review is the failure mode this guards.
    expect(families).toEqual([
      "duckbrain_http_up gauge",
      "duckbrain_health_status gauge",
      "duckbrain_health_probe_duration_seconds histogram",
      "duckbrain_embedding_provider_healthy gauge",
      "duckbrain_reads_total counter",
      "duckbrain_read_duration_seconds histogram",
      "duckbrain_rejected_total counter",
      "duckbrain_build_info gauge",
    ]);
    // …and nothing else is exposed.
    expect(families.map((line) => line.split(" ")[0])).toEqual([...METRIC_NAMES]);

    const samples = parseSamples(text);
    expect(
      samples.find((sample) => sample.name === "duckbrain_http_up")?.value,
    ).toBe(1);
    expect(
      samples.find((sample) => sample.name === "duckbrain_build_info")?.labels,
    ).toEqual({ version: "1.1.0", node: "v22.0.0" });
    expect(
      samples.find((sample) => sample.name === "duckbrain_build_info")?.value,
    ).toBe(1);
  });

  it("sets the exposition content type to the 0.0.4 text format", async () => {
    const metrics = metricsWith(async () => healthySnapshot());
    const { res, captured } = fakeRes();
    await metrics.handler({} as any, res);
    expect(captured.headers["Content-Type"]).toMatch(
      /^text\/plain; version=0\.0\.4/,
    );
  });

  it("duckbrain_health_status maps the /health verdict 2 / 1 / 0", async () => {
    const cases: Array<[HealthSnapshot["status"], number]> = [
      ["healthy", 2],
      ["degraded", 1],
      ["hung", 0],
    ];
    for (const [status, expected] of cases) {
      const metrics = metricsWith(async () => ({
        ...healthySnapshot(),
        status,
      }));
      const samples = parseSamples(await scrape(metrics));
      expect(
        samples.find((sample) => sample.name === "duckbrain_health_status")
          ?.value,
      ).toBe(expected);
    }
  });

  it("times the three probes into duckbrain_health_probe_duration_seconds", async () => {
    const metrics = metricsWith(async () => healthySnapshot());
    const samples = parseSamples(await scrape(metrics));

    const counts = new Map(
      samples
        .filter(
          (sample) =>
            sample.name === "duckbrain_health_probe_duration_seconds_count",
        )
        .map((sample) => [sample.labels.probe, sample.value]),
    );
    expect([...counts.keys()].sort()).toEqual(["embedding", "keys", "total"]);
    for (const probe of ["embedding", "keys", "total"]) {
      expect(counts.get(probe)).toBe(1);
    }

    const sums = new Map(
      samples
        .filter(
          (sample) =>
            sample.name === "duckbrain_health_probe_duration_seconds_sum",
        )
        .map((sample) => [sample.labels.probe, sample.value]),
    );
    expect(sums.get("embedding")).toBeCloseTo(0.012, 6);
    expect(sums.get("keys")).toBeCloseTo(0.003, 6);
    expect(sums.get("total")).toBeCloseTo(0.015, 6);

    // Only the documented probe values exist as series.
    const probes = new Set(
      samples
        .filter((sample) =>
          sample.name.startsWith("duckbrain_health_probe_duration_seconds"),
        )
        .map((sample) => sample.labels.probe),
    );
    expect([...probes].sort()).toEqual(["embedding", "keys", "total"]);
  });

  it("never hangs a scrape: an evaluator that never settles yields 0 (hung)", async () => {
    const metrics = metricsWith(() => new Promise<HealthSnapshot>(() => {}), {
      healthDeadlineMs: 25,
    });
    const started = Date.now();
    const samples = parseSamples(await scrape(metrics));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(
      samples.find((sample) => sample.name === "duckbrain_health_status")?.value,
    ).toBe(0);
  });

  it("reuses one evaluation inside the TTL and re-evaluates after it", async () => {
    let calls = 0;
    let clock = 1_000;
    const metrics = metricsWith(
      async () => {
        calls += 1;
        return healthySnapshot();
      },
      { healthTtlMs: 30_000, now: () => clock },
    );

    await scrape(metrics);
    await scrape(metrics);
    expect(calls).toBe(1);
    // A reused verdict must not be re-timed: the histogram counts PROBES, not
    // scrapes (otherwise _count tracks the scrape interval).
    const reuseText = await scrape(metrics);
    const embeddingCounts = parseSamples(reuseText)
      .filter(
        (sample) =>
          sample.name === "duckbrain_health_probe_duration_seconds_count" &&
          sample.labels.probe === "embedding",
      )
      .map((sample) => sample.value);
    expect(embeddingCounts).toEqual([1]);

    clock += 30_001;
    await scrape(metrics);
    expect(calls).toBe(2);
  });

  it("replaces provider children instead of accumulating them", async () => {
    let snapshot: HealthSnapshot = {
      status: "degraded",
      providers: [
        { id: "lmstudio", healthy: true },
        { id: "deadline", healthy: false },
      ],
      durationsMs: { embedding: 1, keys: 1, total: 2 },
    };
    let clock = 0;
    const metrics = metricsWith(async () => snapshot, {
      healthTtlMs: 1,
      now: () => clock,
    });

    let text = await scrape(metrics);
    const first = parseSamples(text)
      .filter((sample) => sample.name === "duckbrain_embedding_provider_healthy")
      .map((sample) => [sample.labels.provider, sample.value]);
    // "deadline" is a synthetic probe id, not an embedder — it collapses to the
    // fixed `unknown` value instead of inventing a provider label.
    expect(first).toEqual([
      ["lmstudio", 1],
      ["unknown", 0],
    ]);

    clock += 10;
    snapshot = {
      status: "healthy",
      providers: [{ id: "openai", healthy: true }],
      durationsMs: { embedding: 1, keys: 1, total: 2 },
    };
    text = await scrape(metrics);
    const second = parseSamples(text)
      .filter((sample) => sample.name === "duckbrain_embedding_provider_healthy")
      .map((sample) => [sample.labels.provider, sample.value]);
    expect(second).toEqual([["openai", 1]]);
  });
});

describe("OBSDB-001: label discipline", () => {
  it("drops any route that is not a normalized template", async () => {
    const metrics = metricsWith(async () => healthySnapshot());
    metrics.observeRead({
      route: "GET /api/memories",
      method: "GET",
      status: 200,
    });
    // Every one of these is what a naive implementation would emit.
    metrics.observeRead({
      route: "/api/memories/key/alice-secret",
      method: "GET",
      status: 200,
    });
    metrics.observeRead({
      route: "GET /api/ns/tenant-acme/tables",
      method: "GET",
      status: 200,
    });
    metrics.observeRead({
      route: "GET /api/memories",
      method: "G ET",
      status: 200,
    });

    const text = await scrape(metrics);
    expect(text).not.toContain("alice-secret");
    expect(text).not.toContain("tenant-acme");

    const routes = new Set(
      parseSamples(text)
        .filter((sample) => sample.name === "duckbrain_reads_total")
        .map((sample) => sample.labels.route),
    );
    expect([...routes]).toEqual(["GET /api/memories"]);
  });

  it("emits only fixed-enum label values and no timestamp anywhere", async () => {
    const metrics = metricsWith(async () => ({
      status: "degraded",
      providers: [
        { id: "lmstudio", healthy: false },
        { id: "Some Tenant/Key:123", healthy: false },
      ],
      durationsMs: { embedding: 4, keys: 2, total: 6 },
    }));
    metrics.observeRead({
      route: "GET /api/memories/key/:key",
      method: "GET",
      status: 404,
    });
    metrics.observeRead({
      route: "GET /api/ns/:ns/tables",
      method: "GET",
      status: 503,
    });

    const text = await scrape(metrics);
    // An ISO timestamp in a label value would look like this.
    expect(text).not.toMatch(/="[0-9]{4}-[0-9]{2}-[0-9]{2}T/);

    const allowedLabels = new Set([
      "route",
      "method",
      "status_class",
      "probe",
      "provider",
      "version",
      "node",
      // prom-client's own bucket label on the histogram — never ours.
      "le",
    ]);
    for (const sample of parseSamples(text)) {
      for (const [key, value] of Object.entries(sample.labels)) {
        expect(allowedLabels.has(key), `unexpected label ${key}`).toBe(true);
        if (key === "le") expect(value).toMatch(/^(\+Inf|[0-9.]+)$/);
        if (key === "route") expect(value).toMatch(/^(GET|HEAD) \//);
        if (key === "method") expect(value).toMatch(/^(GET|HEAD)$/);
        if (key === "status_class") expect(value).toMatch(/^[1-5]xx$/);
        if (key === "probe") expect(["embedding", "keys", "total"]).toContain(value);
        if (key === "provider")
          expect(["lmstudio", "openai", "ollama", "unknown"]).toContain(value);
      }
    }
  });

  it("statusClass buckets statuses and providerLabel collapses strangers", () => {
    expect(statusClass(200)).toBe("2xx");
    expect(statusClass(404)).toBe("4xx");
    expect(statusClass(503)).toBe("5xx");
    expect(statusClass(0)).toBe("unknown");
    expect(providerLabel("lmstudio")).toBe("lmstudio");
    expect(providerLabel("openai")).toBe("openai");
    expect(providerLabel("deadline")).toBe("unknown");
    expect(providerLabel("../../etc/passwd")).toBe("unknown");
    expect(providerLabel(undefined)).toBe("unknown");
  });

  it("isRouteTemplate accepts the ledger's templates and nothing else", () => {
    // Every template src/http/readLedger.ts:normalizeReadRoute can return.
    for (const route of [
      "GET /api/memories",
      "HEAD /api/memories",
      "GET /api/memories/key/:key",
      "GET /api/memories/:id",
      "GET /api/keys",
      "GET /api/keys/flat",
      "GET /api/namespaces",
      "GET /api/ns/:ns/tables",
      "GET /api/ns/:ns/tables/:table",
      "GET /activity",
      "GET /api/events/:ns",
      "GET /api/events/:ns/stats",
    ]) {
      expect(isRouteTemplate(route), route).toBe(true);
    }
    // …and anything carrying a real value or a free-form path is refused.
    for (const route of [
      "GET /api/ns/tenant-acme/tables",
      "GET /api/memories/key/alice-secret",
      "/api/memories",
      "GET /",
      "GET /api/reads",
      "GET /api/memories?ns=acme",
      "GET /api/memories/key/:unknown",
    ]) {
      expect(isRouteTemplate(route), route).toBe(false);
    }
  });
});

describe("OBSDB-001: duckbrain_reads_total", () => {
  it("increments once per recorded read and buckets by status class", async () => {
    const metrics = metricsWith(async () => healthySnapshot());
    metrics.observeRead({ route: "GET /api/keys", method: "GET", status: 200 });
    metrics.observeRead({ route: "GET /api/keys", method: "GET", status: 200 });
    metrics.observeRead({ route: "GET /api/keys", method: "GET", status: 401 });

    const samples = parseSamples(await scrape(metrics));
    const counters = samples
      .filter((sample) => sample.name === "duckbrain_reads_total")
      .map((sample) => [sample.labels.status_class, sample.value]);
    expect(counters).toEqual([
      ["2xx", 2],
      ["4xx", 1],
    ]);
  });
});

describe("OBSDB-001: mount order on the real app", () => {
  let server: Server;
  let port = 0;
  let scratchDir: string;

  function request(
    method: string,
    requestPath: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: requestPath,
          method,
          headers: { Host: "localhost", ...headers },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => {
            data += chunk.toString();
          });
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: data }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  beforeAll(async () => {
    scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-metrics-obsdb001-"),
    );
    // apikey auth with no credential store: every API call is a 401, the exact
    // shape of the live daemon where /metrics answered 401 before this row.
    // rateLimit 1/min makes the "not rate-limited" claim falsifiable: the
    // sibling API route MUST 429 on its second call.
    const app = createHttpServer({
      authConfig: { type: "apikey" },
      namespacesPath: scratchDir,
      rateLimit: 1,
    });
    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr !== "string") port = addr.port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (scratchDir) fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it("answers /metrics with no credentials, and counts the 401'd read", async () => {
    // 1. An unauthenticated API read: 401 (auth) but RECORDED (ledger runs
    //    before auth), which is what the read counter must mirror.
    const api = await request("GET", "/api/namespaces");
    expect(api.status).toBe(401);

    // 2. /metrics with no Authorization header at all — auth-exempt.
    const first = await request("GET", "/metrics");
    expect(first.status).toBe(200);
    expect(first.body.split("\n")[0]).toMatch(/^# HELP duckbrain_http_up /);
    expect(first.body).toMatch(
      /^duckbrain_reads_total\{route="GET \/api\/namespaces",method="GET",status_class="4xx"\} 1$/m,
    );

    // 3. Still 200 on a second scrape: the limiter (1/min) did not apply.
    const second = await request("GET", "/metrics");
    expect(second.status).toBe(200);

    // 4. …while the API route is genuinely rate-limited now. This is the
    //    falsifiable half: /metrics' exemption means nothing unless the limiter
    //    is armed for everything else.
    const throttled = await request("GET", "/namespaces");
    expect(throttled.status).toBe(429);
  });

  it("every family from the spec is present after the first read", async () => {
    const { body } = await request("GET", "/metrics");
    for (const name of METRIC_NAMES) {
      expect(body).toMatch(new RegExp(`^${name}`, "m"));
    }
  });
});
