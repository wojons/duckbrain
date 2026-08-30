/**
 * DOGFOOD-002 / GAP-029 Regression Tests: embedding provider fallback +
 * usability probes + parallel cheap-gate probing with a short-TTL cache.
 *
 * Regressions guarded:
 *  - a 200-with-empty-vector embed response is a FAILED embed (Ollama returns
 *    {"embedding":[]} for models that cannot serve embeddings) — must throw so
 *    the caller's fallback loop moves on, never return [] as a query vector
 *  - createAutoProviders() returns ALL healthy providers in priority order
 *    (lmstudio → ollama → openai) so recall can fall back at embed time
 *  - explicit provider config = single provider, no probing, no fallback
 *  - ollama probe checks the configured model's embedding capability (cheap
 *    usability signal from /api/tags) without an embed probe
 *  - GAP-029: the auto branch probes all providers in PARALLEL (all-dead
 *    worst case = one 1.5s gate timeout, not the ~3s sequential sum) and
 *    caches cheap-gate results for AUTO_PROBE_TTL_MS — consecutive calls
 *    make ZERO extra fetches; priority order survives out-of-order probe
 *    resolution; resetAutoProvidersCache() forces a re-probe
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AUTO_PROBE_TTL_MS,
  createProvider,
  createAutoProvider,
  createAutoProviders,
  resetAutoProvidersCache,
} from "./providers";

const OLD_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.DUCKBRAIN_EMBEDDING_PROVIDER;
  delete process.env.DUCKBRAIN_EMBEDDING_MODEL;
  delete process.env.DUCKBRAIN_EMBEDDING_BASE_URL;
  delete process.env.DUCKBRAIN_EMBEDDING_API_KEY;
  // GAP-029: several tests here share an identical resolved config (env
  // provider=auto, default model) — without this reset, the first test's
  // cached provider instances (built against ITS stubbed fetch) would leak
  // into later tests and hit the real network after vi.unstubAllGlobals.
  resetAutoProvidersCache();
});

afterEach(() => {
  process.env = { ...OLD_ENV };
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body };
}

/** Fully-healthy auto-path fetch router (lmstudio + ollama pass their gates). */
function healthyAutoFetch() {
  return vi.fn(async (url: string) => {
    if (url.includes("/v1/models")) return jsonResponse({ data: [] });
    if (url.includes("/api/tags"))
      return jsonResponse({
        models: [
          {
            name: "text-embedding-qwen3-embedding-0.6b",
            capabilities: ["embedding"],
          },
        ],
      });
    return { ok: false };
  });
}

describe("makeHttpEmbed empty-vector rejection (DOGFOOD-002)", () => {
  it("rejects a 200 with top-level embedding: [] (Ollama usability gap)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ embedding: [] })),
    );
    const p = createProvider({
      provider: "ollama",
      model: "nomic",
      baseUrl: "http://ollama.test",
    });
    await expect(p.embed("ping")).rejects.toThrow(/no embedding vector/);
  });

  it("rejects a 200 with data[0].embedding: [] (OpenAI shape)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ data: [{ embedding: [] }] })),
    );
    const p = createProvider({
      provider: "ollama",
      model: "nomic",
      baseUrl: "http://ollama.test",
    });
    await expect(p.embed("ping")).rejects.toThrow(/no embedding vector/);
  });

  it("rejects a 200 with no embedding field at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ model: "nomic" })),
    );
    const p = createProvider({
      provider: "ollama",
      model: "nomic",
      baseUrl: "http://ollama.test",
    });
    await expect(p.embed("ping")).rejects.toThrow(/no embedding vector/);
  });

  it("accepts a real non-empty vector", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ embedding: [0.1, 0.2, 0.3] })),
    );
    const p = createProvider({
      provider: "ollama",
      model: "nomic",
      baseUrl: "http://ollama.test",
    });
    await expect(p.embed("ping")).resolves.toEqual([0.1, 0.2, 0.3]);
  });
});

describe("createAutoProviders (DOGFOOD-002)", () => {
  // The auto path only engages when provider resolves to "auto" — the config
  // file default. resolveEmbeddingConfig() defaults to "lmstudio" when no env
  // is set, so these tests pin DUCKBRAIN_EMBEDDING_PROVIDER=auto explicitly.
  beforeEach(() => {
    process.env.DUCKBRAIN_EMBEDDING_PROVIDER = "auto";
  });

  it("returns ALL healthy providers in priority order", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/v1/models")) return jsonResponse({ data: [] });
        if (url.includes("/api/tags"))
          return jsonResponse({
            models: [
              {
                name: "text-embedding-qwen3-embedding-0.6b",
                capabilities: ["embedding"],
              },
            ],
          });
        return { ok: false };
      }),
    );
    const providers = await createAutoProviders();
    expect(providers.map((p) => p.id)).toEqual([
      "lmstudio/text-embedding-qwen3-embedding-0.6b",
      "ollama/text-embedding-qwen3-embedding-0.6b",
    ]);
  });

  it("createAutoProvider still returns the first healthy provider", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/v1/models")) return jsonResponse({ data: [] });
        if (url.includes("/api/tags"))
          return jsonResponse({
            models: [
              {
                name: "text-embedding-qwen3-embedding-0.6b",
                capabilities: ["embedding"],
              },
            ],
          });
        return { ok: false };
      }),
    );
    const provider = await createAutoProvider();
    expect(provider?.id).toBe("lmstudio/text-embedding-qwen3-embedding-0.6b");
  });

  it("explicit provider = single entry, no probing, no fallback", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const providers = await createAutoProviders({
      provider: "ollama",
      model: "nomic",
    });
    expect(providers).toHaveLength(1);
    expect(providers[0].id).toBe("ollama/nomic");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips ollama when the configured model lacks the embedding capability", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/v1/models")) return jsonResponse({ data: [] });
        if (url.includes("/api/tags"))
          return jsonResponse({
            models: [
              {
                name: "text-embedding-qwen3-embedding-0.6b",
                capabilities: ["completion"], // chat-only model
              },
            ],
          });
        return { ok: false };
      }),
    );
    const providers = await createAutoProviders();
    expect(providers.map((p) => p.id)).toEqual([
      "lmstudio/text-embedding-qwen3-embedding-0.6b",
    ]);
  });

  it("matches ollama model tags with a :tag suffix (nomic-embed-text:latest)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/v1/models")) return jsonResponse({ data: [] });
        if (url.includes("/api/tags"))
          return jsonResponse({
            models: [
              {
                name: "nomic-embed-text:latest",
                capabilities: ["embedding"],
              },
            ],
          });
        return { ok: false };
      }),
    );
    const providers = await createAutoProviders({
      model: "nomic-embed-text",
    });
    expect(providers.map((p) => p.id)).toEqual([
      "lmstudio/nomic-embed-text",
      "ollama/nomic-embed-text",
    ]);
  });

  it("treats an empty model list as reachability-only (no capability gate)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/v1/models")) return jsonResponse({ data: [] });
        if (url.includes("/api/tags")) return jsonResponse({ models: [] });
        return { ok: false };
      }),
    );
    const providers = await createAutoProviders();
    expect(providers.map((p) => p.id)).toEqual([
      "lmstudio/text-embedding-qwen3-embedding-0.6b",
      "ollama/text-embedding-qwen3-embedding-0.6b",
    ]);
  });

  it("returns [] when nothing is reachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const providers = await createAutoProviders();
    expect(providers).toEqual([]);
  });
});

