/**
 * OpenRouter upstream routing for embeddings (2026-11-03).
 *
 * Regressions guarded — the live daemon flapped between /health 200 and 503
 * because OpenRouter's default routing sometimes sent the 8s health-probe
 * embed to a slow Nebius upstream (measured 2.1-34.1s, vs DeepInfra
 * 0.9-1.6s and SiliconFlow 1.5-2.6s for the same request):
 *
 *  - DUCKBRAIN_EMBEDDING_PROVIDER_ORDER unset (the default) must leave the
 *    request body byte-identical: an unknown top-level `provider` key breaks
 *    non-OpenRouter OpenAI-compatible endpoints (OpenAI's API 400s on it), so
 *    the opt-in has to be strictly opt-in.
 *  - when set, BOTH the single-embed and batch-embed paths must carry
 *    provider.order with allow_fallbacks:true (availability beats
 *    preference — a dead preferred upstream must still be served).
 *  - whitespace and empty entries in the list are ignored, and a list that
 *    filters down to nothing behaves like unset.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createProvider } from "./providers";

const OLD_ENV = { ...process.env };

/** Capture the JSON body of every embeddings request the provider makes. */
function captureFetch(): { bodies: any[] } {
  const bodies: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      // Mirror the real API: one embedding per input (batch callers reject a
      // length mismatch as an invalid response).
      const count = Array.isArray(body.input) ? body.input.length : 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: Array.from({ length: count }, () => ({ embedding: [0.1, 0.2, 0.3] })),
        }),
        text: async () => "",
      } as unknown as Response;
    }),
  );
  return { bodies };
}

function openAiProvider() {
  process.env.DUCKBRAIN_EMBEDDING_PROVIDER = "openai";
  process.env.DUCKBRAIN_EMBEDDING_MODEL = "qwen/qwen3-embedding-8b";
  process.env.DUCKBRAIN_EMBEDDING_BASE_URL = "https://openrouter.ai/api/v1";
  process.env.DUCKBRAIN_EMBEDDING_API_KEY = "test-key";
  process.env.DUCKBRAIN_EMBEDDING_DIMENSIONS = "4096";
  return createProvider();
}

beforeEach(() => {
  process.env = { ...OLD_ENV };
  delete process.env.DUCKBRAIN_EMBEDDING_PROVIDER_ORDER;
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...OLD_ENV };
});

describe("embedding provider routing (OpenRouter upstream order)", () => {
  it("omits the provider key entirely when the order env is unset", async () => {
    const { bodies } = captureFetch();
    const provider = openAiProvider();

    await provider.embed("hello");
    await provider.embedMany!(["a", "b"]);

    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body).not.toHaveProperty("provider");
      expect(body.model).toBe("qwen/qwen3-embedding-8b");
    }
  });

  it("sends provider.order with fallbacks allowed on the single-embed path", async () => {
    process.env.DUCKBRAIN_EMBEDDING_PROVIDER_ORDER = "deepinfra,siliconflow";
    const { bodies } = captureFetch();
    const provider = openAiProvider();

    await provider.embed("hello");

    expect(bodies).toHaveLength(1);
    expect(bodies[0].provider).toEqual({
      order: ["deepinfra", "siliconflow"],
      allow_fallbacks: true,
    });
  });

  it("sends provider.order on the batch-embed path too", async () => {
    process.env.DUCKBRAIN_EMBEDDING_PROVIDER_ORDER = "deepinfra";
    const { bodies } = captureFetch();
    const provider = openAiProvider();

    await provider.embedMany!(["a", "b"]);

    expect(bodies).toHaveLength(1);
    expect(bodies[0].provider).toEqual({
      order: ["deepinfra"],
      allow_fallbacks: true,
    });
    // The routing must be added NEXT TO the real input, never replace it.
    expect(bodies[0].input).toEqual(["a", "b"]);
  });

  it("trims whitespace and drops empty entries", async () => {
    process.env.DUCKBRAIN_EMBEDDING_PROVIDER_ORDER = " deepinfra , ,siliconflow ,";
    const { bodies } = captureFetch();
    const provider = openAiProvider();

    await provider.embed("hello");

    expect(bodies[0].provider.order).toEqual(["deepinfra", "siliconflow"]);
  });

  it("treats a whitespace-only order as unset", async () => {
    process.env.DUCKBRAIN_EMBEDDING_PROVIDER_ORDER = "   ";
    const { bodies } = captureFetch();
    const provider = openAiProvider();

    await provider.embed("hello");

    expect(bodies[0]).not.toHaveProperty("provider");
  });

  it("leaves other providers (lmstudio) without a provider key", async () => {
    process.env.DUCKBRAIN_EMBEDDING_PROVIDER_ORDER = "deepinfra";
    process.env.DUCKBRAIN_EMBEDDING_PROVIDER = "lmstudio";
    process.env.DUCKBRAIN_EMBEDDING_BASE_URL = "http://localhost:1234/v1";
    process.env.DUCKBRAIN_EMBEDDING_API_KEY = "";
    const { bodies } = captureFetch();
    const provider = createProvider();

    await provider.embed("hello");

    expect(bodies[0]).not.toHaveProperty("provider");
  });
});
