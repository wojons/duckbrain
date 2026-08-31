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
 *   2. auto (default): probe providers in PARALLEL (cheap gates only — no
 *      embed probes on the recall path, DOGFOOD-002), use ALL healthy ones
 *      so callers can fall back at embed time; probe results are cached
 *      in-process for AUTO_PROBE_TTL_MS so consecutive recall/rebuild calls
 *      don't re-probe dead providers (GAP-029)
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

export interface ProviderCtor {
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
  /**
   * Body key carrying the text to embed. OpenAI-compatible endpoints
   * (/v1/embeddings) use "input"; Ollama's legacy /api/embeddings endpoint
   * uses "prompt" (GAP-029: an unknown "input" key is silently ignored and
   * the server answers 200 with {"embedding":[]}).
   */
  inputKey: string = "input",
): EmbeddingProvider {
  return {
    id,
    model,
    dimensions,
    async embed(text: string): Promise<number[]> {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ ...body, [inputKey]: text }),
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
      // DOGFOOD-002: `[]` is truthy in JS — a 200 with an EMPTY vector is a
      // failed embed (e.g. Ollama returns {"embedding":[]} for a model that
      // cannot serve embeddings), not a usable query vector. Throw so the
      // caller's provider-fallback loop moves on to the next provider.
      if (!Array.isArray(vec) || vec.length === 0) {
        throw new Error(`[${id}] no embedding vector in response`);
      }
      return vec;
    },
  };
}

/**
 * Provider registry in priority order (lmstudio → ollama → openai).
 * Exported for the DOGFOOD-020 health probe (src/embedding/health.ts), which
 * runs each provider's cheap isHealthy() gate and then a real embed probe via
 * the provider's own build() (makeHttpEmbed).
 */
