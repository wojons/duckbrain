/**
 * Rate Limiting Middleware
 *
 * Token bucket rate limiter with per-IP tracking.
 * In-memory store with auto-cleanup of stale entries.
 *
 * Default: 100 requests per minute per IP.
 * Configurable via RateLimitConfig.
 */

import { createHash } from "node:crypto";
import { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  /** Maximum requests per minute per IP */
  requestsPerMinute: number;
  /** Burst size: allows temporary spikes above the rate (default: same as requestsPerMinute) */
  burstSize?: number;
  /**
   * HARDEN-DUCKBRAIN-003 (B): the identity a request is throttled against.
   *
   * The bucket used to be keyed on the peer IP alone. On a host where every
   * caller is local — agents, cron, MCP servers, supervisors — that is ONE
   * bucket, so one agent's burst throttled every other agent on the machine
   * (/health was the first casualty, then the Hermes memory provider). The
   * resolver lets the server key on the PRINCIPAL (a credential the auth layer
   * already knows) while leaving anonymous and unrecognized callers on the
   * peer-IP bucket, so credential stuffing and anonymous floods stay bounded.
   *
   * Default: the peer IP — the historical per-IP behavior.
   */
  bucketKeyOf?: (req: Request, ip: string) => string;
  /**
   * HARDEN-DUCKBRAIN-003 (B): upper bound on simultaneously tracked buckets.
   *
   * A principal bucket key is derived from a caller-supplied credential, so an
   * uncapped store would let a client mint buckets without limit and turn the
   * limiter into a memory leak. At the cap the oldest buckets are evicted
   * first: they are the ones closest to fully refilled, so dropping them costs
   * the least accuracy. Eviction does reset an evicted caller's budget, which
   * is the price of a bounded store — the default is far above any plausible
   * live principal count.
   */
  maxBuckets?: number;
  /**
   * OBSDB-002: sink for each REFUSED request (the 429 below).
   *
   * The limiter sits upstream of the read ledger (src/cli/http.ts mounts it
   * before createReadLedgerMiddleware and returns without calling next()), so
   * a throttled request leaves no ledger row and no counter anywhere. This is
   * the only honest place to observe one. It receives the raw method/path —
   * classification into a bounded label happens in the metrics module, never
   * here. It MUST never be able to fail the refusal: the caller guards it and
   * this middleware calls it defensively.
   */
  onReject?: (info: { method: string; path: string }) => void;
}

/**
 * Per-IP rate limit state
 */
interface RateLimitEntry {
  /** Current token count */
  tokens: number;
  /** Timestamp of last token refill */
  lastRefill: number;
}

/**
 * In-memory rate limit store
 *
 * Keyed by BUCKET KEY: `ip:<peer>` for anonymous / unrecognized callers, or
 * `principal:<digest>` for a caller whose credential the server recognizes
 * (HARDEN-DUCKBRAIN-003 (B)). Before that change the key was always the peer
 * IP, which collapsed every local caller into one bucket.
 */
interface RateLimitStore {
  [bucket: string]: RateLimitEntry;
}

// Global store — shared across all middleware instances
const store: RateLimitStore = {};

/**
 * HARDEN-DUCKBRAIN-003 (B): bucket key for a caller we cannot name — the peer
 * address, exactly the pre-existing per-IP behavior.
 */
export function ipBucketKey(ip: string): string {
  return `ip:${ip}`;
}

/**
 * HARDEN-DUCKBRAIN-003 (B): bucket key for a named principal.
 *
 * The credential is hashed, never stored: the limiter keeps no secret material,
 * and rotating a token rotates its bucket for free. Truncated to 128 bits —
 * enough that two live credentials cannot collide.
 */
export function principalBucketKey(credential: string): string {
  const digest = createHash("sha256").update(credential, "utf-8").digest("hex");
  return `principal:${digest.slice(0, 32)}`;
}

// Cleanup interval (every 5 minutes, remove entries older than 10 minutes)
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const ENTRY_MAX_AGE_MS = 10 * 60 * 1000;
// HARDEN-DUCKBRAIN-003 (B): bound on live buckets (see RateLimitConfig.maxBuckets).
const DEFAULT_MAX_BUCKETS = 20_000;
let lastCleanup = Date.now();

/**
 * Remove stale entries from the store
 */
function cleanupStore(): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) {
    return;
  }
  lastCleanup = now;

  for (const ip of Object.keys(store)) {
    if (now - store[ip].lastRefill > ENTRY_MAX_AGE_MS) {
      delete store[ip];
    }
  }
}

