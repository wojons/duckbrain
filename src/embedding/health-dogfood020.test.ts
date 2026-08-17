/**
 * DOGFOOD-020 Regression Tests: embedding provider health probe + /health
 * degraded status.
 *
 * Regressions guarded:
 *  - /health reports "degraded" (HTTP 200, body signal) when no embedding
 *    provider passed a real embed probe — no more false green while every
 *    ?q= semantic search 500s
 *  - the probe runs each provider's cheap isHealthy() gate first, then a REAL
 *    embed probe ("ping", short ~3s timeout) against the first isHealthy
 *    provider — one embed call in the common healthy path
 *  - fallback: when the first isHealthy provider's embed fails, the next
 *    isHealthy provider is probed (mirrors recall's DOGFOOD-002 fallback);
 *    overall healthy = ANY provider's embed probe succeeded
 *  - per-provider notes: embed HTTP error with body, "model not in /api/tags"
 *    (Ollama 404), "unreachable", "missing API key", capability gate
 *  - explicit provider config probes ONLY that provider
 *  - 30s in-process TTL cache: no second probe within TTL; re-probe after
 *    expiry
 *
 * Hermetic: fetch is stubbed globally; the config FILE is redirected to a
 * fresh temp dir by src/test-setup.ts (DUCKBRAIN_CONFIG_PATH) and env is
 * scrubbed per-test, so no real lmstudio/ollama/openai state is consulted.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Request, Response } from "express";
import {
  EMBEDDING_HEALTH_TTL_MS,
  getEmbeddingHealth,
  probeEmbeddingHealth,
  resetEmbeddingHealthCache,
} from "./health";
import { createHealthHandler } from "../cli/http";

const OLD_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.DUCKBRAIN_EMBEDDING_PROVIDER;
  delete process.env.DUCKBRAIN_EMBEDDING_MODEL;
  delete process.env.DUCKBRAIN_EMBEDDING_BASE_URL;
  delete process.env.DUCKBRAIN_EMBEDDING_API_KEY;
  delete process.env.DUCKBRAIN_EMBEDDING_DIMENSIONS;
  delete process.env.DUCKBRAIN_EMBEDDING_TIMEOUT_MS;
  resetEmbeddingHealthCache();
});

afterEach(() => {
  process.env = { ...OLD_ENV };
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Minimal fetch Response shape (ok/json/text) for stubbed fetch. */
function httpResponse(opts: {
  status?: number;
  json?: unknown;
  text?: string;
} = {}) {
  const status = opts.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => opts.json ?? {},
    text: async () => opts.text ?? "",
  };
}

/**
 * Fetch router for the fully-healthy auto path: lmstudio /v1/models and
 * /v1/embeddings answer, ollama /api/tags lists the configured model with the
 * embedding capability, everything else 404s.
 */
function healthyFetch() {
  return vi.fn(async (url: string) => {
    if (url.includes("/v1/models")) return httpResponse({ json: { data: [] } });
    if (url.includes("/api/tags"))
      return httpResponse({
        json: {
          models: [
            {
              name: "text-embedding-qwen3-embedding-0.6b",
              capabilities: ["embedding"],
            },
          ],
        },
      });
    if (url.includes("/embeddings"))
      return httpResponse({
        json: { data: [{ embedding: [0.1, 0.2, 0.3] }] },
      });
    return httpResponse({ status: 404 });
  });
}

function embedProbeCalls(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter(([url]) =>
    String(url).includes("/embeddings"),
  ).length;
}