export const PROVIDERS: readonly ProviderCtor[] = [
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
        if (!res.ok) return false;
        // DOGFOOD-002 (c): reachability is NOT usability — /v1/models answers
        // even when the embedding model is unloaded. We deliberately do NOT
        // require the configured model id to be listed here: LM Studio is
        // lenient about model ids (it serves any requested id once a model is
        // loaded, and the configured default text-embedding-qwen3-embedding-0.6b
        // is NOT in the live /v1/models list while embeds still work), so a
        // strict listing check would reject the working path. A tiny embed
        // usability probe is also rejected: it would force a model load
        // (seconds to minutes) on EVERY recall. Embed-time fallback (a) is the
        // primary defense; this probe stays reachability-only.
        return true;
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
        // GAP-029: Ollama's legacy /api/embeddings ignores an "input" key and
        // answers 200 with {"embedding":[]} (which makeHttpEmbed rejects).
        // The legacy endpoint's body key is "prompt".
        "prompt",
      );
    },
    async isHealthy(cfg) {
      try {
        const base = normBase(cfg.baseUrl, "http://localhost:11434");
        const res = await fetch(`${base}/api/tags`, {
          signal: AbortSignal.timeout(1500),
        });
        if (!res.ok) return false;
        // DOGFOOD-002 (c): cheap usability signal — /api/tags reports each
        // model's capabilities. If the configured model is listed WITHOUT the
        // "embedding" capability (e.g. a chat-only model), the embed call is
        // guaranteed to fail (Ollama returns 200 with {"embedding":[]}), so
        // skip this provider at probe time instead of at embed time. No embed
        // probe is performed — that would load the model on every recall.
        const data = (await res.json()) as {
          models?: Array<{ name?: string; capabilities?: string[] }>;
        };
        const models = data?.models ?? [];
        if (models.length === 0) return true; // no model list — reachability only
        const target = cfg.model;
        const listed = models.find(
          (m) => m.name === target || m.name?.startsWith(`${target}:`),
        );
        if (!listed) return true; // model not listed — let embed-time fallback decide
        return (listed.capabilities ?? []).includes("embedding");
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
      // DOGFOOD-002: default is "auto" (probe + fallback), matching the config
      // schema default (src/config/index.ts) and the documented behavior. The
      // previous "lmstudio" default made the daemon treat lmstudio as an
      // EXPLICIT provider — no probing, no fallback — so a reachable-but-broken
      // LM Studio silently killed semantic recall even when Ollama was healthy.
      partial.provider ?? env.DUCKBRAIN_EMBEDDING_PROVIDER ?? "auto",
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
  const providers = await createAutoProviders(cfg);
  return providers[0] ?? null;
}

/**
 * Short TTL for cached auto-probe results (GAP-029).
 *
 * Cheap-gate probe results are cached in-process so consecutive recall /
 * rebuild calls don't re-probe dead providers (the all-dead cold path drops
 * from ~3s of sequential 1.5s gate timeouts to ~1.5s once, then instant).
 * 5s is deliberately short: a provider that boots is picked up within
 * seconds without a restart.
 */
export const AUTO_PROBE_TTL_MS = 5_000;

/** Module-level cache for the auto branch. Key = JSON.stringify(resolved). */
let autoProbeCache: {
  key: string;
  at: number;
  providers: EmbeddingProvider[];
} | null = null;

/** Clear the auto-probe cache (tests, config reloads). */
export function resetAutoProvidersCache(): void {
  autoProbeCache = null;
}

/**
 * Resolve ALL healthy auto providers in priority order (DOGFOOD-002).
 *
 * Reachability is not usability: LM Studio's /v1/models answers even when the
 * embedding model is unloaded, so the first healthy provider may still fail at
 * embed time. Callers that can fall back (semantic recall) should iterate this
 * list — try provider.embed(); on failure try the next; only when ALL fail
 * surface the error. Explicit provider config (DUCKBRAIN_EMBEDDING_PROVIDER
 * or config embedding.provider != "auto") is a HARD requirement: a single
 * provider, no fallback.
 *
 * The auto branch probes every provider's cheap isHealthy() gate in PARALLEL
 * (GAP-029) — never an embed probe (DOGFOOD-002: that would force model loads
 * on every query) — so the all-dead worst case is ONE gate timeout (~1.5s)
 * instead of the sequential sum (~3s). Healthy providers are collected by
 * registry index, so priority order (lmstudio → ollama → openai) is preserved
 * regardless of resolution order. Results are cached for AUTO_PROBE_TTL_MS
 * keyed by the full resolved config (env/config overrides get distinct keys);
 * the cached array is shared and MUST be treated as immutable by callers
 * (recall.ts only iterates it).
 *
 * @returns healthy providers in priority order (lmstudio → ollama → openai),
 *          or a single-element list for an explicit provider, or [] if none
 *          are reachable
 */
export async function createAutoProviders(
  cfg: EmbeddingConfig = {},
): Promise<EmbeddingProvider[]> {
  const resolved = resolveEmbeddingConfig(cfg);

  // Explicit provider → hard requirement
  if (resolved.provider && resolved.provider !== "auto") {
    return [createProvider({ ...resolved, provider: resolved.provider })];
  }

  // Auto: probe providers in parallel (cheap gates only), cache short-TTL.
  const cacheKey = JSON.stringify(resolved);
  const now = Date.now();
  if (
    autoProbeCache &&
    autoProbeCache.key === cacheKey &&
    now - autoProbeCache.at < AUTO_PROBE_TTL_MS
  ) {
    return autoProbeCache.providers;
  }

  // PROVIDERS is already priority-ordered (lmstudio → ollama → openai); map
  // each entry to its gate result and collect healthy ctors by index so the
  // returned order is the registry order even when probes resolve out of
  // order. Each probe is isolated — a throw or a false is just "not healthy".
  const gates = await Promise.all(
    PROVIDERS.map(async (ctor) => {
      try {
        return (await ctor.isHealthy({ ...resolved, provider: ctor.id }))
          ? ctor
          : null;
      } catch {
        return null;
      }
    }),
  );
  const healthy: EmbeddingProvider[] = [];
  // Promise.all preserves registry order in `gates`, so pushing aligned
  // entries yields priority order regardless of probe resolution order.
  gates.forEach((ctor) => {
    if (ctor) {
      healthy.push(
        ctor.build({
          baseUrl: resolved.baseUrl ?? "",
          model: resolved.model,
          dimensions: resolved.dimensions,
          timeoutMs: resolved.timeoutMs,
          apiKey: resolved.apiKey,
        }),
      );
    }
  });

  // Cache the empty array too (all-dead) so consecutive cold calls are
  // instant — the "consistently fast" half of the GAP-029 requirement.
  autoProbeCache = { key: cacheKey, at: Date.now(), providers: healthy };
  return healthy;
}

export function listProviders(): Array<{ id: string; label: string }> {
  return PROVIDERS.map((p) => ({ id: p.id, label: p.label }));
}