describe("createAutoProviders parallel probing + short-TTL cache (GAP-029)", () => {
  beforeEach(() => {
    process.env.DUCKBRAIN_EMBEDDING_PROVIDER = "auto";
  });

  it("probes ALL providers in parallel — all-dead wall time < 2s (was ~3s sequential)", async () => {
    // A fetch that never resolves on its own and only rejects when the
    // caller's AbortSignal.timeout(1500) fires: every dead provider then
    // takes the full 1.5s gate timeout. Parallel = one timeout (~1.5s);
    // the old sequential loop would sum two of them (~3s) — this test
    // discriminates. ~1.5s real time is expected, not a flake.
    const abortOnly = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    vi.stubGlobal("fetch", abortOnly);

    const start = Date.now();
    const providers = await createAutoProviders();
    const elapsed = Date.now() - start;

    expect(providers).toEqual([]);
    expect(elapsed).toBeLessThan(2000);
  });

  it("reuses cached probe results within TTL — zero extra fetches, same instance", async () => {
    const fetchMock = healthyAutoFetch();
    vi.stubGlobal("fetch", fetchMock);

    const first = await createAutoProviders();
    const callsAfterFirst = fetchMock.mock.calls.length;
    expect(first.map((p) => p.id)).toEqual([
      "lmstudio/text-embedding-qwen3-embedding-0.6b",
      "ollama/text-embedding-qwen3-embedding-0.6b",
    ]);
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await createAutoProviders();

    // The cached array is shared and treated as immutable by callers.
    expect(second).toBe(first);
    expect(second.map((p) => p.id)).toEqual(first.map((p) => p.id));
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("re-probes after AUTO_PROBE_TTL_MS expiry", async () => {
    vi.useFakeTimers();
    const fetchMock = healthyAutoFetch();
    vi.stubGlobal("fetch", fetchMock);

    await createAutoProviders();
    const callsBeforeExpiry = fetchMock.mock.calls.length;
    expect(callsBeforeExpiry).toBeGreaterThan(0);

    vi.advanceTimersByTime(AUTO_PROBE_TTL_MS + 1);
    await createAutoProviders();

    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBeforeExpiry);
  });

  it("resetAutoProvidersCache() forces a re-probe", async () => {
    const fetchMock = healthyAutoFetch();
    vi.stubGlobal("fetch", fetchMock);

    await createAutoProviders();
    const callsBeforeReset = fetchMock.mock.calls.length;
    expect(callsBeforeReset).toBeGreaterThan(0);

    resetAutoProvidersCache();
    await createAutoProviders();

    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBeforeReset);
  });

  it("preserves priority order when probes resolve out of order", async () => {
    const resolvedOrder: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/v1/models")) {
          // lmstudio's gate is slow — ollama's /api/tags resolves first.
          await new Promise((r) => setTimeout(r, 50));
          resolvedOrder.push("lmstudio");
          return jsonResponse({ data: [] });
        }
        if (url.includes("/api/tags")) {
          resolvedOrder.push("ollama");
          return jsonResponse({
            models: [
              {
                name: "text-embedding-qwen3-embedding-0.6b",
                capabilities: ["embedding"],
              },
            ],
          });
        }
        return { ok: false };
      }),
    );

    const providers = await createAutoProviders();

    // Prove the probes really resolved out of order…
    expect(resolvedOrder).toEqual(["ollama", "lmstudio"]);
    // …yet the result is still registry priority order (lmstudio first).
    expect(providers.map((p) => p.id)).toEqual([
      "lmstudio/text-embedding-qwen3-embedding-0.6b",
      "ollama/text-embedding-qwen3-embedding-0.6b",
    ]);
  });

  it("serves consecutive all-dead results from the cache — zero re-probes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", fetchMock);

    const first = await createAutoProviders();
    expect(first).toEqual([]);
    const callsAfterFirst = fetchMock.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await createAutoProviders();

    expect(second).toBe(first); // cached empty array, shared instance
    expect(second).toEqual([]);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });
});
