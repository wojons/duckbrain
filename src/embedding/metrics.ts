/**
 * OBSDB-003 — embedding-path instrumentation.
 *
 * `docs/observability-spec.md` §2 (blind spots #2 and #9) and §3.2: the daemon
 * already CLASSIFIES every embed failure (`classifyEmbedFailure`, providers.ts)
 * and already tells the truth about cache residency in a stderr timing line
 * (search.ts `[search-timing]`), but neither fact reaches a time series. An
 * operator looking at `/health` sees `embedding.healthy=false` with one note
 * string and no history, and nothing anywhere says whether a recall paid for a
 * provider round trip or was served entirely from `.embeddings/`.
 *
 * This module owns the three families that answer those two questions:
 *
 *   duckbrain_embedding_requests_total     counter  — provider, outcome
 *   duckbrain_embedding_cache_hits_total   counter  — (no labels)
 *   duckbrain_embedding_cache_misses_total counter  — (no labels)
 *
 * THE COUNTERS ARE PROCESS-WIDE, NOT PER-APP. This is the one place the
 * design deliberately differs from `src/http/metrics.ts`: the facts being
 * counted happen in the embedding layer, which is exercised by the HTTP
 * daemon, by MCP stdio (`recall`), by the CLI (`duckbrain recall`,
 * `duckbrain embeddings rebuild`) and by the health probe — a counter owned by
 * `createHttpServer()` would miss every one of those except the daemon's own
 * traffic and would read zero in exactly the CLI-only deployments where
 * chasing a cold cache is most expensive. So the counters are module
 * singletons created with `registers: []` (no default registry, so importing
 * this module never pollutes `Registry.globalRegistry`) and
 * `registerEmbeddingMetrics()` attaches the SAME instances to each app
 * registry, which is how the values reach `GET /metrics` while remaining
 * readable from a one-shot CLI.
 *
 * LABEL DISCIPLINE (spec §3, hard rules): `provider` is a registry id
 * (`lmstudio` | `ollama` | `openai`) or the fixed value `unknown`; `outcome`
 * is a fixed five-value enum. NEVER a namespace, memory key, model id, host,
 * URL, raw error string or timestamp — the model id and the error note are
 * exactly the two things that would otherwise leak into a label here, and
 * both are dropped (`embeddingProviderLabel` keeps only the registry prefix).
 *
 * Enum values are the SPEC's, not the internal classifier's: the internal
 * `EmbedFailureClass` has eleven values (OPS-004 needs that detail in a
 * human-readable note), but a metric label must stay bounded and stable, so
 * ten of them collapse onto four outcomes (auth/quota/timeout/error).
 */

import { Counter, type Registry } from "prom-client";

export const EMBEDDING_REQUEST_TOTAL = "duckbrain_embedding_requests_total";
export const EMBEDDING_CACHE_HITS_TOTAL = "duckbrain_embedding_cache_hits_total";
export const EMBEDDING_CACHE_MISSES_TOTAL =
  "duckbrain_embedding_cache_misses_total";

/** The three families this module owns, in exposition order. */
export const EMBEDDING_METRIC_NAMES = [
  EMBEDDING_REQUEST_TOTAL,
  EMBEDDING_CACHE_HITS_TOTAL,
  EMBEDDING_CACHE_MISSES_TOTAL,
] as const;

/** The fixed `outcome` label domain (spec §3.2). */
export const EMBED_OUTCOMES = ["ok", "timeout", "auth", "quota", "error"] as const;
export type EmbedOutcome = (typeof EMBED_OUTCOMES)[number];

/**
 * The `provider` label domain: the embedder REGISTRY ids in
 * `src/embedding/providers.ts` PROVIDERS. Mirrored (not imported) so this
 * module has no import edge back into the provider table — the parity is
 * asserted by test, which fails if the registry grows without this list.
 */
export const EMBEDDING_PROVIDER_IDS = ["lmstudio", "ollama", "openai"] as const;

/** Every value the `provider` label may hold (ids plus the fallback). */
export const UNKNOWN_PROVIDER = "unknown";

/**
 * One increment per provider HTTP request that carried embed input.
 *
 * A BATCH COUNTS ONCE: `embedMany` issues one request for N texts, and this
 * family counts requests, not texts — counting texts would make the metric
 * incomparable between the batched path and the per-text fallback that
 * `search.ts` uses when a provider rejects batches. A batch failure therefore
 * reads as one failed request even though N vectors were lost, which is the
 * honest request-level accounting; the texts lost are a `rebuild`/recall
 * concern, not a scrape concern.
 */
export const embeddingRequests = new Counter({
  name: EMBEDDING_REQUEST_TOTAL,
  help: "Provider embedding HTTP requests by embedder id and outcome (ok|timeout|auth|quota|error); a batch request counts once.",
  labelNames: ["provider", "outcome"],
  registers: [],
});