/**
 * Bound the store (HARDEN-DUCKBRAIN-003 (B)).
 *
 * Called only when a NEW bucket is about to be created. Stale buckets go first,
 * then the least recently refilled ones — a bucket untouched for longest is the
 * most refilled and therefore the cheapest to forget.
 */
function makeRoom(maxBuckets: number): void {
  if (Object.keys(store).length < maxBuckets) return;
  const now = Date.now();
  for (const key of Object.keys(store)) {
    if (now - store[key].lastRefill > ENTRY_MAX_AGE_MS) {
      delete store[key];
    }
  }
  const remaining = Object.keys(store);
  if (remaining.length < maxBuckets) return;
  remaining.sort((a, b) => store[a].lastRefill - store[b].lastRefill);
  const drop = remaining.length - maxBuckets + 1; // +1 slot for the new bucket
  for (let i = 0; i < drop; i++) {
    delete store[remaining[i]];
  }
}

/**
 * Create rate limiting middleware
 *
 * Uses token bucket algorithm:
 * - Tokens refill at a rate of requestsPerMinute/60000 per millisecond
 * - Each request consumes one token
 * - When tokens are exhausted, returns 429
 *
 * @param config - Rate limit configuration
 * @returns Express middleware
 */
export function rateLimitMiddleware(config: RateLimitConfig): RequestHandler {
  const maxTokens = config.burstSize ?? config.requestsPerMinute;
  const refillRateMs = config.requestsPerMinute / 60000; // tokens per millisecond
  const maxBuckets = config.maxBuckets ?? DEFAULT_MAX_BUCKETS;
  const bucketKeyOf =
    config.bucketKeyOf ?? ((_req: Request, ip: string) => ipBucketKey(ip));

  return (req: Request, res: Response, next: NextFunction): void => {
    cleanupStore();

    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();

    // HARDEN-DUCKBRAIN-003 (B): spend from the request's PRINCIPAL bucket when
    // the server can name one, and from the peer-IP bucket otherwise. A
    // resolver that throws must never fail a request — fall back to the
    // historical per-IP bucket and record why, loudly.
    let bucket: string;
    try {
      bucket = bucketKeyOf(req, ip) || ipBucketKey(ip);
    } catch (error) {
      bucket = ipBucketKey(ip);
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "rate_limit_bucket_resolver_failed",
          detail: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    // Initialize or get entry
    if (!store[bucket]) {
      makeRoom(maxBuckets);
      store[bucket] = {
        tokens: maxTokens,
        lastRefill: now,
      };
    }

    const entry = store[bucket];

    // Refill tokens based on elapsed time
    const elapsed = now - entry.lastRefill;
    const tokensToAdd = elapsed * refillRateMs;
    entry.tokens = Math.min(maxTokens, entry.tokens + tokensToAdd);
    entry.lastRefill = now;

    // Calculate remaining (before consuming)
    const remaining = Math.max(0, Math.floor(entry.tokens) - 1);

    if (entry.tokens >= 1) {
      // Consume a token
      entry.tokens -= 1;

      // Set rate limit headers
      res.setHeader("X-RateLimit-Limit", config.requestsPerMinute);
      res.setHeader("X-RateLimit-Remaining", remaining);

      next();
    } else {
      // Rate limited
      const retryAfterSecs = Math.ceil(
        (1 - entry.tokens) / refillRateMs / 1000,
      );

      res.setHeader("X-RateLimit-Limit", config.requestsPerMinute);
      res.setHeader("X-RateLimit-Remaining", 0);
      res.setHeader("Retry-After", retryAfterSecs);
      // OBSDB-002: one refused request, counted where it is refused. The
      // read ledger runs later in the chain and never sees this request, so
      // without this hook a 429 is unobservable by construction. Guarded: a
      // telemetry sink must never turn a clean 429 into an error path.
      if (config.onReject) {
        try {
          config.onReject({
            method: req.method,
            path: req.originalUrl || req.url || "",
          });
        } catch {
          /* the refusal below must still happen */
        }
      }
      // Structured WARN for every refusal — observability fields only,
      // never request bodies, auth headers, or secrets.
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "rate_limit_refused",
          ip,
          limit: config.requestsPerMinute,
          remaining: 0,
          retryAfter: retryAfterSecs,
        }),
      );
      res
        .status(429)
        .json({ error: "Rate limit exceeded", retryAfter: retryAfterSecs });
    }
  };
}
