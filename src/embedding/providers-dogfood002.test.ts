/**
 * DOGFOOD-002 Regression Tests: embedding provider fallback + usability probes.
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
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createProvider,
  createAutoProvider,
  createAutoProviders,
} from "./providers";

const OLD_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.DUCKBRAIN_EMBEDDING_PROVIDER;
  delete process.env.DUCKBRAIN_EMBEDDING_MODEL;
  delete process.env.DUCKBRAIN_EMBEDDING_BASE_URL;
  delete process.env.DUCKBRAIN_EMBEDDING_API_KEY;
});

afterEach(() => {
  process.env = { ...OLD_ENV };
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body };
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
