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
  classifyEmbedFailure,
  resolveEmbeddingConfig,
  type EmbeddingConfig,
} from "./providers";

/** In-process TTL for cached health results (monitor-polling budget). */
export const EMBEDDING_HEALTH_TTL_MS = 30_000;

/** Embed probe timeout: short on purpose — /health must never hang. */
export const EMBEDDING_HEALTH_PROBE_TIMEOUT_MS = 3_000;

/**
 * Hard deadline for ONE whole health probe attempt (OPS-002).
 *
 * The per-request timeouts above bound each individual fetch, but nothing
 * bounded the probe as a WHOLE. A single await that never settles (an abort
 * that is never delivered while the event loop is occupied, a provider socket
 * that parks mid-request, a native binding that never calls back) left the
 * shared in-flight promise in `getEmbeddingHealth` pending forever — and
 * because the TTL cache is only written once a probe settles, EVERY later
 * caller inherited that dead promise: `/health` stayed parked until the
 * process was restarted (observed live: an idle daemon with zero sockets, zero
 * CPU across every thread, /stats and /api/* answering in milliseconds, and
 * /health never responding — the keys sub-probe provably never ran, so the
 * handler never got past `await probe()`).
 *
 * This deadline is that missing bound: the probe ALWAYS settles (degraded,
 * with a deadline note) inside it, the in-flight slot is released, and the
 * next caller probes afresh instead of inheriting a stuck promise.
 *
 * Deliberately BELOW the /health handler's own deadline
 * (`HEALTH_HANDLER_DEADLINE_MS`, src/cli/http.ts) so the embedding probe
 * normally reports inside its own budget and by its own precise cause; the
 * handler bound stays the last-resort backstop for callers that bypass this
 * module's cache entirely.
 */
export const EMBEDDING_HEALTH_DEADLINE_MS = 3_500;

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
 *
 * Exported for the OPS-004 preflight (`./preflight.ts`): the CLI check must
 * report against the SAME effective config /health uses. A second copy of this
 * precedence chain would be exactly the config-drift class OPS-004 is about.
 */
