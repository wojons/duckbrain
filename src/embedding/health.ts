/**
 * Embedding Provider Health Probe (DOGFOOD-020)
 *
 * Observability-only: reports whether the configured embedding providers can
 * actually embed, so GET /health can surface a degraded status instead of a
 * false green while every ?q= semantic search 500s (the DOGFOOD-020 failure:
 * LM Studio's /v1/models answered while embeds 400ed — "LM Link connection
 * closed" — and Ollama did not have the configured model in /api/tags).
 *
 * Probe design (cheap first, real embed last):
 *   1. Cheap gate: each provider's existing isHealthy() (reachability /
 *      capability probe — NO embed call, see providers.ts DOGFOOD-002).
 *   2. Real embed probe: isHealthy providers get a real 1-token embed
 *      ("ping") via their own build() (which uses makeHttpEmbed) with a SHORT
 *      ~3s timeout (not cfg.timeoutMs) — a health check must not hang on a
 *      slow provider.
 *   3. Fallback: if the first isHealthy provider's embed fails, the next
 *      isHealthy provider is probed, stopping at the first success — the same
 *      fallback semantic recall uses (DOGFOOD-002), so /health reports
 *      healthy exactly when recall would work. In the common case this is
 *      exactly ONE embed probe.
 *
 * Config resolution precedence: explicit param > env (DUCKBRAIN_EMBEDDING_*)
 * > config file (getConfig().embedding) > resolveEmbeddingConfig() defaults.
 * The config file is included so /health reflects the daemon's on-disk
 * configuration.
 *
 * Results are cached in-process for EMBEDDING_HEALTH_TTL_MS so monitor
 * polling doesn't hammer providers; concurrent callers share one in-flight
 * probe.
 */

import { getConfig } from "../config";
import {
  PROVIDERS,
  resolveEmbeddingConfig,
  type EmbeddingConfig,
} from "./providers";

/** In-process TTL for cached health results (monitor-polling budget). */
export const EMBEDDING_HEALTH_TTL_MS = 30_000;

/** Embed probe timeout: short on purpose — /health must never hang. */
export const EMBEDDING_HEALTH_PROBE_TIMEOUT_MS = 3_000;

/** Reachability classification timeout (same budget as isHealthy probes). */
const CLASSIFY_TIMEOUT_MS = 1_500;

export interface EmbeddingProviderHealth {
  /** Provider id (e.g. "lmstudio") */
  id: string;
  healthy: boolean;
  /** Human-readable reason when unhealthy; "ok" when healthy */
  note: string;
}

export interface EmbeddingHealthResult {
  /** Provider id whose embed probe succeeded ("" when none did) */
  provider: string;
  /** The resolved embedding model id */
  model: string;
  /** True when at least one provider passed a real embed probe */
  healthy: boolean;
  /** Per-provider breakdown (priority order) */
  providers: EmbeddingProviderHealth[];
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Resolve the embedding config for health probing.
 *
 * Precedence: explicit param > env (DUCKBRAIN_EMBEDDING_*) > config file
 * (getConfig().embedding) > resolveEmbeddingConfig() defaults. The env layer
 * must sit ABOVE the file layer (recall resolves env+defaults only), so a
 * DUCKBRAIN_EMBEDDING_PROVIDER override still wins over an explicit
 * embedding.provider in duckbrain.config.json.
 */
function resolveHealthConfig(cfg: EmbeddingConfig): Required<EmbeddingConfig> {
  const env = process.env;
  const envCfg: EmbeddingConfig = {
    provider: env.DUCKBRAIN_EMBEDDING_PROVIDER,
    model: env.DUCKBRAIN_EMBEDDING_MODEL,
    baseUrl: env.DUCKBRAIN_EMBEDDING_BASE_URL,
    apiKey: env.DUCKBRAIN_EMBEDDING_API_KEY,
    dimensions: env.DUCKBRAIN_EMBEDDING_DIMENSIONS
      ? parseInt(env.DUCKBRAIN_EMBEDDING_DIMENSIONS, 10)
      : undefined,
    timeoutMs: env.DUCKBRAIN_EMBEDDING_TIMEOUT_MS
      ? parseInt(env.DUCKBRAIN_EMBEDDING_TIMEOUT_MS, 10)
      : undefined,
  };
  const fileCfg = getConfig().embedding ?? {};
  return resolveEmbeddingConfig({
    provider: cfg.provider ?? envCfg.provider ?? fileCfg.provider,
    model: cfg.model ?? envCfg.model ?? fileCfg.model,
    baseUrl: cfg.baseUrl ?? envCfg.baseUrl ?? fileCfg.baseUrl,
    apiKey: cfg.apiKey ?? envCfg.apiKey ?? fileCfg.apiKey,
    dimensions: cfg.dimensions ?? envCfg.dimensions ?? fileCfg.dimensions,
    // timeoutMs is env-only (DUCKBRAIN_EMBEDDING_TIMEOUT_MS); the config
    // file schema has no embedding.timeoutMs field.
    timeoutMs: cfg.timeoutMs ?? envCfg.timeoutMs,
  });
}

/** Base URL normalization matching providers.ts (strip trailing slash). */
function normBase(base: string | undefined, fallback: string): string {
  const b = (base || fallback).trim();
  return b.endsWith("/") ? b.slice(0, -1) : b;
}

/**
 * When isHealthy() returned false (without throwing), classify the failure so
 * the note says WHY: missing key, unreachable, HTTP error, or a capability
 * gate. One extra cheap fetch per unhealthy provider, only on cold checks
 * (bounded by the 30s TTL).
 */
async function classifyUnhealthy(
  id: string,
  cfg: Required<EmbeddingConfig>,
): Promise<string> {
  if (id === "openai") {
    return "missing API key (DUCKBRAIN_EMBEDDING_API_KEY)";
  }
  const url =
    id === "lmstudio"
      ? `${normBase(cfg.baseUrl, "http://localhost:1234/v1")}/models`
      : `${normBase(cfg.baseUrl, "http://localhost:11434")}/api/tags`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS),
    });
    if (!res.ok) return `HTTP ${res.status}`;
    if (id === "ollama") {
      // isHealthy=false with a 200 /api/tags can only mean the configured
      // model is listed WITHOUT the embedding capability.
      const data = (await res.json()) as {
        models?: Array<{ name?: string; capabilities?: string[] }>;
      };
      const listed = (data?.models ?? []).find(
        (m) => m.name === cfg.model || m.name?.startsWith(`${cfg.model}:`),
      );
      if (listed && !(listed.capabilities ?? []).includes("embedding")) {
        return "model lacks embedding capability";
      }
    }
    return "probe rejected";
  } catch {
    return "unreachable";
  }
}

