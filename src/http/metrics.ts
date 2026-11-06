/**
 * OBSDB-001 — Prometheus exposition for the DuckBrain HTTP daemon.
 *
 * `docs/observability-spec.md` §2/§4: the daemon already holds every fact an
 * operator needs at 3am (a `/health` verdict, per-provider embedding health,
 * a durable read ledger) but nothing converts any of it into a time series —
 * the only watchers are oneshot timers that read an EXIT CODE. This module is
 * the single scrape surface: `GET /metrics`, rendered by `prom-client` (the
 * official Node.js Prometheus client) in the text exposition format 0.0.4.
 *
 * Seventeen families are exposed (spec §3.1/§3.2: the six MVP families of
 * OBSDB-001, the two read-path depth families of OBSDB-002, the three
 * embedding-path families of OBSDB-003, the four git write-path families of
 * OBSDB-004, and — with OBSDB-005 and ADOPT-DECLARED-001 — storage, ledger,
 * recall and declaration-adoption families):
 *
 *   duckbrain_http_up                        gauge      — answer a scrape at all
 *   duckbrain_health_status                  gauge      — 2 healthy / 1 degraded / 0 hung
 *   duckbrain_health_probe_duration_seconds   histogram  — probe=embedding|keys|total
 *   duckbrain_embedding_provider_healthy     gauge      — provider=<embedder id>
 *   duckbrain_embedding_requests_total       counter    — provider/outcome (OBSDB-003)
 *   duckbrain_embedding_cache_hits_total     counter    — (no labels, OBSDB-003)
 *   duckbrain_embedding_cache_misses_total   counter    — (no labels, OBSDB-003)
 *   duckbrain_git_commit_total               counter    — outcome=ok|fail (OBSDB-004)
 *   duckbrain_git_push_total                 counter    — outcome=ok|fail (OBSDB-004)
 *   duckbrain_git_commit_queue_depth         gauge      — asyncChains.size (OBSDB-004)
 *   duckbrain_git_last_push_success_..._sec  gauge      — unix seconds (OBSDB-004)
 *   duckbrain_reads_total                    counter    — route/method/status_class
 *   duckbrain_read_duration_seconds          histogram  — route/method (OBSDB-002)
 *   duckbrain_rejected_total                 counter    — reason/route (OBSDB-002)
 *   duckbrain_build_info                     gauge 1    — version/node
 *   duckbrain_table_declaration_namespaces   gauge      — format=schema.json|legacy (ADOPT-DECLARED-001)
 *   duckbrain_table_declarations             gauge      — format=schema.json|legacy (ADOPT-DECLARED-001)
 *
 * The three OBSDB-003 families are owned by the EMBEDDING layer, not by this
 * module: `src/embedding/metrics.ts` holds them as process-wide counters
 * incremented at the real provider request and cache lookup (so CLI/MCP
 * embedding work is counted too, not just the daemon's). This module only
 * attaches them to the per-app registry — `registerEmbeddingMetrics` — which
 * is why they appear here without an `observe*` seam.
 *
 * LABEL RULES (hard, spec §3 "Label discipline") — enforced in code, not by
 * convention:
 *   - `route` is a NORMALIZED template from `normalizeReadRoute`
 *     (src/http/readLedger.ts) — never a raw URL, so a memory key or namespace
 *     in the path can never reach a label. `observeRead` additionally refuses
 *     any route string that does not look like a template, so a future caller
 *     cannot smuggle a value into it.
 *   - `method` is an HTTP verb, `status_class` a 1xx–5xx bucket.
 *   - `provider` is an embedder id (src/embedding/providers.ts PROVIDERS);
 *     anything else — synthetic probe ids such as "deadline", or a
 *     config-supplied string — collapses to the fixed value `unknown`.
 *   - `reason` is a fixed enum (OBSDB-002): `rate_limit` | `dns_rebind`, with
 *     `unknown` as the refusing-path fallback. The rejected counter's `route`
 *     is the same normalized template, or the literal `(unmatched)` sentinel
 *     for a refusal on a path the route table does not know (a write, a 404
 *     probe, anything attacker-chosen) — never the raw path.
 *   - `probe` and `version`/`node` are fixed enums/runtime constants.
 *   - NEVER a namespace name, memory key, memory id, principal, API-key id,
 *     file path, raw error string, or timestamp. Cardinality is bounded at
 *     ~12 route templates × 5 status classes × 2 verbs + <20 other series.
 *
 * HEALTH GAUGE / NO SPLIT-BRAIN: `duckbrain_health_status` comes from the SAME
 * evaluator `/health` uses (`evaluateHealth` in src/cli/http.ts) — not a second
 * copy of the probe logic, which is how a dashboard ends up green while
 * `/health` says degraded. The evaluation is reused for HEALTH_TTL_MS (the
 * embedding probe's own 30s cache TTL), so a scrape costs one keys probe in
 * the steady state instead of a 8.5s embed probe per scrape.
 *
 * The metric state is per-app (one Registry per createHttpServer()), so
 * in-process tests and embedders never share counters.
 */

