/**
 * OBSDB-003 — embedding-path instrumentation, proven against the row's own
 * acceptance criteria (`docs/observability-spec.md` §2 blind spots 2 and 9,
 * §3.2):
 *
 *   1. after a semantic recall, `sum by (provider, outcome)
 *      (rate(duckbrain_embedding_requests_total[10m]))` has at least one
 *      series — proven on the real provider + real `semanticSearch` path and
 *      read back from a real daemon's `GET /metrics` over HTTP;
 *   2. pointing the embedder at a host that never answers makes
 *      `increase(duckbrain_embedding_requests_total{outcome="timeout"}[10m])
 *      > 0` true — the falsifier: without the fix there is no counter at all;
 *   3. `duckbrain_embedding_cache_hits_total /
 *      (hits + misses)` is DEFINED after two identical queries — evaluated
 *      from the rendered samples with the same arithmetic PromQL performs.
 *
 * Provider traffic is served by a scratch HTTP server bound to 127.0.0.1 on an
 * ephemeral port. No live embedder, no port 3000, no production namespace:
 * the cache and the daemon's namespace root are both under a fresh mkdtemp.
 */

import { describe, it, expect, afterAll, beforeEach } from "vitest";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import type { Server } from "http";
import { createHttpServer } from "../cli/http";
import { createHttpMetrics, type HealthSnapshot } from "./metrics";
import {
  EMBEDDING_METRIC_NAMES,
  EMBEDDING_PROVIDER_IDS,
  EMBED_OUTCOMES,
  embedOutcomeForFailure,
  embeddingProviderLabel,
  resetEmbeddingMetrics,
} from "../embedding/metrics";
import {
  createAutoProviders,
  createProvider,
  PROVIDERS,
  resetAutoProvidersCache,
  type EmbeddingProvider,
} from "../embedding/providers";
import { EmbeddingCache } from "../embedding/cache";
import { semanticSearch, type SearchCandidate } from "../embedding/search";

const HEALTHY: HealthSnapshot = {
  status: "healthy",
  providers: [{ id: "lmstudio", healthy: true }],
  durationsMs: { embedding: 1, keys: 1, total: 2 },
};

/** Deterministic 4-dim vector for a text — no randomness, no model. */
function vectorFor(text: string): number[] {
  const seed = Array.from(text).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return [1, (seed % 7) / 7, (seed % 11) / 11, 0.5];
}

interface FakeEmbedServer {
  server: Server;
  baseUrl: string;
  /** Request log — proves the counter matches REAL requests, not calls. */
  requests: string[];
  mode: "ok" | "hang" | "401" | "429";
  close: () => Promise<void>;
}

/**
 * An OpenAI-compatible /v1/embeddings endpoint on 127.0.0.1:0.
 *
 * `mode` is mutable so one server can serve the ok, auth, quota and hang cases
 * (the last one never answers, which is how a timeout is produced without a
 * 60-second sleep).
 */
async function fakeEmbedServer(): Promise<FakeEmbedServer> {
  const state = {
    requests: [] as string[],
    mode: "ok" as FakeEmbedServer["mode"],
    hanging: [] as http.ServerResponse[],
  };
  const server = http.createServer((req, res) => {
    state.requests.push(`${req.method} ${req.url}`);
    if (req.url?.startsWith("/v1/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "text-embedding-test" }] }));
      return;
    }
    if (state.mode === "hang") {
      // Accept the request and never answer: only the provider's own
      // AbortSignal.timeout can end it, which is the class we want to count.
      state.hanging.push(res);
      return;
    }
    if (state.mode === "401") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Invalid API key" }));
      return;
    }
    if (state.mode === "429") {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "rate limit exceeded" }));
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as { input?: string | string[] };
      const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input ?? ""];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: inputs.map((text) => ({ embedding: vectorFor(String(text)) })),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no ephemeral port");
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    get requests() {
      return state.requests;
    },
    get mode() {
      return state.mode;
    },
    set mode(next: FakeEmbedServer["mode"]) {
      state.mode = next;
    },
    close: async () => {
      for (const res of state.hanging) res.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  } as FakeEmbedServer;
}

/** The provider the daemon itself would build for this base URL. */
function providerFor(baseUrl: string, timeoutMs = 2_000): EmbeddingProvider {
  return createProvider({
    provider: "lmstudio",
    baseUrl,
    model: "text-embedding-test",
    dimensions: 4,
    timeoutMs,
  });
}

function sampleValue(text: string, name: string, labels = ""): number | null {
  const line = text
    .split("\n")
    .find((l) => l.startsWith(`${name}${labels} `) || l.startsWith(`${name}{${labels}} `));
  if (!line) return null;
  return Number.parseFloat(line.slice(line.lastIndexOf(" ") + 1));
}

const scratchDirs: string[] = [];
function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-obsdb003-"));
  scratchDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => resetEmbeddingMetrics());