/**
 * Cache lookups answered from `.embeddings/` (hit) or not (miss).
 *
 * Counted at `EmbeddingCache.get()` — the ONE residency decision in the
 * codebase (`has()` delegates to it, and search/rebuild/recall all go through
 * it), so a hit rate computed from these two counters describes every reader
 * rather than one caller's private loop.
 */
export const embeddingCacheHits = new Counter({
  name: EMBEDDING_CACHE_HITS_TOTAL,
  help: "Embedding cache lookups served from .embeddings/ (no provider request needed).",
  labelNames: [],
  registers: [],
});

export const embeddingCacheMisses = new Counter({
  name: EMBEDDING_CACHE_MISSES_TOTAL,
  help: "Embedding cache lookups with no usable vector on disk (a provider request is required).",
  labelNames: [],
  registers: [],
});

/**
 * Map an embedder id onto the `provider` label domain.
 *
 * Provider instances carry a MODEL-QUALIFIED id (`lmstudio/qwen3-embedding`,
 * `openai/text-embedding-3-small` — providers.ts makeHttpEmbed), because that
 * id is also the embedding-cache directory key. The label must not carry the
 * model: it is configured per host, changes with every upgrade, and is not a
 * fixed domain. Only the registry prefix survives, and only when it is one of
 * the known ids; anything else — a synthetic probe id, a config-supplied
 * string, a future provider — collapses to `unknown`.
 */
export function embeddingProviderLabel(id: unknown): string {
  const raw = typeof id === "string" ? id.trim().toLowerCase() : "";
  if (!raw) return UNKNOWN_PROVIDER;
  const registryId = raw.includes("/") ? raw.slice(0, raw.indexOf("/")) : raw;
  return (EMBEDDING_PROVIDER_IDS as readonly string[]).includes(registryId)
    ? registryId
    : UNKNOWN_PROVIDER;
}

/**
 * Collapse an internal `EmbedFailureClass` onto the metric's `outcome` enum.
 *
 *   timeout                         → timeout  (the 3s/8s budget expired)
 *   credential_* / forbidden        → auth     (the request was refused)
 *   rate_limited                    → quota    (429 = plan/rate ceiling)
 *   everything else                 → error    (transport, 5xx, empty vector…)
 *
 * `ok` is never produced here: only a resolved embed reports success, so a
 * failure can never be counted as a success by a mapping mistake.
 */
export function embedOutcomeForFailure(failureClass: unknown): EmbedOutcome {
  switch (failureClass) {
    case "timeout":
      return "timeout";
    case "credential_not_presented":
    case "credential_rejected":
    case "forbidden":
      return "auth";
    case "rate_limited":
      return "quota";
    default:
      return "error";
  }
}

/**
 * Record one provider request outcome. Never throws: a telemetry failure must
 * not turn a working embed into a failed one (or a failed one into a crash the
 * caller cannot classify).
 */
export function recordEmbedRequest(
  providerId: unknown,
  outcome: EmbedOutcome,
): void {
  try {
    const label = (EMBED_OUTCOMES as readonly string[]).includes(outcome)
      ? outcome
      : "error";
    embeddingRequests.inc({
      provider: embeddingProviderLabel(providerId),
      outcome: label,
    });
  } catch {
    /* telemetry never breaks the embed path */
  }
}

export function recordEmbedSuccess(providerId: unknown): void {
  recordEmbedRequest(providerId, "ok");
}

export function recordEmbedFailure(
  providerId: unknown,
  failureClass: unknown,
): void {
  recordEmbedRequest(providerId, embedOutcomeForFailure(failureClass));
}

/** Record one cache lookup that produced a usable vector. */
export function recordEmbeddingCacheHit(): void {
  try {
    embeddingCacheHits.inc();
  } catch {
    /* telemetry never breaks a cache read */
  }
}

/** Record one cache lookup that did not. */
export function recordEmbeddingCacheMiss(): void {
  try {
    embeddingCacheMisses.inc();
  } catch {
    /* telemetry never breaks a cache read */
  }
}

/**
 * Attach the process-wide embedding counters to a scrape registry.
 *
 * Registration (not duplication) is what makes the SAME instances visible on
 * `GET /metrics`: prom-client's `Counter#inc()` updates the metric object, and
 * every registry that registered it renders the current values. Idempotent —
 * a second call for an already-registered registry is a no-op, so repeated
 * `createHttpServer()` calls (tests, embedders) cannot throw
 * "already registered".
 */
export function registerEmbeddingMetrics(registry: Registry): void {
  for (const metric of [
    embeddingRequests,
    embeddingCacheHits,
    embeddingCacheMisses,
  ]) {
    try {
      registry.registerMetric(metric);
    } catch {
      // Same metric object already registered on this registry — nothing to do.
    }
  }
}

/**
 * Zero the counters (test seam).
 *
 * Process-wide counters accumulate across an entire process; a test that
 * asserts a delta from a clean zero needs this. Production never calls it —
 * a restart is the only reset a scrape should ever see.
 */
export function resetEmbeddingMetrics(): void {
  embeddingRequests.reset();
  embeddingCacheHits.reset();
  embeddingCacheMisses.reset();
}