import fs from "fs";
import path from "path";
import { Counter, Gauge, Histogram, Registry } from "prom-client";
import type { Request, Response } from "express";
import { PROVIDERS } from "../embedding/providers";
import { registerEmbeddingMetrics } from "../embedding/metrics";
import { GIT_METRIC_NAMES, registerGitMetrics } from "../git/metrics";
import {
  RECALL_METRIC_NAMES,
  registerRecallMetrics,
  syncRecallPacksFromCounterFile,
} from "../metrics/recall";
import {
  createStorageSampler,
  STORAGE_SCAN_TTL_MS,
  type StorageSampler,
  type StorageUsage,
} from "../metrics/storage";
import {
  normalizeReadRoute,
  READ_LEDGER_METRIC_NAMES,
  registerReadLedgerMetrics,
} from "./readLedger";
import {
  createDeclarationSampler,
  DECLARATION_METRIC_NAMES,
  DECLARATION_SCAN_TTL_MS,
  type DeclarationCensus,
  type DeclarationSampler,
} from "../metrics/declarations";

/** The two OBSDB-005 storage gauges, sampled at collect time. */
export const STORAGE_NAMESPACES_BYTES = "duckbrain_storage_namespaces_bytes";
export const STORAGE_EMBEDDING_CACHE_BYTES =
  "duckbrain_storage_embedding_cache_bytes";

export const STORAGE_METRIC_NAMES = [
  STORAGE_NAMESPACES_BYTES,
  STORAGE_EMBEDDING_CACHE_BYTES,
] as const;

/**
 * ADOPT-DECLARED-001: declaration adoption — namespaces per declaration SHAPE,
 * and the declared-table totals behind them. Sampled at collect time from the
 * same namespaces root as the storage gauges.
 */
export const DECLARATION_NAMESPACES = DECLARATION_METRIC_NAMES[0];
export const DECLARATION_TABLES = DECLARATION_METRIC_NAMES[1];

/** The six+two families this endpoint owns, in exposition order. */
export const METRIC_NAMES = [
  "duckbrain_http_up",
  "duckbrain_health_status",
  "duckbrain_health_probe_duration_seconds",
  "duckbrain_embedding_provider_healthy",
  "duckbrain_embedding_requests_total",
  "duckbrain_embedding_cache_hits_total",
  "duckbrain_embedding_cache_misses_total",
  // OBSDB-004: the git write path (commit/push outcomes, queue depth, push
  // staleness) — owned by src/git/metrics.ts, attached below.
  ...GIT_METRIC_NAMES,
  // OBSDB-005: storage growth, ledger churn and recall usefulness — the
  // file-backed families. The storage gauges are sampled at collect time by
  // this module; the rotation and recall counters live with the code that
  // produces the fact (src/http/readLedger.ts, src/metrics/recall.ts) and are
  // attached here.
  ...STORAGE_METRIC_NAMES,
  // ADOPT-DECLARED-001: is the declared-schema path actually adopted?
  ...DECLARATION_METRIC_NAMES,
  ...READ_LEDGER_METRIC_NAMES,
  ...RECALL_METRIC_NAMES,
  "duckbrain_reads_total",
  "duckbrain_read_duration_seconds",
  "duckbrain_rejected_total",
  "duckbrain_build_info",
] as const;

/**
 * `duckbrain_health_status` values. The three-way split is the EXISTING
 * daemon taxonomy, not a new one: `src/cli/health-check.ts` treats 200 and
 * 503 as ALIVE, and reports HUNG (exit 3) when the port accepted the
 * connection and `/health` never answered. Flattening that to up/down would
 * page a restart-loop at a daemon that is serving REST/MCP just fine.
 */
export const HEALTH_STATUS_VALUES = {
  healthy: 2,
  degraded: 1,
  hung: 0,
} as const;

export type HealthState = keyof typeof HEALTH_STATUS_VALUES;

/** The fixed `probe` label domain for the health-probe histogram. */
export const HEALTH_PROBES = ["embedding", "keys", "total"] as const;
export type HealthProbe = (typeof HEALTH_PROBES)[number];

/** One evaluation's result, as the metrics surface consumes it. */
export interface HealthSnapshot {
  status: HealthState;
  /** Per-provider embedding verdict (`id` + `healthy` only — never a note). */
  providers: ReadonlyArray<{ id: string; healthy: boolean }>;
  /** Wall duration of each sub-probe and of the whole evaluation. */
  durationsMs: Record<HealthProbe, number>;
}