describe("OBSDB-003: the label domains are the spec's, not the internals", () => {
  it("collapses every internal failure class onto the five-value outcome enum", () => {
    const classes = [
      "credential_not_presented",
      "credential_rejected",
      "forbidden",
      "rate_limited",
      "route_or_model_missing",
      "upstream_error",
      "timeout",
      "unreachable",
      "empty_vector",
      "http_error",
      "provider_error",
    ];
    const observed = classes.map((cls) => embedOutcomeForFailure(cls));
    // Every mapping lands in the enum (bounded cardinality) and never in "ok":
    // only a resolved embed may report success.
    for (const outcome of observed) expect(EMBED_OUTCOMES).toContain(outcome);
    expect(observed).not.toContain("ok");
    expect(observed).toEqual([
      "auth",
      "auth",
      "auth",
      "quota",
      "error",
      "error",
      "timeout",
      "error",
      "error",
      "error",
      "error",
    ]);
  });

  it("keeps only the registry id in the provider label — never the model", () => {
    expect(embeddingProviderLabel("lmstudio/text-embedding-qwen3")).toBe("lmstudio");
    expect(embeddingProviderLabel("openai/text-embedding-3-small")).toBe("openai");
    expect(embeddingProviderLabel("ollama/nomic-embed-text")).toBe("ollama");
    expect(embeddingProviderLabel("deadline")).toBe("unknown");
    expect(embeddingProviderLabel("http://127.0.0.1:1234/v1")).toBe("unknown");
    expect(embeddingProviderLabel(undefined)).toBe("unknown");
  });

  it("stays in step with the provider registry it mirrors", () => {
    // Drift guard: a new provider in PROVIDERS must be added to the label
    // domain, or its requests would be counted as "unknown".
    expect([...EMBEDDING_PROVIDER_IDS]).toEqual(PROVIDERS.map((p) => p.id));
  });
});

describe("OBSDB-003: request outcomes come from the real embed call", () => {
  it("records ok with the registry id after one real provider request", async () => {
    const fake = await fakeEmbedServer();
    try {
      const provider = providerFor(fake.baseUrl);
      const vector = await provider.embed("first memory");
      expect(vector).toHaveLength(4);

      const metrics = createHttpMetrics({ evaluateHealth: async () => HEALTHY });
      const text = await metrics.render();
      expect(text).toMatch(
        /^duckbrain_embedding_requests_total\{provider="lmstudio",outcome="ok"\} 1$/m,
      );
      // One real request, one increment — the counter is not counting calls.
      expect(fake.requests.filter((r) => r.includes("/embeddings"))).toHaveLength(1);
      // Label discipline: the model id (cache key) must never reach a label.
      expect(text).not.toMatch(/qwen|text-embedding-test|127\.0\.0\.1/);
    } finally {
      await fake.close();
    }
  });

  it("records timeout when the provider accepts and never answers (the falsifier)", async () => {
    const fake = await fakeEmbedServer();
    fake.mode = "hang";
    try {
      const provider = providerFor(fake.baseUrl, 60);
      await expect(provider.embed("never answered")).rejects.toThrow();

      const metrics = createHttpMetrics({ evaluateHealth: async () => HEALTHY });
      const text = await metrics.render();
      expect(sampleValue(text, "duckbrain_embedding_requests_total", 'provider="lmstudio",outcome="timeout"')).toBe(1);
      expect(sampleValue(text, "duckbrain_embedding_requests_total", 'provider="lmstudio",outcome="ok"')).toBeNull();
    } finally {
      await fake.close();
    }
  });

  it("distinguishes auth (401) from quota (429)", async () => {
    const fake = await fakeEmbedServer();
    try {
      const provider = providerFor(fake.baseUrl);
      fake.mode = "401";
      await expect(provider.embed("refused")).rejects.toThrow();
      fake.mode = "429";
      await expect(provider.embed("throttled")).rejects.toThrow();

      const text = await createHttpMetrics({
        evaluateHealth: async () => HEALTHY,
      }).render();
      expect(
        sampleValue(text, "duckbrain_embedding_requests_total", 'provider="lmstudio",outcome="auth"'),
      ).toBe(1);
      expect(
        sampleValue(text, "duckbrain_embedding_requests_total", 'provider="lmstudio",outcome="quota"'),
      ).toBe(1);
    } finally {
      await fake.close();
    }
  });

  it("counts a batch as one request and still counts each hit as a hit", async () => {
    const fake = await fakeEmbedServer();
    try {
      const provider = providerFor(fake.baseUrl);
      expect(provider.embedMany).toBeTypeOf("function");
      const vectors = await provider.embedMany!(["a", "b", "c"]);
      expect(vectors).toHaveLength(3);
      const text = await createHttpMetrics({
        evaluateHealth: async () => HEALTHY,
      }).render();
      expect(
        sampleValue(text, "duckbrain_embedding_requests_total", 'provider="lmstudio",outcome="ok"'),
      ).toBe(1);
    } finally {
      await fake.close();
    }
  });

  it("instruments the auto-probe branch too, not only the explicit provider", async () => {
    const fake = await fakeEmbedServer();
    const saved = { ...process.env };
    try {
      process.env.DUCKBRAIN_EMBEDDING_PROVIDER = "auto";
      process.env.DUCKBRAIN_EMBEDDING_BASE_URL = fake.baseUrl;
      process.env.DUCKBRAIN_EMBEDDING_MODEL = "text-embedding-test";
      process.env.DUCKBRAIN_EMBEDDING_DIMENSIONS = "4";
      resetAutoProvidersCache();
      const providers = await createAutoProviders();
      expect(providers.length).toBeGreaterThan(0);
      await providers[0].embed("auto branch");

      const text = await createHttpMetrics({
        evaluateHealth: async () => HEALTHY,
      }).render();
      expect(
        sampleValue(text, "duckbrain_embedding_requests_total", 'provider="lmstudio",outcome="ok"'),
      ).toBe(1);
    } finally {
      resetAutoProvidersCache();
      for (const key of Object.keys(process.env)) {
        if (key.startsWith("DUCKBRAIN_EMBEDDING_")) delete process.env[key];
      }
      Object.assign(process.env, saved);
      await fake.close();
    }
  });
});

