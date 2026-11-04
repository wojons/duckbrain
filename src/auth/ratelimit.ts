/**
 * Rate Limiting Middleware
 *
 * Token bucket rate limiter with per-IP tracking.
 * In-memory store with auto-cleanup of stale entries.
 *
 * Default: 100 requests per minute per IP.
 * Configurable via RateLimitConfig.
 */

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
 * Keyed by IP address
 */
interface RateLimitStore {
  [ip: string]: RateLimitEntry;
}

// Global store — shared across all middleware instances
const store: RateLimitStore = {};

// Cleanup interval (every 5 minutes, remove entries older than 10 minutes)
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const ENTRY_MAX_AGE_MS = 10 * 60 * 1000;
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

  return (req: Request, res: Response, next: NextFunction): void => {
    cleanupStore();

    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();

    // Initialize or get entry
    if (!store[ip]) {
      store[ip] = {
        tokens: maxTokens,
        lastRefill: now,
      };
    }

    const entry = store[ip];

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