/** One recorded read, as the read-ledger middleware classifies it. */
export interface ReadEvent {
  /** Normalized route template, e.g. `GET /api/memories/key/:key`. */
  route: string;
  /** Uppercase HTTP verb. */
  method: string;
  /** Response status code (bucketed into `status_class`). */
  status: number;
  /**
   * OBSDB-002: server-measured wall duration of the request in MILLISECONDS —
   * the very value the ledger stores as `dur_ms` (the middleware times the
   * request with `process.hrtime.bigint()` and observes it on `finish`).
   * Omitted/absent means "no measurement"; nothing is observed for it, so a
   * non-timed caller can never plant a fake zero-latency sample.
   */
  durMs?: number;
}

/**
 * The fixed `reason` domain of `duckbrain_rejected_total`.
 *
 * These are the ONLY two refusal paths that run before the read ledger, which
 * is why they are invisible in the durable ledger and need their own counter
 * (spec §2 blind spot #4):
 *   - `rate_limit` — the 429 from src/auth/ratelimit.ts (rateLimitMiddleware,
 *     mounted at src/cli/http.ts BEFORE the read ledger);
 *   - `dns_rebind` — the 403 from dnsRebindingProtection (src/cli/http.ts),
 *     mounted FIRST, before even the limiter.
 */
export const REJECTION_REASONS = ["rate_limit", "dns_rebind"] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

/**
 * The fixed `route` value for a rejected request whose path is not one of the
 * documented read templates — e.g. a 429 on `POST /api/memories` or a 403 on
 * an attacker-chosen path. It is a LITERAL sentinel, never the raw path: a
 * rejected request is exactly the traffic most likely to carry a probe for a
 * secret, so its URL must never become a label value.
 */
export const REJECTION_ROUTE_SENTINEL = "(unmatched)";

/** One refused request, as the refusing middleware sees it. */
export interface RejectionEvent {
  /** Which guard refused it (fixed enum above). */
  reason: RejectionReason;
  /** Raw request method/URL — classified HERE, never used as a label. */
  method: string;
  rawPath: string;
}

export interface HttpMetricsOptions {
  /**
   * Runs one `/health` evaluation (production: `evaluateHealth` with its
   * default probes). MUST be the same evaluator the health endpoint uses.
   */
  evaluateHealth: () => Promise<HealthSnapshot>;
  /** Build version for `duckbrain_build_info` (default: read package.json). */
  version?: string;
  /** `node` label value (default: `process.version`, like /health's nodeVersion). */
  nodeVersion?: string;
  /** Reuse window for a health evaluation (default 30s = probe cache TTL). */
  healthTtlMs?: number;
  /** Hard bound on one scrape's evaluation (default 10s ≈ /health + slack). */
  healthDeadlineMs?: number;
  /** Clock seam (tests). */
  now?: () => number;
  /**
   * OBSDB-005: the resolved namespaces root whose footprint
   * `duckbrain_storage_namespaces_bytes` reports. A getter so the daemon can
   * hand over a path it resolves later in startup. When absent, the storage
   * gauges emit NO sample — an embedder that never declared a storage root has
   * nothing to measure, and a fabricated 0 would read as "the store is empty".
   */
  namespacesPath?: string | (() => string);
  /**
   * OBSDB-005: the recall counter JSONL the MCP server appends to
   * (`<data-dir>/metrics/recall-counter.jsonl`). Defaults to the path resolved
   * from config, i.e. beside the configured namespaces directory.
   */
  recallCounterFile?: string;
  /** Reuse window for one storage walk (default STORAGE_SCAN_TTL_MS = 60 s). */
  storageScanTtlMs?: number;
  /** Measurement seam (tests): defaults to the real tree walk. */
  measureStorage?: (namespacesPath: string) => Promise<StorageUsage>;
}

export interface HttpMetrics {
  /** The per-app registry (tests render it directly). */
  registry: Registry;
  /** Express handler for `GET /metrics`. */
  handler: (req: Request, res: Response) => Promise<void>;
  /** Record one `/health` evaluation (used by the endpoint and by scrapes). */
  recordHealth(snapshot: HealthSnapshot): void;
  /** Mirror one recorded read into `duckbrain_reads_total`. */
  observeRead(event: ReadEvent): void;
  /**
   * Count one request the DNS-rebinding guard or the rate limiter REFUSED
   * (OBSDB-002). Called from those middlewares, i.e. upstream of the read
   * ledger, which is the only place a 403/429 can be observed at all.
   */
  observeRejection(event: RejectionEvent): void;
  /**
   * OBSDB-005: pull the file-backed counters into this registry. Called by the
   * scrape handler before rendering, because the MCP server that appends recall
   * events is a different process — an in-process increment would read 0.
   */
  syncExternalCounters(): void;
  /** Render the current exposition (test/debug seam). */
  render(): Promise<string>;
}

/** Steady-state reuse window for a health evaluation (= embedding probe TTL). */
export const HEALTH_TTL_MS = 30_000;

/** A scrape never waits longer than /health's own handler deadline + slack. */
export const HEALTH_DEADLINE_MS = 10_000;

