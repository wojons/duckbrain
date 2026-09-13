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
  EMBEDDING_HEALTH_DEADLINE_MS,
  EMBEDDING_HEALTH_TTL_MS,
  getEmbeddingHealth,
  probeEmbeddingHealth,
  resetEmbeddingHealthCache,
  type EmbeddingHealthResult,
} from "./health";
import { classifyEmbedFailure, redactSecrets } from "./providers";
import { preflightEmbedding } from "./preflight";
import { runEmbeddingPreflightCli } from "../cli/embedding-preflight";
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
function httpResponse(
  opts: {
    status?: number;
    json?: unknown;
    text?: string;
  } = {},
) {
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
        if (url.includes("/v1/models"))
          return httpResponse({ json: { data: [] } });
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
            json: {
              models: [{ name: "other-model", capabilities: ["embedding"] }],
            },
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
            models: [{ name: "nomic", capabilities: ["embedding"] }],
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
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("/v1/models"),
      ),
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
          json: {
            models: [{ name: "env-model", capabilities: ["embedding"] }],
          },
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
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("/v1/models"),
      ),
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
    // GAP-030: handler chains res.status(code).json(body) — mock must support it
    const res: Record<string, unknown> = { json };
    res.status = vi.fn(() => res);
    return { json, res: res as unknown as Response };
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
    expect(body.embedding.providers[0].note).toMatch(
      /probe error: probe exploded/,
    );
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

/**
 * OPS-002: the live defect was not "a slow provider" — it was a probe whose
 * await never settled (the cache is only written on settle, so the shared
 * in-flight promise was handed to EVERY later caller and /health stayed parked
 * until the process restarted). These tests pin the bound that makes that
 * impossible: the probe settles at its deadline, the in-flight slot is
 * released, a stuck probe is abandoned, and its late result can never
 * overwrite a newer answer.
 */
describe("OPS-002: a stuck probe can never poison later callers", () => {
  const healthy: EmbeddingHealthResult = {
    provider: "lmstudio",
    model: "text-embedding-qwen3-embedding-0.6b",
    healthy: true,
    providers: [{ id: "lmstudio", healthy: true, note: "ok" }],
  };

  it("settles AT the deadline with a degraded, named result when the probe never settles", async () => {
    vi.useFakeTimers();
    const pending = getEmbeddingHealth(() => new Promise<never>(() => {}));

    await vi.advanceTimersByTimeAsync(EMBEDDING_HEALTH_DEADLINE_MS + 1);
    const result = await pending;

    expect(result.healthy).toBe(false);
    expect(result.providers[0].id).toBe("deadline");
    expect(result.providers[0].note).toContain(
      `${EMBEDDING_HEALTH_DEADLINE_MS}ms deadline`,
    );
  });

  it("releases the in-flight slot: the degraded answer is cached for the TTL, then a NEW probe runs", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const stuck = () => {
      calls += 1;
      return new Promise<never>(() => {});
    };

    const first = getEmbeddingHealth(stuck);
    await vi.advanceTimersByTimeAsync(EMBEDDING_HEALTH_DEADLINE_MS + 1);
    expect((await first).healthy).toBe(false);
    expect(calls).toBe(1);

    // Within the TTL the degraded answer is served from the cache: no new
    // probe attempt (monitor polling must not re-wait the deadline per poll).
    const cachedCall = await getEmbeddingHealth(stuck);
    expect(cachedCall.healthy).toBe(false);
    expect(calls).toBe(1);

    // Past the TTL a FRESH probe runs — the stuck one was abandoned, not
    // handed to later callers (this is the live OPS-002 failure).
    await vi.advanceTimersByTimeAsync(EMBEDDING_HEALTH_TTL_MS + 1);
    const recovered = await getEmbeddingHealth(async () => healthy);
    expect(recovered.healthy).toBe(true);
    expect(recovered.provider).toBe("lmstudio");
  });

  it("a late result from an abandoned probe cannot overwrite a newer answer", async () => {
    vi.useFakeTimers();
    let resolveStuck!: (value: EmbeddingHealthResult) => void;
    const slow = new Promise<EmbeddingHealthResult>((resolve) => {
      resolveStuck = resolve;
    });

    const abandoned = getEmbeddingHealth(() => slow);
    await vi.advanceTimersByTimeAsync(EMBEDDING_HEALTH_DEADLINE_MS + 1);
    expect((await abandoned).healthy).toBe(false);

    await vi.advanceTimersByTimeAsync(EMBEDDING_HEALTH_TTL_MS + 1);
    const fresh = await getEmbeddingHealth(async () => healthy);
    expect(fresh).toBe(healthy);

    // The abandoned probe finally settles with a DIFFERENT answer — it must
    // not replace the newer cached one.
    resolveStuck({
      provider: "stale",
      model: "stale",
      healthy: true,
      providers: [{ id: "stale", healthy: true, note: "ok" }],
    });
    await vi.advanceTimersByTimeAsync(1);

    const served = await getEmbeddingHealth(async () => {
      throw new Error("must not re-probe — the cache must still be warm");
    });
    expect(served).toBe(fresh);
    expect(served.provider).toBe("lmstudio");
  });

  it("resetEmbeddingHealthCache() releases a stuck in-flight probe", async () => {
    vi.useFakeTimers();
    getEmbeddingHealth(() => new Promise<never>(() => {})); // parked in flight

    resetEmbeddingHealthCache();
    const result = await getEmbeddingHealth(async () => healthy);

    expect(result.healthy).toBe(true);
  });
});