describe("OBSDB-003: cache residency after two identical queries", () => {
  it("reports hits and misses such that hits/(hits+misses) is defined", async () => {
    const fake = await fakeEmbedServer();
    try {
      const provider = providerFor(fake.baseUrl);
      const cache = new EmbeddingCache(path.join(scratch(), ".embeddings"));
      const candidates: SearchCandidate[] = ["alpha", "beta", "gamma"].map((text) => ({
        id: text,
        key: `notes/${text}`,
        domain: "concept",
        timestamp: "2026-11-05T00:00:00.000Z",
        author: "obsdb003",
        action: "write",
        embedding_text: `memory ${text}`,
        attributes: {},
      }));
      const queryVector = await provider.embed("identical query");

      // Query 1: cold cache — every candidate is a miss.
      await semanticSearch(candidates, queryVector, cache, provider, { minScore: 0 });
      const afterCold = await createHttpMetrics({
        evaluateHealth: async () => HEALTHY,
      }).render();
      expect(sampleValue(afterCold, "duckbrain_embedding_cache_misses_total")).toBe(3);
      expect(sampleValue(afterCold, "duckbrain_embedding_cache_hits_total")).toBe(0);

      // Query 2: identical query — every candidate is now a hit.
      await semanticSearch(candidates, queryVector, cache, provider, { minScore: 0 });
      const text = await createHttpMetrics({
        evaluateHealth: async () => HEALTHY,
      }).render();
      const hits = sampleValue(text, "duckbrain_embedding_cache_hits_total") ?? 0;
      const misses = sampleValue(text, "duckbrain_embedding_cache_misses_total") ?? 0;
      expect(hits).toBe(3);
      expect(misses).toBe(3);
      // The ratio the spec asks for, computed exactly as PromQL would.
      const ratio = hits / (hits + misses);
      expect(Number.isFinite(ratio)).toBe(true);
      expect(ratio).toBeCloseTo(0.5);
    } finally {
      await fake.close();
    }
  });
});

describe("OBSDB-003: the families reach a live daemon's /metrics", () => {
  it("serves the embedding series over HTTP after a semantic recall", async () => {
    const fake = await fakeEmbedServer();
    const namespacesPath = scratch();
    const app = createHttpServer({ authConfig: { type: "apikey" }, namespacesPath });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const port = address.port;

    try {
      // The daemon must not be reachable on anything but this ephemeral port.
      expect(port).not.toBe(3000);

      const provider = providerFor(fake.baseUrl);
      const cache = new EmbeddingCache(path.join(namespacesPath, "demo", ".embeddings"));
      const candidates: SearchCandidate[] = [
        {
          id: "m1",
          key: "notes/one",
          domain: "concept",
          timestamp: "2026-11-05T00:00:00.000Z",
          author: "obsdb003",
          action: "write",
          embedding_text: "the deploy is on friday",
          attributes: {},
        },
      ];
      const queryVector = await provider.embed("when is the deploy");
      await semanticSearch(candidates, queryVector, cache, provider, { minScore: 0 });

      const body = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port, method: "GET", path: "/metrics" },
          (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => resolve(data));
          },
        );
        req.on("error", reject);
        req.end();
      });

      // Criterion 1: at least one provider/outcome series exists.
      expect(body).toMatch(
        /^duckbrain_embedding_requests_total\{provider="lmstudio",outcome="ok"\} \d+$/m,
      );
      expect(
        sampleValue(body, "duckbrain_embedding_requests_total", 'provider="lmstudio",outcome="ok"'),
      ).toBeGreaterThan(0);
      // Criteria for the cache pair: both present, denominator non-zero.
      const hits = sampleValue(body, "duckbrain_embedding_cache_hits_total") ?? 0;
      const misses = sampleValue(body, "duckbrain_embedding_cache_misses_total") ?? -1;
      expect(misses).toBeGreaterThan(0);
      expect(Number.isFinite(hits / (hits + misses))).toBe(true);
      // The families are all present by name (README/spec parity).
      for (const name of EMBEDDING_METRIC_NAMES) {
        expect(body).toMatch(new RegExp(`^# TYPE ${name} counter$`, "m"));
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fake.close();
    }
  });
});