/**
 * Buckets for `duckbrain_health_probe_duration_seconds`. The upper buckets sit
 * around the two budgets that matter operationally: the 8s embed-probe budget
 * (a provider slower than that IS the degraded signal) and the 9s whole-handler
 * deadline (OPS-002's parked `/health`).
 */
const PROBE_DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 8, 9, 15,
];

/**
 * Buckets for `duckbrain_read_duration_seconds` (OBSDB-002): 10 ms → 30 s.
 *
 * The floor is 10 ms because the ledger's own `dur_ms` is a millisecond
 * integer — a sub-10 ms read is already "fast enough for any SLO" and finer
 * buckets there would buy resolution nobody alerts on. The 2.5 s / 5 s / 10 s
 * rungs are where a read that fans out to the embedder or to a cold DuckDB
 * actually lands, and 30 s is the ceiling past which a read is a hang, not a
 * latency. `histogram_quantile(0.95, ...)` over per-route series is the query
 * this family exists to make answerable (spec §6).
 */
const READ_DURATION_BUCKETS = [
  0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30,
];

/**
 * The literal path segments a normalized route template may contain.
 *
 * This is the `route` label's real defense: `observeRead` refuses any route
 * whose segments are not one of these words or a `:placeholder`, so a RAW path
 * (`/api/ns/tenant-acme/tables`) can never become a label value — `tenant-acme`
 * is not in this vocabulary, while every template `normalizeReadRoute` produces
 * is. The set grows with the route table (src/http/readLedger.ts); an unknown
 * word is dropped rather than trusted.
 */
const TEMPLATE_SEGMENTS: ReadonlySet<string> = new Set([
  "api",
  "memories",
  "key",
  "keys",
  "namespaces",
  "ns",
  "tables",
  "events",
  "activity",
  "flat",
  "stats",
]);

/** The value placeholders `normalizeReadRoute` substitutes for real values. */
const TEMPLATE_PLACEHOLDERS: ReadonlySet<string> = new Set([
  ":key",
  ":id",
  ":ns",
  ":table",
]);

const ROUTE_RE = /^(GET|HEAD|POST|PUT|PATCH|DELETE) (\/[A-Za-z0-9_:./-]{0,120})$/;

/**
 * True when `route` is a route TEMPLATE (`GET /api/memories/key/:key`), false
 * for anything carrying a real value. Exported so the rule is testable.
 */
export function isRouteTemplate(route: string): boolean {
  if (typeof route !== "string") return false;
  const match = ROUTE_RE.exec(route);
  if (!match) return false;
  const segments = match[2].split("/").filter(Boolean);
  if (segments.length === 0 || segments.length > 6) return false;
  return segments.every((segment) =>
    segment.startsWith(":")
      ? TEMPLATE_PLACEHOLDERS.has(segment)
      : TEMPLATE_SEGMENTS.has(segment),
  );
}

/** Provider ids are lowercase tokens from the configured provider table. */
const PROVIDER_LABEL_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * The configured embedder ids — the only values allowed in `provider`.
 *
 * Resolved lazily and defensively: a test (or an embedder) may replace
 * `../embedding/providers` with a partial module mock, and an absent provider
 * table must degrade to "no id is trusted" (every value → `unknown`) instead of
 * crashing the process at import time. Reading it lazily also keeps this module
 * free of import-time work.
 */
let knownProviderIds: ReadonlySet<string> | null = null;

function knownProviders(): ReadonlySet<string> {
  if (knownProviderIds) return knownProviderIds;
  const table = Array.isArray(PROVIDERS) ? PROVIDERS : [];
  knownProviderIds = new Set(
    table
      .map((provider) => provider?.id)
      .filter((id): id is string => typeof id === "string"),
  );
  return knownProviderIds;
}

/**
 * Map an arbitrary provider identifier onto the `provider` label domain.
 *
 * The health probe reports provider ids from config plus synthetic ids of its
 * own ("deadline", "probe") in failure modes. The metric's contract is "the
 * embedder id, or nothing meaningful" — so a synthetic/unrecognised value
 * collapses to the fixed string `unknown` instead of inventing cardinality or
 * leaking a config-supplied string.
 */
export function providerLabel(id: unknown): string {
  const raw = typeof id === "string" ? id.trim().toLowerCase() : "";
  return knownProviders().has(raw) && PROVIDER_LABEL_RE.test(raw)
    ? raw
    : "unknown";
}

/** Bucket an HTTP status into the `status_class` label domain. */
export function statusClass(status: number): string {
  if (!Number.isInteger(status)) return "unknown";
  const bucket = Math.floor(status / 100);
  return bucket >= 1 && bucket <= 5 ? `${bucket}xx` : "unknown";
}

/**
 * Map a refusal cause onto the `reason` label domain. Anything outside the
 * fixed enum collapses to `unknown` — a caller can never invent a reason
 * string (or smuggle a principal, IP or message) into the label.
 */