export function resolveHealthConfig(
  cfg: EmbeddingConfig,
): Required<EmbeddingConfig> {
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
 *
 * OPS-004: the note must also NAME THE CLASS. The live incident reported
 * `embedding.healthy=false` with the note "The operation was aborted due to
 * timeout" — which says neither that the expired budget was the 3s HEALTH
 * probe (not the configured 30s embedding timeout) nor that the provider may
 * well be usable. Two classes get an explicit prefix so an operator can tell
 * "the credential never arrived" from "the credential was rejected" without
 * decoding provider JSON by hand; every other class keeps the historical note
 * shape verbatim (curl-able, grep-able).
 *
 * `secrets` is the presented credential — a provider that echoes it back in an
 * error body must not leak it into /health.
 */
function embedNote(
  id: string,
  e: unknown,
  secrets: readonly string[] = [],
): string {
  const failure = classifyEmbedFailure(e, secrets);
  const detail = failure.detail.slice(0, 160);
  if (id === "ollama" && /not found/i.test(detail)) {
    return "model not in /api/tags";
  }
  switch (failure.class) {
    case "timeout":
      return (
        `timeout: the embed probe exceeded its ${EMBEDDING_HEALTH_PROBE_TIMEOUT_MS}ms health budget` +
        ` (health-probe budget, NOT DUCKBRAIN_EMBEDDING_TIMEOUT_MS)` +
        ` — the provider may still be usable for real queries`
      );
    case "credential_not_presented":
      return (
        `auth: credential not presented — ${detail}` +
        ` (empty/malformed Authorization header; NOT a key-scope or route failure)`
      );
    case "credential_rejected":
      return `auth: credential rejected — ${detail}`;
    case "empty_vector":
      // DOGFOOD-002: a 200 with an empty vector is a failed embed.
      return "empty embedding vector in a 200 response";
    default:
      return detail;
  }
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
          note: embedNote(ctor.id, e, [resolved.apiKey]),
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
/** Generation counter for probes — a stale-write guard for late results. */
let probeGeneration = 0;

/** Degraded result for a probe that could not answer inside its deadline. */
function deadlineResult(note: string): EmbeddingHealthResult {
  return {
    provider: "",
    model: "",
    healthy: false,
    providers: [{ id: "deadline", healthy: false, note }],
  };
}

/**
 * Run one probe attempt, hard-bounded by EMBEDDING_HEALTH_DEADLINE_MS.
 *
 * The returned promise ALWAYS settles inside the deadline — that is the
 * contract `getEmbeddingHealth` depends on to release the in-flight slot. The
 * underlying probe is ABANDONED when the deadline wins (never awaited again,
 * handlers left attached so a late rejection cannot surface as an unhandled
 * rejection) and the cache only accepts a result from the LATEST generation:
 * a stale answer from an abandoned probe can never overwrite a newer one.
 */
function boundedProbe(
  generation: number,
  probe: () => Promise<EmbeddingHealthResult>,
): Promise<EmbeddingHealthResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<EmbeddingHealthResult>((resolve) => {
    timer = setTimeout(() => {
      const result = deadlineResult(
        `embedding probe exceeded its ${EMBEDDING_HEALTH_DEADLINE_MS}ms deadline — degraded (provider stuck or event loop starved); the stuck probe was abandoned so later probes still run`,
      );
      // Cache the degraded answer (monitor-polling budget): /health keeps
      // answering instantly instead of re-waiting the deadline on every poll.
      if (generation === probeGeneration) {
        healthCache = { at: Date.now(), result };
      }
      resolve(result);
    }, EMBEDDING_HEALTH_DEADLINE_MS);
    timer.unref?.();
  });

  return Promise.race([probe(), expiry])
    .then((result) => {
      if (generation === probeGeneration) {
        healthCache = { at: Date.now(), result };
      }
      return result;
    })
    .catch((e) => {
      const result = deadlineResult(`probe error: ${errMsg(e).slice(0, 160)}`);
      if (generation === probeGeneration) {
        healthCache = { at: Date.now(), result };
      }
      return result;
    })
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

/**
 * Cached, bounded view of embedding provider health (DOGFOOD-020, OPS-002).
 *
 * In-process ~30s TTL so monitor polling doesn't hammer providers; concurrent
 * callers share one in-flight probe instead of probing N times in a burst.
 *
 * @param probe injectable probe (tests); production uses probeEmbeddingHealth
 *
 * OPS-002 invariants — a stuck probe must never poison later callers:
 *   1. the cache only ever holds a SETTLED result, never a promise;
 *   2. the returned promise always settles within EMBEDDING_HEALTH_DEADLINE_MS
 *      (the in-flight slot is released in `finally`, which the deadline
 *      guarantees will run even when the underlying probe never settles);
 *   3. a deadline-expired probe is abandoned: later callers start a fresh
 *      probe instead of being handed the dead one, and its late result can
 *      never overwrite a newer cached answer.
 */
export function getEmbeddingHealth(
  probe: () => Promise<EmbeddingHealthResult> = probeEmbeddingHealth,
): Promise<EmbeddingHealthResult> {
  const now = Date.now();
  if (healthCache && now - healthCache.at < EMBEDDING_HEALTH_TTL_MS) {
    return Promise.resolve(healthCache.result);
  }
  if (!inFlight) {
    const generation = ++probeGeneration;
    const promise: Promise<EmbeddingHealthResult> = boundedProbe(
      generation,
      probe,
    ).finally(() => {
      // Always reached: boundedProbe settles at the deadline even when the
      // underlying probe never does. Clearing the slot here is what keeps ONE
      // stuck probe from being handed to every future caller forever.
      if (inFlight === promise) inFlight = null;
    });
    inFlight = promise;
  }
  return inFlight;
}

/**
 * Clear the TTL cache and any in-flight probe state (tests, config reloads).
 *
 * Also releases a stuck in-flight slot: a config reload must not inherit a
 * probe that never settled.
 */
export function resetEmbeddingHealthCache(): void {
  healthCache = null;
  inFlight = null;
  // probeGeneration only ever rises, so a late result from a superseded probe
  // is still recognised as stale after a reset.
  probeGeneration += 1;
}