/**
 * Shorten a makeHttpEmbed error for the note. Strips the "[provider/model] "
 * prefix; Ollama's "model not found" 404 becomes the actionable
 * "model not in /api/tags" (the DOGFOOD-020 failure mode).
 */
function embedNote(id: string, e: unknown): string {
  let msg = errMsg(e)
    .replace(/^\[[^\]]+\]\s*/, "")
    .slice(0, 160);
  if (id === "ollama" && /not found/i.test(msg)) {
    msg = "model not in /api/tags";
  }
  return msg;
}

/**
 * Probe embedding provider health WITHOUT caching.
 *
 * @param cfg explicit overrides (highest precedence)
 */
export async function probeEmbeddingHealth(
  cfg: EmbeddingConfig = {},
): Promise<EmbeddingHealthResult> {
  const resolved = resolveHealthConfig(cfg);
  const ordered =
    resolved.provider && resolved.provider !== "auto"
      ? PROVIDERS.filter((p) => p.id === resolved.provider)
      : PROVIDERS; // already priority order: lmstudio → ollama → openai

  const providers: EmbeddingProviderHealth[] = [];
  let winner = "";

  for (const ctor of ordered) {
    const perCfg = { ...resolved, provider: ctor.id };
    let cheapOk = false;
    let cheapErr: unknown = null;
    try {
      cheapOk = await ctor.isHealthy(perCfg);
    } catch (e) {
      cheapErr = e;
    }

    if (!cheapOk) {
      const note = cheapErr
        ? `unreachable: ${errMsg(cheapErr).slice(0, 160)}`
        : await classifyUnhealthy(ctor.id, perCfg);
      providers.push({ id: ctor.id, healthy: false, note });
      continue;
    }

    if (winner === "") {
      // Cheap gate passed and no provider has won yet — verify usability with
      // a real 1-token embed probe (SHORT timeout, not cfg.timeoutMs).
      const probeProvider = ctor.build({
        baseUrl: resolved.baseUrl,
        model: resolved.model,
        dimensions: resolved.dimensions,
        timeoutMs: EMBEDDING_HEALTH_PROBE_TIMEOUT_MS,
        apiKey: resolved.apiKey,
      });
      try {
        await probeProvider.embed("ping");
        winner = ctor.id;
        providers.push({ id: ctor.id, healthy: true, note: "ok" });
      } catch (e) {
        providers.push({
          id: ctor.id,
          healthy: false,
          note: embedNote(ctor.id, e),
        });
      }
    } else {
      // An earlier provider already passed the embed probe — no further embed
      // calls (monitor-polling budget); report the cheap gate result.
      providers.push({ id: ctor.id, healthy: true, note: "ok" });
    }
  }

  return {
    provider: winner,
    model: resolved.model,
    healthy: winner !== "",
    providers,
  };
}

let healthCache: { at: number; result: EmbeddingHealthResult } | null = null;
let inFlight: Promise<EmbeddingHealthResult> | null = null;

/**
 * Cached view of embedding provider health (DOGFOOD-020).
 *
 * In-process ~30s TTL so monitor polling doesn't hammer providers; concurrent
 * callers share one in-flight probe instead of probing N times in a burst.
 */
export function getEmbeddingHealth(): Promise<EmbeddingHealthResult> {
  const now = Date.now();
  if (healthCache && now - healthCache.at < EMBEDDING_HEALTH_TTL_MS) {
    return Promise.resolve(healthCache.result);
  }
  if (!inFlight) {
    inFlight = probeEmbeddingHealth()
      .then((result) => {
        healthCache = { at: Date.now(), result };
        return result;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** Clear the TTL cache (tests, config reloads). */
export function resetEmbeddingHealthCache(): void {
  healthCache = null;
}