export function rejectionReasonLabel(reason: unknown): string {
  return typeof reason === "string" &&
    (REJECTION_REASONS as readonly string[]).includes(reason)
    ? reason
    : "unknown";
}

/**
 * Classify the path of a REFUSED request into the `route` label domain.
 *
 * A rejected request never reached a mounted route, so Express cannot give us
 * a `req.route.path`; the only safe classification is the read ledger's own
 * truth table (`normalizeReadRoute`). Anything that table does not know —
 * a write, a 404 probe, an attacker-chosen path — collapses to the fixed
 * `(unmatched)` sentinel. The raw path is used as INPUT to the classifier and
 * is never returned: that is what keeps a probe for
 * `/api/memories/key/<secret>` from becoming a metric label.
 */
export function rejectionRouteLabel(method: unknown, rawPath: unknown): string {
  if (typeof method !== "string" || typeof rawPath !== "string") {
    return REJECTION_ROUTE_SENTINEL;
  }
  const route = normalizeReadRoute(method, rawPath);
  // Belt and braces: the classifier's output is re-checked against the same
  // template allowlist the reads counter uses, so a future template that
  // bypassed it would be dropped rather than exposed.
  return route !== null && isRouteTemplate(route)
    ? route
    : REJECTION_ROUTE_SENTINEL;
}

/**
 * The DuckBrain build version, for `duckbrain_build_info`.
 *
 * Walks up from this module (works from src/ under tsx and from dist/src/
 * after a build) and reads the package.json whose name is `duckbrain`. Never
 * throws: an unreadable tree yields "unknown" rather than killing the scrape.
 */