describe("probeEmbeddingHealth (DOGFOOD-020)", () => {
  it("reports healthy when the first provider passes a real embed probe (ONE embed call)", async () => {
    const fetchMock = healthyFetch();
    vi.stubGlobal("fetch", fetchMock);

    const result = await probeEmbeddingHealth();

    expect(result.healthy).toBe(true);
    expect(result.provider).toBe("lmstudio");
    expect(result.model).toBe("text-embedding-qwen3-embedding-0.6b");
    expect(result.providers[0]).toEqual({
      id: "lmstudio",
      healthy: true,
      note: "ok",
    });
    // Common happy path: exactly ONE real embed probe (the first isHealthy
    // provider wins; later providers only run the cheap gate).
    expect(embedProbeCalls(fetchMock)).toBe(1);
    // Every provider got a per-provider entry (openai: no key configured).
    expect(result.providers.map((p) => p.id)).toEqual([
      "lmstudio",
      "ollama",
      "openai",
    ]);
  });

  it("falls back to the next isHealthy provider when the first embed probe fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/v1/models")) return httpResponse({ json: { data: [] } });
        if (url.includes("/v1/embeddings"))
          return httpResponse({
            status: 400,
            text: "LM Link connection closed",
          });
        if (url.includes("/api/tags"))
          return httpResponse({
            json: {
              models: [
                {
                  name: "text-embedding-qwen3-embedding-0.6b",
                  capabilities: ["embedding"],
                },
              ],
            },
          });
        if (url.includes("/api/embeddings"))
          return httpResponse({
            json: { embedding: [0.1, 0.2, 0.3] },
          });
        return httpResponse({ status: 404 });
      }),
    );

    const result = await probeEmbeddingHealth();

    // "any provider's embed probe succeeded" — ollama wins after lmstudio's
    // reachable-but-broken embed (the DOGFOOD-002 fallback semantic).
    expect(result.healthy).toBe(true);
    expect(result.provider).toBe("ollama");
    expect(result.providers[0]).toEqual({
      id: "lmstudio",
      healthy: false,
      note: "embed HTTP 400: LM Link connection closed",
    });
  });

  it("reports degraded with per-provider notes when everything is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("LM Link connection closed")),
    );

    const result = await probeEmbeddingHealth();

    expect(result.healthy).toBe(false);
    expect(result.provider).toBe("");
    expect(result.providers.every((p) => !p.healthy)).toBe(true);
    expect(result.providers[0].note).toMatch(/unreachable/);
    // openai's gate is config-only: no key configured → classified note.
    expect(result.providers[2].note).toMatch(/missing API key/);
  });

  it("normalizes Ollama's missing-model 404 to 'model not in /api/tags'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/v1/models"))
          return httpResponse({ status: 500, text: "boom" });
        if (url.includes("/api/tags"))
          return httpResponse({
            json: { models: [{ name: "other-model", capabilities: ["embedding"] }] },
          });
        if (url.includes("/api/embeddings"))
          return httpResponse({
            status: 404,
            text: 'model "text-embedding-qwen3-embedding-0.6b" not found, try pulling it first',
          });
        return httpResponse({ status: 404 });
      }),
    );

    const result = await probeEmbeddingHealth();

    expect(result.healthy).toBe(false);
    const ollama = result.providers.find((p) => p.id === "ollama");
    expect(ollama?.healthy).toBe(false);
    expect(ollama?.note).toBe("model not in /api/tags");
  });

  it("classifies a reachable-but-capability-less Ollama model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/v1/models"))
          return httpResponse({ status: 500, text: "boom" });
        if (url.includes("/api/tags"))
          return httpResponse({
            json: {
              models: [
                {
                  name: "text-embedding-qwen3-embedding-0.6b",
                  capabilities: ["completion"], // chat-only model
                },
              ],
            },
          });
        return httpResponse({ status: 404 });
      }),
    );

    const result = await probeEmbeddingHealth();

    const ollama = result.providers.find((p) => p.id === "ollama");
    expect(ollama?.healthy).toBe(false);
    expect(ollama?.note).toBe("model lacks embedding capability");
  });

  it("explicit provider config probes ONLY that provider", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/tags"))
        return httpResponse({
          json: {
            models: [
              { name: "nomic", capabilities: ["embedding"] },
            ],
          },
        });
      if (url.includes("/api/embeddings"))
        return httpResponse({ json: { embedding: [0.1, 0.2, 0.3] } });
      return httpResponse({ status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await probeEmbeddingHealth({
      provider: "ollama",
      model: "nomic",
    });

    expect(result.healthy).toBe(true);
    expect(result.provider).toBe("ollama");
    expect(result.providers).toEqual([
      { id: "ollama", healthy: true, note: "ok" },
    ]);
    // No lmstudio /v1/models probe, no openai entry.
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/v1/models")),
    ).toHaveLength(0);
  });

  it("env overrides the config FILE provider", async () => {
    const { updateConfig } = await import("../config/index.js");
    // Write an explicit lmstudio provider into the (env-redirected) config
    // file, then override via env — env must win (recall resolves env-only).
    updateConfig(".", {
      embedding: {
        provider: "lmstudio",
        model: "file-model",
        dimensions: 384,
        cacheDir: ".embeddings",
        concurrency: 4,
      },
    });
    process.env.DUCKBRAIN_EMBEDDING_PROVIDER = "ollama";
    process.env.DUCKBRAIN_EMBEDDING_MODEL = "env-model";

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/tags"))
        return httpResponse({
          json: { models: [{ name: "env-model", capabilities: ["embedding"] }] },
        });
      if (url.includes("/api/embeddings"))
        return httpResponse({ json: { embedding: [0.1] } });
      return httpResponse({ status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await probeEmbeddingHealth();

    expect(result.provider).toBe("ollama");
    expect(result.model).toBe("env-model");
    expect(result.providers.map((p) => p.id)).toEqual(["ollama"]);
    // No lmstudio probing despite the file config.
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/v1/models")),
    ).toHaveLength(0);
  });

  it("explicit param beats env", async () => {
    process.env.DUCKBRAIN_EMBEDDING_PROVIDER = "ollama";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await probeEmbeddingHealth({ provider: "openai" });

    // openai's gate is config-only: no key → classified note, zero fetches.
    expect(result.healthy).toBe(false);
    expect(result.providers).toEqual([
      {
        id: "openai",
        healthy: false,
        note: "missing API key (DUCKBRAIN_EMBEDDING_API_KEY)",
      },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getEmbeddingHealth TTL cache (DOGFOOD-020)", () => {
  it("serves the cached result within TTL — no second probe", async () => {
    const fetchMock = healthyFetch();
    vi.stubGlobal("fetch", fetchMock);

    const first = await getEmbeddingHealth();
    expect(first.healthy).toBe(true);
    const callsAfterFirst = fetchMock.mock.calls.length;

    const second = await getEmbeddingHealth();

    expect(second).toBe(first); // same cached object
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("re-probes after TTL expiry", async () => {
    vi.useFakeTimers();
    const fetchMock = healthyFetch();
    vi.stubGlobal("fetch", fetchMock);

    await getEmbeddingHealth();
    const callsBeforeExpiry = fetchMock.mock.calls.length;
    expect(callsBeforeExpiry).toBeGreaterThan(0);

    vi.advanceTimersByTime(EMBEDDING_HEALTH_TTL_MS + 1);
    await getEmbeddingHealth();

    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBeforeExpiry);
  });

  it("re-probes after resetEmbeddingHealthCache()", async () => {
    const fetchMock = healthyFetch();
    vi.stubGlobal("fetch", fetchMock);

    await getEmbeddingHealth();
    const callsBeforeReset = fetchMock.mock.calls.length;

    resetEmbeddingHealthCache();
    await getEmbeddingHealth();

    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBeforeReset);
  });
});

describe("createHealthHandler (DOGFOOD-020)", () => {
  function fakeRes() {
    const json = vi.fn();
    return { json, res: { json } as unknown as Response };
  }

  it("returns status degraded + embedding object when the probe reports unhealthy", async () => {
    const probe = vi.fn().mockResolvedValue({
      provider: "",
      model: "text-embedding-qwen3-embedding-0.6b",
      healthy: false,
      providers: [
        { id: "lmstudio", healthy: false, note: "unreachable" },
        { id: "ollama", healthy: false, note: "model not in /api/tags" },
      ],
    });
    const handler = createHealthHandler(probe);
    const { json, res } = fakeRes();

    await handler({} as Request, res);

    expect(json).toHaveBeenCalledTimes(1);
    const body = json.mock.calls[0][0];
    expect(body.status).toBe("degraded");
    expect(body.embedding).toEqual(await probe());
    expect(body.uptime).toBeGreaterThan(0);
    expect(body.timestamp).toBeTruthy();
  });

  it("returns status healthy when the probe reports healthy", async () => {
    const probe = vi.fn().mockResolvedValue({
      provider: "ollama",
      model: "text-embedding-qwen3-embedding-0.6b",
      healthy: true,
      providers: [{ id: "ollama", healthy: true, note: "ok" }],
    });
    const handler = createHealthHandler(probe);
    const { json, res } = fakeRes();

    await handler({} as Request, res);

    expect(json.mock.calls[0][0].status).toBe("healthy");
    expect(json.mock.calls[0][0].embedding.healthy).toBe(true);
  });

  it("never throws on a failing probe — reports degraded instead (liveness)", async () => {
    const probe = vi.fn().mockRejectedValue(new Error("probe exploded"));
    const handler = createHealthHandler(probe);
    const { json, res } = fakeRes();

    await expect(handler({} as Request, res)).resolves.toBeUndefined();

    const body = json.mock.calls[0][0];
    expect(body.status).toBe("degraded");
    expect(body.embedding.healthy).toBe(false);
    expect(body.embedding.providers[0].note).toMatch(/probe error: probe exploded/);
  });

  it("wires the real cached probe by default", async () => {
    // Full-stack-ish hermetic check: the default handler probes through
    // getEmbeddingHealth() (TTL cache included) with stubbed fetch.
    const fetchMock = healthyFetch();
    vi.stubGlobal("fetch", fetchMock);
    const handler = createHealthHandler();
    const { json, res } = fakeRes();

    await handler({} as Request, res);

    const body = json.mock.calls[0][0];
    expect(body.status).toBe("healthy");
    expect(body.embedding.provider).toBe("lmstudio");
    expect(embedProbeCalls(fetchMock)).toBe(1);
  });
});
