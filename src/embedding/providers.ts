/**
 * Embedding Provider Registry
 *
 * Model-agnostic embedding providers. Different people can use different
 * embedding models — the cache is keyed by (modelId, contentHash), so each
 * model gets its own cache namespace and switching models never corrupts
 * existing vectors (it just means a cold-cache rebuild for the new model).
 *
 * Providers:
 *   - lmstudio: OpenAI-compatible API (default, http://localhost:1234/v1)
 *   - ollama:   Ollama native API (http://localhost:11434)
 *   - openai:   OpenAI embeddings API (needs DUCKBRAIN_EMBEDDING_API_KEY)
 *
 * Selection (highest priority first):
 *   1. Config `embedding.provider` / env `DUCKBRAIN_EMBEDDING_PROVIDER`
 *   2. First provider whose health check succeeds
 *   3. lmstudio fallback (matches historical behavior)
 */

export interface EmbeddingProvider {
  /** Stable identifier used as cache namespace key (e.g. "lmstudio/qwen3-0.6b") */
  readonly id: string;
  readonly model: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
}

export interface EmbeddingConfig {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  dimensions?: number;
  timeoutMs?: number;
}

interface ProviderCtor {
  id: string;
  label: string;
  build(
    cfg: Required<
      Pick<EmbeddingConfig, "baseUrl" | "model" | "timeoutMs" | "dimensions">
    > & { apiKey?: string },
  ): EmbeddingProvider;
  isHealthy(cfg: EmbeddingConfig): Promise<boolean>;
}

/** Normalize a base URL to not end with slash */
function normBase(base: string | undefined, fallback: string): string {
  const b = (base || fallback).trim();
  return b.endsWith("/") ? b.slice(0, -1) : b;
}

function makeHttpEmbed(
  id: string,
  model: string,
  dimensions: number,
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  timeoutMs: number,
): EmbeddingProvider {
  return {
    id,
    model,
    dimensions,
    async embed(text: string): Promise<number[]> {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ ...body, input: text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        throw new Error(
          `[${id}] embed HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
        );
      }
      const data = (await res.json()) as {
        data?: Array<{ embedding?: number[] }>;
        embedding?: number[];
      };
      const vec = data?.data?.[0]?.embedding ?? data?.embedding;
      if (!vec || !Array.isArray(vec)) {
        throw new Error(`[${id}] no embedding vector in response`);
      }
      return vec;
    },
  };
}

const PROVIDERS: ProviderCtor[] = [
  {
    id: "lmstudio",
    label: "LM Studio (OpenAI-compatible, local)",
    build(cfg) {
      const base = normBase(cfg.baseUrl, "http://localhost:1234/v1");
      return makeHttpEmbed(
        `lmstudio/${cfg.model}`,
        cfg.model,
        cfg.dimensions,
        `${base}/embeddings`,
        { model: cfg.model },
        {},
        cfg.timeoutMs,
      );
    },
    async isHealthy(cfg) {
      try {
        const base = normBase(cfg.baseUrl, "http://localhost:1234/v1");
        const res = await fetch(`${base}/models`, {
          signal: AbortSignal.timeout(1500),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    build(cfg) {
      const base = normBase(cfg.baseUrl, "http://localhost:11434");
      return makeHttpEmbed(
        `ollama/${cfg.model}`,
        cfg.model,
        cfg.dimensions,
        `${base}/api/embeddings`,
        { model: cfg.model },
        {},
        cfg.timeoutMs,
      );
    },
    async isHealthy(cfg) {
      try {
        const base = normBase(cfg.baseUrl, "http://localhost:11434");
        const res = await fetch(`${base}/api/tags`, {
          signal: AbortSignal.timeout(1500),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  },
  {
    id: "openai",
    label: "OpenAI API (remote)",
    build(cfg) {
      const base = normBase(cfg.baseUrl, "https://api.openai.com/v1");
      return makeHttpEmbed(
        `openai/${cfg.model}`,
        cfg.model,
        cfg.dimensions,
        `${base}/embeddings`,
        { model: cfg.model },
        { Authorization: `Bearer ${cfg.apiKey || ""}` },
        cfg.timeoutMs,
      );
    },
    async isHealthy(cfg) {
      return Boolean(cfg.apiKey);
    },
  },
];

/**
 * Resolve the effective embedding config from explicit overrides, env, and defaults.
 */
export function resolveEmbeddingConfig(
  partial: EmbeddingConfig = {},
): Required<EmbeddingConfig> {
  const env = process.env;
  return {
    provider:
      partial.provider ?? env.DUCKBRAIN_EMBEDDING_PROVIDER ?? "lmstudio",
    model:
      partial.model ??
      env.DUCKBRAIN_EMBEDDING_MODEL ??
      "text-embedding-qwen3-embedding-0.6b",
    baseUrl: partial.baseUrl ?? env.DUCKBRAIN_EMBEDDING_BASE_URL ?? "",
    apiKey: partial.apiKey ?? env.DUCKBRAIN_EMBEDDING_API_KEY ?? "",
    dimensions:
      partial.dimensions ??
      parseInt(env.DUCKBRAIN_EMBEDDING_DIMENSIONS ?? "384", 10),
    timeoutMs:
      partial.timeoutMs ??
      parseInt(env.DUCKBRAIN_EMBEDDING_TIMEOUT_MS ?? "10000", 10),
  };
}

/**
 * Build a provider for the given config. Throws if the provider id is unknown.
 */
export function createProvider(cfg: EmbeddingConfig = {}): EmbeddingProvider {
  const resolved = resolveEmbeddingConfig(cfg);
  const ctor = PROVIDERS.find((p) => p.id === resolved.provider);
  if (!ctor) {
    throw new Error(
      `Unknown embedding provider '${resolved.provider}'. Known: ${PROVIDERS.map((p) => p.id).join(", ")}`,
    );
  }
  return ctor.build({
    baseUrl: resolved.baseUrl ?? "",
    model: resolved.model,
    dimensions: resolved.dimensions,
    timeoutMs: resolved.timeoutMs,
    apiKey: resolved.apiKey,
  });
}

/**
 * Try providers in order until one works. Used when no explicit provider is
 * configured — prefers whatever embedding server is actually reachable.
 *
 * @returns provider or null if none are reachable
 */
export async function createAutoProvider(
  cfg: EmbeddingConfig = {},
): Promise<EmbeddingProvider | null> {
  const resolved = resolveEmbeddingConfig(cfg);

  // Explicit provider → hard requirement
  if (resolved.provider && resolved.provider !== "auto") {
    return createProvider({ ...resolved, provider: resolved.provider });
  }

  // Auto: probe providers in priority order
  const ordered = [...PROVIDERS].sort((a, b) => {
    const pa = a.id === "lmstudio" ? 0 : a.id === "ollama" ? 1 : 2;
    const pb = b.id === "lmstudio" ? 0 : b.id === "ollama" ? 1 : 2;
    return pa - pb;
  });
  for (const ctor of ordered) {
    try {
      if (await ctor.isHealthy({ ...resolved, provider: ctor.id })) {
        return ctor.build({
          baseUrl: resolved.baseUrl ?? "",
          model: resolved.model,
          dimensions: resolved.dimensions,
          timeoutMs: resolved.timeoutMs,
          apiKey: resolved.apiKey,
        });
      }
    } catch {
      // probe failed — try next
    }
  }
  return null;
}

export function listProviders(): Array<{ id: string; label: string }> {
  return PROVIDERS.map((p) => ({ id: p.id, label: p.label }));
}