/**
 * OPS-004: the live daemon reported `embedding.healthy=false` while `?q=`
 * queries still returned HTTP 200, and the probe evidence was contradictory —
 * `/models` answered 200 with the deployment's own key while a manual
 * `/embeddings` call answered 401. Two things had to become non-negotiable:
 *
 *  1. a /health note must NAME THE CLASS (auth-not-presented vs auth-rejected
 *     vs an expired health-probe budget) instead of relaying provider prose
 *     that says neither which budget expired nor that the key never arrived;
 *  2. a preflight must distinguish "/models is 200" from "/embeddings is
 *     usable" and FAIL CLOSED on the asymmetric state — without ever emitting
 *     the credential.
 *
 * The error signatures pinned here were verified against the live provider
 * (OpenRouter, 2026-09-12): empty/scheme-less Authorization → "Missing
 * Authentication header"; absent header → "No cookie auth credentials found";
 * unknown key → "User not found.". The point of the distinction is that the
 * first two can NEVER mean "the key lacks embeddings scope" — they mean the
 * credential did not arrive at all, which is what made OPS-004 expensive.
 */
describe("OPS-004: classified embedding failures and the secret-safe preflight", () => {
  // Deliberately NOT key-shaped: a credential-looking literal in a test file
  // trips secret scanners and alarms readers. It only has to be long enough
  // for redactSecrets (>=8 chars) and echoed back by a provider body.
  const CANARY = "test-credential-canary-0123456789abcdef";
  const DIMS = 4096;

  function setRemoteEnv(): void {
    process.env.DUCKBRAIN_EMBEDDING_PROVIDER = "openai";
    process.env.DUCKBRAIN_EMBEDDING_MODEL = "qwen/qwen3-embedding-8b";
    process.env.DUCKBRAIN_EMBEDDING_BASE_URL = "https://openrouter.ai/api/v1";
    process.env.DUCKBRAIN_EMBEDDING_API_KEY = CANARY;
    process.env.DUCKBRAIN_EMBEDDING_DIMENSIONS = String(DIMS);
  }

  /** The live asymmetric condition: /models 200, /embeddings 401. */
  function asymmetricFetch(body: string) {
    return vi.fn(async (url: string) => {
      if (url.includes("/embeddings"))
        return httpResponse({ status: 401, text: body });
      return httpResponse({ json: { data: [] } });
    });
  }

  function embeddingOf(length: number): number[] {
    return new Array(length).fill(0.125);
  }

  it("maps the live provider's auth signatures to distinct classes", () => {
    const classes = (message: string) =>
      classifyEmbedFailure(new Error(`[openai/m] embed HTTP 401: ${message}`))
        .class;
    expect(classes('{"message":"Missing Authentication header"}')).toBe(
      "credential_not_presented",
    );
    expect(classes('{"message":"No cookie auth credentials found"}')).toBe(
      "credential_not_presented",
    );
    expect(classes('{"message":"User not found."}')).toBe(
      "credential_rejected",
    );
    // Non-auth classes stay distinct so an operator can act on the right one.
    expect(
      classifyEmbedFailure(new Error("[openai/m] embed HTTP 429: slow down"))
        .class,
    ).toBe("rate_limited");
    expect(
      classifyEmbedFailure(new Error("[openai/m] embed HTTP 503: nope")).class,
    ).toBe("upstream_error");
    expect(
      classifyEmbedFailure(new Error("[openai/m] embed HTTP 404: no route"))
        .class,
    ).toBe("route_or_model_missing");
    expect(
      classifyEmbedFailure(new Error("[openai/m] embed HTTP 400: bad input"))
        .class,
    ).toBe("http_error");
    expect(
      classifyEmbedFailure(
        new Error("[openai/m] no embedding vector in response"),
      ).class,
    ).toBe("empty_vector");
    expect(classifyEmbedFailure(new TypeError("fetch failed")).class).toBe(
      "unreachable",
    );
  });

  it("classifies an expired AbortSignal.timeout as a timeout", () => {
    // The exact shape Node throws — and the exact note text the live daemon
    // reported during the incident.
    const abort = Object.assign(
      new Error("The operation was aborted due to timeout"),
      { name: "TimeoutError" },
    );
    expect(classifyEmbedFailure(abort).class).toBe("timeout");
  });

  it("redacts the credential even when the provider echoes it back", () => {
    expect(redactSecrets(`Bearer ${CANARY}`, [CANARY])).toBe(
      "Bearer <redacted>",
    );
    const failure = classifyEmbedFailure(
      new Error(`[openai/m] embed HTTP 401: user not found (key ${CANARY})`),
      [CANARY],
    );
    expect(failure.detail).not.toContain(CANARY);
    expect(failure.detail).toContain("<redacted>");
  });

  it("names the auth class in the /health note when the credential never arrives", async () => {
    setRemoteEnv();
    vi.stubGlobal(
      "fetch",
      asymmetricFetch('{"error":{"message":"Missing Authentication header"}}'),
    );

    const result = await probeEmbeddingHealth();

    expect(result.healthy).toBe(false);
    expect(result.providers[0].id).toBe("openai");
    const note = result.providers[0].note;
    expect(note).toContain("auth: credential not presented");
    // The provider's own words survive (grep-able), the ambiguity does not.
    expect(note).toContain("Missing Authentication header");
    expect(note).toContain("NOT a key-scope or route failure");
  });

  it("names the health-probe budget in the /health note when the probe times out", async () => {
    setRemoteEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Object.assign(
          new Error("The operation was aborted due to timeout"),
          { name: "TimeoutError" },
        );
      }),
    );

    const result = await probeEmbeddingHealth();

    expect(result.healthy).toBe(false);
    const note = result.providers[0].note;
    // OPS-004: the live note was the bare abort message, which named neither
    // the budget that expired nor the fact that the provider may still work.
    expect(note).toContain("3000ms health budget");
    expect(note).toContain("NOT DUCKBRAIN_EMBEDDING_TIMEOUT_MS");
  });

  it("fails closed on the OPS-004 asymmetric condition (/models 200, /embeddings 401)", async () => {
    setRemoteEnv();
    vi.stubGlobal(
      "fetch",
      asymmetricFetch('{"error":{"message":"Missing Authentication header"}}'),
    );

    const report = await preflightEmbedding();

    expect(report.ok).toBe(false);
    expect(report.asymmetric).toBe(true);
    const reachability = report.checks.find((c) => c.id === "reachability")!;
    const usability = report.checks.find((c) => c.id === "usability")!;
    expect(reachability.verdict).toBe("pass");
    expect(reachability.status).toBe(200);
    expect(usability.verdict).toBe("fail");
    expect(usability.status).toBe(401);
    expect(usability.failure_class).toBe("credential_not_presented");
    expect(report.summary).toContain("FAIL (closed)");
    // Usability was never proven, so dimensions/time are not judged.
    expect(report.checks.find((c) => c.id === "dimensions")!.verdict).toBe(
      "skip",
    );
  });

  it("never emits the credential in the report, even when the provider echoes it", async () => {
    setRemoteEnv();
    vi.stubGlobal(
      "fetch",
      asymmetricFetch(`{"error":"user not found (key ${CANARY})"}`),
    );

    const report = await preflightEmbedding();
    const serialized = JSON.stringify(report);

    expect(report.ok).toBe(false);
    expect(serialized).not.toContain(CANARY);
    // Presence is reported as a boolean, never as the value.
    expect(report.key_present).toBe(true);
    expect(serialized).toContain("<redacted>");
  });

  it("passes when a real embed works and the declared dimensions match", async () => {
    setRemoteEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/embeddings"))
          return httpResponse({
            json: { data: [{ embedding: embeddingOf(DIMS) }] },
          });
        return httpResponse({ json: { data: [] } });
      }),
    );

    const report = await preflightEmbedding();

    expect(report.ok).toBe(true);
    expect(report.asymmetric).toBe(false);
    expect(report.endpoint).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(report.checks.find((c) => c.id === "usability")!.vector_len).toBe(
      DIMS,
    );
    expect(report.checks.find((c) => c.id === "dimensions")!.verdict).toBe(
      "pass",
    );
    expect(report.checks.find((c) => c.id === "health_budget")!.verdict).toBe(
      "pass",
    );
    expect(report.summary).toContain("PASS");
  });

  it("warns (does not fail) on a dimension mismatch that is only a schema default", async () => {
    // Documented metadata-only case (docs/guide/embeddings.md): the local
    // alias emits 1024 dims against the schema default 384. Failing closed
    // here would break the documented local deployment.
    delete process.env.DUCKBRAIN_EMBEDDING_DIMENSIONS;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/embeddings"))
          return httpResponse({
            json: { data: [{ embedding: embeddingOf(1024) }] },
          });
        return httpResponse({ json: { data: [] } });
      }),
    );

    const report = await preflightEmbedding({
      config: { provider: "lmstudio" },
    });

    const dims = report.checks.find((c) => c.id === "dimensions")!;
    expect(dims.verdict).toBe("warn");
    expect(report.ok).toBe(true);
    expect(report.summary).toContain("with warnings");
  });

  it("fails closed on wrong dimensions when the operator declares them", async () => {
    setRemoteEnv(); // declares 4096
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/embeddings"))
          return httpResponse({
            json: { data: [{ embedding: embeddingOf(1024) }] },
          });
        return httpResponse({ json: { data: [] } });
      }),
    );

    const report = await preflightEmbedding();

    const dims = report.checks.find((c) => c.id === "dimensions")!;
    expect(dims.verdict).toBe("fail");
    expect(report.ok).toBe(false);
    expect(dims.note).toContain("4096");
    expect(dims.note).toContain("1024");
  });

  it("flags an embed slower than the /health probe budget (the false-degraded class)", async () => {
    setRemoteEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/embeddings"))
          return httpResponse({
            json: { data: [{ embedding: embeddingOf(DIMS) }] },
          });
        return httpResponse({ json: { data: [] } });
      }),
    );
    // Deterministically make the measured embed latency exceed the 3s health
    // budget without sleeping: every Date.now() call advances 4s.
    const base = Date.now();
    let calls = 0;
    vi.spyOn(Date, "now").mockImplementation(() => base + 4_000 * calls++);

    const report = await preflightEmbedding();

    const budget = report.checks.find((c) => c.id === "health_budget")!;
    expect(budget.verdict).toBe("warn");
    // Usable, so the preflight still passes — but the flap is named.
    expect(report.ok).toBe(true);
    expect(budget.note).toContain("3000ms /health embed-probe budget");
    expect(budget.note).toContain("intermittently");
    vi.restoreAllMocks();
  });

  it("fails closed when the endpoint is unreachable", async () => {
    setRemoteEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    const report = await preflightEmbedding();

    expect(report.ok).toBe(false);
    expect(
      report.checks.find((c) => c.id === "reachability")!.failure_class,
    ).toBe("unreachable");
    expect(report.checks.find((c) => c.id === "usability")!.verdict).toBe(
      "fail",
    );
  });

  it("maps the report to CLI exit codes (0 pass, 1 fail closed, 2 usage)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await runEmbeddingPreflightCli(["--nope"])).toBe(2);
    expect(await runEmbeddingPreflightCli(["--help"])).toBe(0);
    expect(await runEmbeddingPreflightCli(["--timeout-ms=0"])).toBe(2);

    setRemoteEnv();
    vi.stubGlobal(
      "fetch",
      asymmetricFetch('{"error":{"message":"Missing Authentication header"}}'),
    );
    expect(await runEmbeddingPreflightCli(["--json"])).toBe(1);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/embeddings"))
          return httpResponse({
            json: { data: [{ embedding: embeddingOf(DIMS) }] },
          });
        return httpResponse({ json: { data: [] } });
      }),
    );
    expect(await runEmbeddingPreflightCli([])).toBe(0);

    log.mockRestore();
    error.mockRestore();
  });

  describe("provider=auto (the documented no-argument default)", () => {
    /**
     * The runtime contract (createAutoProviders / probeEmbeddingHealth):
     * "auto" probes the registry in priority order lmstudio → ollama →
     * openai, skips a reachable-but-unusable candidate, and selects the
     * first provider whose REAL embed succeeds. The preflight must prove
     * the same thing — the first OPS-004 cut treated "auto" as a concrete
     * provider id, so the documented no-argument command failed closed as
     * "unknown embedding provider 'auto'".
     *
     * lmstudio: reachable (/v1/models 200) but UNUSABLE (embed 500);
     * ollama: reachable AND usable; openai would need a key (none set).
     */
    function autoSkipFetch() {
      return vi.fn(async (url: string) => {
        if (url.includes("localhost:1234/v1/models"))
          return httpResponse({ json: { data: [] } });
        if (url.includes("localhost:1234/v1/embeddings"))
          return httpResponse({ status: 500, text: "model not loaded" });
        if (url.includes("localhost:11434/api/tags"))
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
        if (url.includes("localhost:11434/api/embeddings"))
          return httpResponse({ json: { embedding: [0.1, 0.2, 0.3] } });
        return httpResponse({ status: 404 });
      });
    }

    it("resolves provider=auto in priority order and selects the first USABLE provider", async () => {
      const fetchMock = autoSkipFetch();
      vi.stubGlobal("fetch", fetchMock);

      // Env beats the config FILE: an earlier test writes an explicit
      // lmstudio provider into the redirected temp config (line ~290), so
      // pin "auto" explicitly — it is exactly the contract under test.
      process.env.DUCKBRAIN_EMBEDDING_PROVIDER = "auto";
      const report = await preflightEmbedding();

      expect(report.ok).toBe(true);
      // The CONCRETE winner is reported — never the pseudo-id "auto".
      expect(report.provider).toBe("ollama");
      expect(report.endpoint).toBe("http://localhost:11434/api/embeddings");
      // Priority order was honoured: lmstudio's embed was tried BEFORE
      // ollama's, and auto CONTINUED past it although it was reachable.
      const calls = fetchMock.mock.calls.map(([url]) => String(url));
      const lmstudioEmbed = calls.findIndex((u) =>
        u.includes("localhost:1234/v1/embeddings"),
      );
      const ollamaEmbed = calls.findIndex((u) =>
        u.includes("localhost:11434/api/embeddings"),
      );
      expect(lmstudioEmbed).toBeGreaterThanOrEqual(0);
      expect(ollamaEmbed).toBeGreaterThan(lmstudioEmbed);
      // The skipped candidate's failure is recorded and classified — proof
      // the skip was usability-driven, not reachability-driven.
      const lmstudio = report.checks.filter((c) => c.provider === "lmstudio");
      expect(lmstudio.find((c) => c.id === "reachability")!.verdict).toBe(
        "pass",
      );
      const lmstudioUsability = lmstudio.find((c) => c.id === "usability")!;
      expect(lmstudioUsability.verdict).toBe("fail");
      expect(lmstudioUsability.failure_class).toBe("upstream_error");
      // A later candidate won, so openai was never probed at all.
      expect(calls.some((u) => u.includes("api.openai.com"))).toBe(false);
      expect(report.summary).toContain("PASS");
      expect(report.summary).toContain("ollama");
    });

    it("selects lmstudio first when the first candidate's real embed works", async () => {
      const fetchMock = healthyFetch();
      vi.stubGlobal("fetch", fetchMock);

      const report = await preflightEmbedding(); // default = auto

      expect(report.ok).toBe(true);
      expect(report.provider).toBe("lmstudio");
      expect(report.endpoint).toBe("http://localhost:1234/v1/embeddings");
      // The first usable candidate wins: no later provider was embedded.
      const calls = fetchMock.mock.calls.map(([url]) => String(url));
      expect(
        calls.some((u) => u.includes("localhost:11434/api/embeddings")),
      ).toBe(false);
      expect(calls.some((u) => u.includes("api.openai.com"))).toBe(false);
    });

    it("never calls the embeddings route of a candidate whose cheap gate answered non-2xx (would-succeed-if-called trap)", async () => {
      // lmstudio's gate route 503s (server mid-boot), but its embeddings
      // route is a TRAP: it answers a perfect vector. The runtime auto path
      // (createAutoProviders) excludes lmstudio at its isHealthy gate, so the
      // preflight must NEVER call that route — a passing embed here would
      // "prove" a provider the runtime would never use.
      const fetchMock = vi.fn(async (url: string) => {
        if (url.includes("localhost:1234/v1/models"))
          return httpResponse({ status: 503, text: "server booting" });
        if (url.includes("localhost:1234/v1/embeddings"))
          return httpResponse({ json: { data: [{ embedding: [9, 9, 9] }] } });
        if (url.includes("localhost:11434/api/tags"))
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
        if (url.includes("localhost:11434/api/embeddings"))
          return httpResponse({ json: { embedding: [0.1, 0.2, 0.3] } });
        return httpResponse({ status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);

      process.env.DUCKBRAIN_EMBEDDING_PROVIDER = "auto";
      const report = await preflightEmbedding();

      expect(report.ok).toBe(true);
      expect(report.provider).toBe("ollama");
      const calls = fetchMock.mock.calls.map(([u]) => String(u));
      // THE TRAP: lmstudio's embeddings route was NEVER called…
      expect(
        calls.some((u) => u.includes("localhost:1234/v1/embeddings")),
      ).toBe(false);
      // …even though its gate route WAS probed (the failure is recorded).
      expect(calls.some((u) => u.includes("localhost:1234/v1/models"))).toBe(
        true,
      );
      const lmstudio = report.checks.filter((c) => c.provider === "lmstudio");
      expect(lmstudio.find((c) => c.id === "reachability")!.verdict).toBe(
        "fail",
      );
      const skipped = lmstudio.find((c) => c.id === "usability")!;
      expect(skipped.verdict).toBe("skip");
      expect(skipped.vector_len).toBeNull();
      expect(skipped.note).toContain("ever calling its embeddings route");
    });

    it("never calls the embeddings route of a candidate whose cheap gate threw (transport trap)", async () => {
      // Same contract, transport-failure flavour: the gate route refuses the
      // connection, the embeddings route would succeed if called.
      const fetchMock = vi.fn(async (url: string) => {
        if (url.includes("localhost:1234")) throw new TypeError("fetch failed");
        if (url.includes("localhost:11434/api/tags"))
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
        if (url.includes("localhost:11434/api/embeddings"))
          return httpResponse({ json: { embedding: [0.1, 0.2, 0.3] } });
        return httpResponse({ status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);

      process.env.DUCKBRAIN_EMBEDDING_PROVIDER = "auto";
      const report = await preflightEmbedding();

      expect(report.ok).toBe(true);
      expect(report.provider).toBe("ollama");
      const calls = fetchMock.mock.calls.map(([u]) => String(u));
      expect(
        calls.some((u) => u.includes("localhost:1234/v1/embeddings")),
      ).toBe(false);
      const lmstudio = report.checks.filter((c) => c.provider === "lmstudio");
      expect(lmstudio.find((c) => c.id === "reachability")!.verdict).toBe(
        "fail",
      );
      expect(lmstudio.find((c) => c.id === "usability")!.verdict).toBe("skip");
    });

    it("a winner that embeds but fails a declared-dimensions contract does NOT report 'none proved usable'", async () => {
      // Summary/verdict consistency: a real embed SUCCEEDED, so ok=false must
      // come with a summary that names the failing check — never the
      // no-winner wording.
      const fetchMock = healthyFetch(); // lmstudio embeds a 3-dim vector
      vi.stubGlobal("fetch", fetchMock);

      process.env.DUCKBRAIN_EMBEDDING_PROVIDER = "auto";
      process.env.DUCKBRAIN_EMBEDDING_DIMENSIONS = "4096"; // strict contract
      const report = await preflightEmbedding();

      expect(report.ok).toBe(false);
      expect(report.provider).toBe("lmstudio"); // the real embed DID succeed
      expect(report.checks.find((c) => c.id === "usability")!.verdict).toBe(
        "pass",
      );
      expect(report.checks.find((c) => c.id === "dimensions")!.verdict).toBe(
        "fail",
      );
      expect(report.summary).toContain("FAIL (closed)");
      expect(report.summary).not.toContain("none proved usable");
      expect(report.summary).not.toContain("no runtime-eligible candidate");
      expect(report.summary).toContain("dimensions");
    });

    it("auto fails closed ONLY when no candidate proves usability", async () => {
      const fetchMock = vi.fn(async (url: string) => {
        if (url.includes("localhost:1234/v1/models"))
          return httpResponse({ json: { data: [] } });
        if (url.includes("localhost:1234/v1/embeddings"))
          return httpResponse({ status: 500, text: "model not loaded" });
        // ollama's cheap gate FAILS (non-2xx): the runtime auto path excludes
        // it at isHealthy, so its embeddings route must never be called.
        if (url.includes("localhost:11434/api/tags"))
          return httpResponse({ status: 503, text: "ollama down" });
        if (url.includes("localhost:11434/api/embeddings"))
          return httpResponse({ status: 404, text: "model not found" });
        // Reachability is not usability: openai's /models is a PUBLIC route,
        // so it answers 200 while the embed still 401s without a key.
        if (url.includes("api.openai.com/v1/models"))
          return httpResponse({ json: { data: [] } });
        if (url.includes("api.openai.com/v1/embeddings"))
          return httpResponse({
            status: 401,
            text: '{"message":"Missing Authentication header"}',
          });
        return httpResponse({ status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);

      process.env.DUCKBRAIN_EMBEDDING_PROVIDER = "auto";
      const report = await preflightEmbedding();

      expect(report.ok).toBe(false);
      // No winner: the report keeps the pseudo-id so the operator can tell
      // "auto found nothing" from a concrete provider failure.
      expect(report.provider).toBe("auto");
      expect(report.summary).toContain("FAIL (closed)");
      // lmstudio was reachable but unusable — the asymmetric condition.
      expect(report.asymmetric).toBe(true);
      // EVERY candidate was evaluated in priority order; gate-passing
      // failures are classified embed attempts, while a candidate that
      // failed the cheap gate records an honest SKIP — never an embed
      // request the runtime would not have made either.
      const unusable = report.checks.filter((c) => c.id === "usability");
      expect(unusable.map((c) => c.provider)).toEqual([
        "lmstudio",
        "ollama",
        "openai",
      ]);
      expect(unusable.find((c) => c.provider === "lmstudio")!.verdict).toBe(
        "fail",
      );
      expect(unusable.find((c) => c.provider === "ollama")!.verdict).toBe(
        "skip",
      );
      expect(unusable.find((c) => c.provider === "openai")!.verdict).toBe(
        "fail",
      );
      expect(unusable.find((c) => c.provider === "openai")!.failure_class).toBe(
        "credential_not_presented",
      );
      const calls = fetchMock.mock.calls.map(([u]) => String(u));
      expect(
        calls.some((u) => u.includes("localhost:11434/api/embeddings")),
      ).toBe(false);

      // The CLI maps the all-unusable auto verdict to exit 1 (fail closed).
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(await runEmbeddingPreflightCli(["--json"])).toBe(1);
      } finally {
        log.mockRestore();
      }
    });

    it("keeps an EXPLICIT provider a hard requirement — no auto fallback", async () => {
      // lmstudio is fully healthy, but the explicit choice is ollama and
      // ollama cannot embed: fail closed WITHOUT ever touching lmstudio.
      const fetchMock = vi.fn(async (url: string) => {
        if (url.includes("localhost:1234/v1/models"))
          return httpResponse({ json: { data: [] } });
        if (url.includes("localhost:1234/v1/embeddings"))
          return httpResponse({ json: { data: [{ embedding: [0.1, 0.2] }] } });
        if (url.includes("localhost:11434/api/tags"))
          return httpResponse({ json: { models: [] } });
        if (url.includes("localhost:11434/api/embeddings"))
          return httpResponse({ status: 404, text: "model not found" });
        return httpResponse({ status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const report = await preflightEmbedding({
        config: { provider: "ollama" },
      });

      expect(report.ok).toBe(false);
      expect(report.provider).toBe("ollama");
      expect(report.summary).toContain("FAIL (closed)");
      const urls = fetchMock.mock.calls.map(([u]) => String(u));
      expect(urls.some((u) => u.includes("localhost:1234"))).toBe(false);
    });
  });
});