export function resolveBuildVersion(): string {
  let dir = __dirname;
  for (let level = 0; level <= 5; level++) {
    try {
      const pkgPath = path.join(dir, "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
          name?: unknown;
          version?: unknown;
        };
        if (pkg?.name === "duckbrain" && typeof pkg.version === "string") {
          return pkg.version;
        }
      }
    } catch {
      /* unreadable/malformed — keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "unknown";
}

/** Degraded snapshot used when a scrape cannot complete an evaluation. */
function hungSnapshot(): HealthSnapshot {
  return {
    status: "hung",
    providers: [],
    durationsMs: { embedding: 0, keys: 0, total: 0 },
  };
}

/**
 * Build the per-app metrics surface.
 *
 * Every instance owns its own Registry, so two `createHttpServer()` calls in
 * one process (in-process tests, embedders) never share series.
 */
export function createHttpMetrics(options: HttpMetricsOptions): HttpMetrics {
  const registry = new Registry();
  const now = options.now ?? (() => Date.now());
  const healthTtlMs = options.healthTtlMs ?? HEALTH_TTL_MS;
  const healthDeadlineMs = options.healthDeadlineMs ?? HEALTH_DEADLINE_MS;
  const version = options.version ?? resolveBuildVersion();
  const nodeVersion = options.nodeVersion ?? process.version;

  // The single most important series: is the process answering a scrape? It
  // is set to 1 by the handler — reaching the handler IS the observation, so
  // there is no path where this reads 0 while the body was rendered. A missing
  // series means "no process", which Prometheus turns into `up == 0`.
  const httpUp = new Gauge({
    name: "duckbrain_http_up",
    help: "1 when the DuckBrain HTTP daemon answered this /metrics scrape (a missing series means the process is gone).",
    registers: [registry],
  });

  // 2 healthy / 1 degraded / 0 hung — the health-check.ts ALIVE/DARK/HUNG split.
  const healthStatus = new Gauge({
    name: "duckbrain_health_status",
    help: "Current /health verdict: 2=healthy, 1=degraded (embedding or keys probe failing), 0=hung (no verdict could be produced).",
    registers: [registry],
  });

  // Is /health slow — the OPS-002 failure class? probe=embedding|keys|total.
  const healthProbeDuration = new Histogram({
    name: "duckbrain_health_probe_duration_seconds",
    help: "Wall duration of the /health sub-probes in seconds (probe=embedding|keys|total).",
    labelNames: ["probe"],
    buckets: PROBE_DURATION_BUCKETS,
    registers: [registry],
  });

  // Per-provider embedder usability — the live incident is provider=0.
  const providerHealthy = new Gauge({
    name: "duckbrain_embedding_provider_healthy",
    help: "1 when the embedding provider passed its real embed probe, 0 otherwise (provider=<embedder id>|unknown).",
    labelNames: ["provider"],
    registers: [registry],
  });

  // OBSDB-003: embedding request outcomes and cache residency. The counters
  // themselves live in the embedding layer (src/embedding/metrics.ts) because
  // the facts are produced there — by the daemon, by MCP stdio and by one-shot
  // CLI runs alike. Registering the SAME instances here is what puts them in
  // this scrape; anything that increments them from a CLI still shows up in the
  // daemon's next scrape of a shared process, and a CLI-only process reads the
  // counters through its own registry-free metric objects.
  registerEmbeddingMetrics(registry);

  // OBSDB-004: the git write path. Same process-wide-owner pattern as the
  // embedding counters: the facts are produced in src/git/autocommit.ts, which
  // runs in the daemon, in MCP stdio and in one-shot CLI runs alike, so the
  // counters live with that layer and are merely ATTACHED here. Without them a
  // namespace can stop reaching its remote while /health and every read stay
  // green (spec §2 blind spots #5-#6).
  registerGitMetrics(registry);

  // OBSDB-005: storage footprint, sampled AT COLLECT TIME so the daemon gains
  // no background loop (spec §3.2). `du -sb namespaces` is the number this
  // gauge must reproduce; the `.embeddings` subset is the reclaimable cache.
  //
  // No declared namespaces root ⇒ no sampler ⇒ NO sample (both collect
  // callbacks remove the series). That is the honest state for an embedded
  // app: it is not "0 bytes of memory", it is "this process does not own a
  // store to measure".
  const storagePath =
    typeof options.namespacesPath === "function"
      ? options.namespacesPath
      : options.namespacesPath
        ? () => options.namespacesPath as string
        : null;
  const storageSampler: StorageSampler | null = storagePath
    ? createStorageSampler({
        namespacesPath: storagePath,
        ttlMs: options.storageScanTtlMs ?? STORAGE_SCAN_TTL_MS,
        now,
        measure: options.measureStorage,
      })
    : null;

  let storageNamespacesBytes!: Gauge;
  let storageEmbeddingCacheBytes!: Gauge;

  /**
   * Publish one measurement (or withdraw both series when there is none).
   *
   * SINGLE-FLIGHT: both gauges render from one measurement, and prom-client
   * calls collect for each of them — so two concurrent collect callbacks would
   * race otherwise (one gets the sampler's in-flight placeholder and would
   * withdraw the series the other just set). One shared promise means both
   * gauges always describe the same walk.
   */
  let publishingStorage: Promise<void> | null = null;
  const publishStorage = (): Promise<void> => {
    if (publishingStorage) return publishingStorage;
    const run = (async (): Promise<void> => {
      if (!storageSampler) {
        storageNamespacesBytes.remove();
        storageEmbeddingCacheBytes.remove();
        return;
      }
      let usage: StorageUsage | null = null;
      try {
        usage = await storageSampler.read();
      } catch {
        usage = null; // a failed walk is no measurement, never a 0
      }
      if (!usage) {
        storageNamespacesBytes.remove();
        storageEmbeddingCacheBytes.remove();
        return;
      }
      storageNamespacesBytes.set(usage.namespacesBytes);
      storageEmbeddingCacheBytes.set(usage.embeddingCacheBytes);
    })();
    publishingStorage = run.finally(() => {
      publishingStorage = null;
    });
    return publishingStorage;
  };

  storageNamespacesBytes = new Gauge({
    name: STORAGE_NAMESPACES_BYTES,
    help: "Bytes of every regular file under the namespaces root, measured when the scrape asks (du -sb namespaces); it is the fleet's memory substrate, so a flat line is suspicious and a climb is disk pressure.",
    registers: [registry],
    collect: publishStorage,
  });

  storageEmbeddingCacheBytes = new Gauge({
    name: STORAGE_EMBEDDING_CACHE_BYTES,
    help: "Bytes under .embeddings/ directories inside the namespaces root — the derivable embedding cache, reclaimable by a rebuild.",
    registers: [registry],
    collect: publishStorage,
  });

  // ADOPT-DECLARED-001: the declared-schema path had zero production adoption
  // (0 schema.json vs 949 legacy .table.json on 2026-11-04) while every SUPA-6
  // feature rode it. Adoption is now a moving number rather than a one-off
  // `find`: namespaces per shape, plus the declared-table totals behind them.
  const declarationSampler: DeclarationSampler | null = storagePath
    ? createDeclarationSampler({
        namespacesPath: storagePath,
        ttlMs: options.storageScanTtlMs ?? DECLARATION_SCAN_TTL_MS,
        now,
      })
    : null;

  let declarationNamespaces!: Gauge;
  let declarationTables!: Gauge;

  /** Same single-flight rule as publishStorage: both gauges, one walk. */
  let publishingDeclarations: Promise<void> | null = null;
  const declarationFormats = ["schema.json", "legacy"] as const;
  const publishDeclarations = (): Promise<void> => {
    if (publishingDeclarations) return publishingDeclarations;
    const run = (async (): Promise<void> => {
      const withdraw = (): void => {
        for (const format of declarationFormats) {
          declarationNamespaces.remove({ format });
          declarationTables.remove({ format });
        }
      };
      if (!declarationSampler) {
        withdraw();
        return;
      }
      let census: DeclarationCensus | null = null;
      try {
        census = await declarationSampler.read();
      } catch {
        census = null; // unmeasurable is not "nobody adopted"
      }
      if (!census) {
        withdraw();
        return;
      }
      declarationNamespaces.set(
        { format: "schema.json" },
        census.namespacesWithSchemaJson,
      );
      declarationNamespaces.set(
        { format: "legacy" },
        census.namespacesWithLegacy,
      );
      declarationTables.set({ format: "schema.json" }, census.tablesInSchemaJson);
      declarationTables.set({ format: "legacy" }, census.tablesLegacy);
    })();
    publishingDeclarations = run.finally(() => {
      publishingDeclarations = null;
    });
    return publishingDeclarations;
  };

  declarationNamespaces = new Gauge({
    name: DECLARATION_NAMESPACES,
    help: "Namespaces holding each table-declaration shape (format=schema.json is the SUPA-6 persistent schema, format=legacy is tables/<table>.table.json); a flat 0 for schema.json means nobody has adopted the documented path.",
    labelNames: ["format"],
    registers: [registry],
    collect: publishDeclarations,
  });

  declarationTables = new Gauge({
    name: DECLARATION_TABLES,
    help: "Declared tables per declaration shape across the store (format=schema.json counts schema.json table entries, format=legacy counts tables/*.table.json files).",
    labelNames: ["format"],
    registers: [registry],
    collect: publishDeclarations,
  });

  // OBSDB-005: the read ledger's rotation counter (src/http/readLedger.ts) and
  // the recall pack counters (src/metrics/recall.ts) are process-wide facts
  // produced outside this module — a seal happens in the ledger writer, a
  // recall happens in the MCP process — so they are ATTACHED here, not
  // reimplemented. Registration is idempotent, and order follows the spec's
  // §3.2 table (storage, then ledger churn, then recall usefulness).
  registerReadLedgerMetrics(registry);
  registerRecallMetrics(registry);

  /**
   * OBSDB-005: count recall events appended since the last scrape.
   *
   * The MCP server is a different process from this daemon, so the only shared
   * truth is the counter file. Nothing here may throw into the scrape: a
   * malformed line or a racing truncation leaves the previous totals in place.
   */
  function syncExternalCounters(): void {
    try {
      syncRecallPacksFromCounterFile(options.recallCounterFile);
    } catch {
      /* telemetry must never fail a scrape */
    }
  }

  // How much work is the daemon doing, and how much of it is failing?
  const reads = new Counter({
    name: "duckbrain_reads_total",
    help: "Recorded read requests (the .duckbrain-audit/reads.jsonl truth table) by normalized route template, method and status class.",
    labelNames: ["route", "method", "status_class"],
    registers: [registry],
  });

  // OBSDB-002: how long did a read take? The ledger already stores dur_ms per
  // row but aggregateReadRows drops it, so p95 per route had no answer
  // anywhere; this is that answer as a time series. Labels are the SAME
  // route/method pair the counter uses, so the cardinality is the route
  // allowlist, not traffic.
  const readDuration = new Histogram({
    name: "duckbrain_read_duration_seconds",
    help: "Server-measured wall duration of recorded read requests in seconds (the ledger's dur_ms, by normalized route template and method).",
    labelNames: ["route", "method"],
    buckets: READ_DURATION_BUCKETS,
    registers: [registry],
  });

  // OBSDB-002: requests REFUSED before the read ledger ever ran — the 403 from
  // the DNS-rebinding guard and the 429 from the rate limiter. Those responses
  // produce zero ledger rows (and therefore zero duckbrain_reads_total) by
  // construction: both middlewares sit upstream of the ledger and never call
  // next(), so the only way to see them is to count them where they are
  // emitted.
  const rejected = new Counter({
    name: "duckbrain_rejected_total",
    help: "Requests refused before the read ledger by reason (rate_limit=429, dns_rebind=403) and normalized route template (or the (unmatched) sentinel).",
    labelNames: ["reason", "route"],
    registers: [registry],
  });

  // What is deployed? Constant 1 — the labels carry the identity.
  const buildInfo = new Gauge({
    name: "duckbrain_build_info",
    help: "Constant 1; the version and node labels identify the deployed build.",
    labelNames: ["version", "node"],
    registers: [registry],
  });

  // NOTE: prom-client renders NO samples for a label child that was never
  // observed, so the histogram and read counter only appear once a real
  // measurement exists. That is deliberate — a fabricated zero observation to
  // make the family "always present" would poison `_count` and `_sum` with a
  // measurement that never happened. The histogram is populated by the first
  // scrape (which evaluates /health); the read counter appears with the first
  // recorded read, because "no reads recorded" is genuinely no series.
  buildInfo.labels(version, nodeVersion).set(1);

  let cache: { at: number; snapshot: HealthSnapshot } | null = null;

  /**
   * Publish one verdict. `fresh` says whether this evaluation ACTUALLY ran on
   * this scrape: a verdict reused from the TTL cache must NOT be re-observed
   * into the probe histogram, or the histogram's `_count` would track scrapes
   * instead of probes (and `_sum` would count the same measurement N times).
   * The gauges are idempotent, so they are set either way.
   */
  function applyHealth(snapshot: HealthSnapshot, fresh: boolean): void {
    healthStatus.set(HEALTH_STATUS_VALUES[snapshot.status]);
    if (fresh) {
      for (const probe of HEALTH_PROBES) {
        const ms = Number(snapshot.durationsMs?.[probe]);
        if (!Number.isFinite(ms) || ms < 0) continue;
        healthProbeDuration.observe({ probe }, ms / 1000);
      }
    }
    // Replace the provider children wholesale: a provider removed from config
    // must not leave a frozen series behind.
    providerHealthy.reset();
    const seen = new Set<string>();
    for (const provider of snapshot.providers ?? []) {
      const label = providerLabel(provider.id);
      if (seen.has(label)) continue;
      seen.add(label);
      providerHealthy.labels(label).set(provider.healthy ? 1 : 0);
    }
  }

  /** Record one evaluation from a caller that just ran it (observes timings). */
  function recordHealth(snapshot: HealthSnapshot): void {
    applyHealth(snapshot, true);
    cache = { at: now(), snapshot };
  }

  function observeRead(event: ReadEvent): void {
    // Defensive: a label value outside the template domain is DROPPED, never
    // emitted. This is the last line of defence for "no key/namespace in a
    // label" even if a future caller passes a raw path.
    if (!isRouteTemplate(event.route)) return;
    const method = typeof event.method === "string" ? event.method.toUpperCase() : "";
    if (!/^[A-Z]{3,7}$/.test(method)) return;
    reads.inc(
      {
        route: event.route,
        method,
        status_class: statusClass(event.status),
      },
      1,
    );
    // OBSDB-002: latency for the SAME read the counter just counted. Only a
    // real, finite, non-negative measurement is observed — an absent durMs
    // (a caller that did not time the request) adds no sample, so the
    // histogram's _count can never drift above the read counter's total for
    // reasons of missing data.
    const ms = Number(event.durMs);
    if (event.durMs !== undefined && Number.isFinite(ms) && ms >= 0) {
      readDuration.observe({ route: event.route, method }, ms / 1000);
    }
  }

  /**
   * Count one refused request. The classification happens HERE — the caller
   * only ever hands over the raw method/path, so a middleware cannot decide
   * (or fabricate) a label value.
   *
   * Nothing here can throw into the refusing middleware: a metrics failure
   * must never turn a clean 403/429 into a 500 (or, worse, into a served
   * request).
   */
  function observeRejection(event: RejectionEvent): void {
    try {
      rejected.inc(
        {
          reason: rejectionReasonLabel(event?.reason),
          route: rejectionRouteLabel(event?.method, event?.rawPath),
        },
        1,
      );
    } catch {
      /* telemetry never breaks a refusal path */
    }
  }

  /** One bounded evaluation; a deadline miss is the HUNG state, not an error. */
  async function evaluateBounded(): Promise<HealthSnapshot> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const expiry = new Promise<HealthSnapshot>((resolve) => {
        timer = setTimeout(() => resolve(hungSnapshot()), healthDeadlineMs);
        timer.unref?.();
      });
      return await Promise.race([options.evaluateHealth(), expiry]);
    } catch {
      // A throwing evaluator means no verdict exists — /health would be
      // failing too, so the honest value is 0 (hung), not a stale green.
      return hungSnapshot();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** A cached verdict when it is still warm, otherwise one bounded evaluation. */
  async function snapshotForScrape(): Promise<{
    snapshot: HealthSnapshot;
    fresh: boolean;
  }> {
    if (cache && now() - cache.at < healthTtlMs) {
      return { snapshot: cache.snapshot, fresh: false };
    }
    const snapshot = await evaluateBounded();
    const fresh = snapshot.status !== "hung";
    if (fresh) cache = { at: now(), snapshot };
    return { snapshot, fresh };
  }

  async function handler(_req: Request, res: Response): Promise<void> {
    httpUp.set(1);
    // OBSDB-005: file-backed counters first, so this scrape carries the events
    // that landed since the previous one (the storage gauges sample themselves
    // through collect when the registry renders).
    syncExternalCounters();
    try {
      const { snapshot, fresh } = await snapshotForScrape();
      applyHealth(snapshot, fresh);
    } catch {
      // Rendering metrics must never fail because a probe misbehaved: the
      // status gauge falls back to 0 and the exposition still ships.
      healthStatus.set(HEALTH_STATUS_VALUES.hung);
    }
    res.setHeader("Content-Type", registry.contentType);
    res.end(await registry.metrics());
  }

  return {
    registry,
    handler,
    recordHealth,
    observeRead,
    observeRejection,
    syncExternalCounters,
    render: async () => {
      syncExternalCounters();
      return registry.metrics();
    },
  };
}
