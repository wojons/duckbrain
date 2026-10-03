/**
 * Rate Limiting Middleware Tests
 *
 * Tests for token bucket rate limiter with per-IP tracking.
 */

import { describe, it, expect, vi } from "vitest";
import { rateLimitMiddleware, RateLimitConfig } from "./ratelimit.js";
import { Request, Response, NextFunction } from "express";

// Helper to create mock request/response/next
function mockReq(overrides: Record<string, any> = {}): Partial<Request> {
  return {
    path: "/",
    headers: {},
    ip: "127.0.0.1",
    ...overrides,
  } as Partial<Request>;
}

function mockRes(): {
  res: Partial<Response>;
  json: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn().mockReturnThis();
  const status = vi.fn().mockReturnValue({ json });
  const setHeader = vi.fn();
  return {
    res: {
      status,
      json,
      setHeader,
    } as Partial<Response>,
    json,
    status,
    setHeader,
  };
}

function mockNext(): NextFunction {
  return vi.fn();
}

describe("rateLimitMiddleware", () => {
  it("should allow requests within limit", () => {
    const config: RateLimitConfig = { requestsPerMinute: 100 };
    const middleware = rateLimitMiddleware(config);

    const req = mockReq({ ip: "10.0.0.1" });
    const { res } = mockRes();
    const next = mockNext();

    middleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
  });

  it("should return 429 when rate limit is exceeded", () => {
    const config: RateLimitConfig = { requestsPerMinute: 2 };
    const middleware = rateLimitMiddleware(config);

    // First 2 requests should pass
    for (let i = 0; i < 2; i++) {
      const req = mockReq({ ip: "10.0.0.2" });
      const { res } = mockRes();
      const next = mockNext();
      middleware(req as Request, res as Response, next);
      expect(next).toHaveBeenCalled();
    }

    // Third request should be rate limited
    const req = mockReq({ ip: "10.0.0.2" });
    const { res, status } = mockRes();
    const next = mockNext();
    middleware(req as Request, res as Response, next);

    expect(status).toHaveBeenCalledWith(429);
    expect(next).not.toHaveBeenCalled();
  });

  it("should track rate limits per IP independently", () => {
    const config: RateLimitConfig = { requestsPerMinute: 1 };
    const middleware = rateLimitMiddleware(config);

    // IP 1: first request passes
    const req1 = mockReq({ ip: "10.0.0.10" });
    const { res: res1 } = mockRes();
    const next1 = mockNext();
    middleware(req1 as Request, res1 as Response, next1);
    expect(next1).toHaveBeenCalled();

    // IP 1: second request blocked
    const req2 = mockReq({ ip: "10.0.0.10" });
    const { res: res2, status: status2 } = mockRes();
    const next2 = mockNext();
    middleware(req2 as Request, res2 as Response, next2);
    expect(status2).toHaveBeenCalledWith(429);

    // IP 2: first request passes (different IP)
    const req3 = mockReq({ ip: "10.0.0.20" });
    const { res: res3 } = mockRes();
    const next3 = mockNext();
    middleware(req3 as Request, res3 as Response, next3);
    expect(next3).toHaveBeenCalled();
  });

  it("should set rate limit headers on responses", () => {
    const config: RateLimitConfig = { requestsPerMinute: 100 };
    const middleware = rateLimitMiddleware(config);

    const req = mockReq({ ip: "10.0.0.3" });
    const { res, setHeader } = mockRes();
    const next = mockNext();

    middleware(req as Request, res as Response, next);

    expect(setHeader).toHaveBeenCalledWith(
      "X-RateLimit-Limit",
      expect.any(Number),
    );
    expect(setHeader).toHaveBeenCalledWith(
      "X-RateLimit-Remaining",
      expect.any(Number),
    );
  });

  it("should set Retry-After header when rate limited", () => {
    const config: RateLimitConfig = { requestsPerMinute: 1 };
    const middleware = rateLimitMiddleware(config);

    // Use up the limit
    const req1 = mockReq({ ip: "10.0.0.4" });
    const { res: res1 } = mockRes();
    middleware(req1 as Request, res1 as Response, mockNext());

    // Trigger rate limit
    const req2 = mockReq({ ip: "10.0.0.4" });
    const { res: res2, setHeader } = mockRes();
    middleware(req2 as Request, res2 as Response, mockNext());

    expect(setHeader).toHaveBeenCalledWith("Retry-After", expect.any(Number));
  });

  it("should use default 100 req/min when no config provided", () => {
    const config: RateLimitConfig = { requestsPerMinute: 100 };
    const middleware = rateLimitMiddleware(config);

    // Should allow 100 requests
    for (let i = 0; i < 100; i++) {
      const req = mockReq({ ip: "10.0.0.5" });
      const { res } = mockRes();
      const next = mockNext();
      middleware(req as Request, res as Response, next);
      expect(next).toHaveBeenCalled();
    }

    // 101st should be blocked
    const req = mockReq({ ip: "10.0.0.5" });
    const { res, status } = mockRes();
    const next = mockNext();
    middleware(req as Request, res as Response, next);
    expect(status).toHaveBeenCalledWith(429);
  });
});

describe("rateLimitMiddleware 429 observability", () => {
  it("should emit a structured WARN log with refusal fields on 429", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const config: RateLimitConfig = { requestsPerMinute: 1 };
      const middleware = rateLimitMiddleware(config);

      // First (allowed) request must not log
      middleware(
        mockReq({ ip: "10.0.1.1" }) as Request,
        mockRes().res as Response,
        mockNext(),
      );
      expect(warnSpy).not.toHaveBeenCalled();

      // Second (refused) request: 429 + one structured WARN
      const { res, status, setHeader } = mockRes();
      middleware(
        mockReq({ ip: "10.0.1.1" }) as Request,
        res as Response,
        mockNext(),
      );

      expect(status).toHaveBeenCalledWith(429);
      expect(warnSpy).toHaveBeenCalledTimes(1);

      const raw = String(warnSpy.mock.calls[0][0]);
      const entry = JSON.parse(raw);
      expect(entry).toMatchObject({
        level: "warn",
        event: "rate_limit_refused",
        ip: "10.0.1.1",
        limit: 1,
        remaining: 0,
      });
      expect(typeof entry.retryAfter).toBe("number");
      expect(entry.retryAfter).toBeGreaterThan(0);

      // Logged retryAfter must match the Retry-After header sent to the client
      const retryHeader = setHeader.mock.calls.find(
        (call: any[]) => call[0] === "Retry-After",
      );
      expect(retryHeader).toBeDefined();
      expect(entry.retryAfter).toBe(retryHeader![1]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("should log every refused request, not just the first refusal", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const config: RateLimitConfig = { requestsPerMinute: 1 };
      const middleware = rateLimitMiddleware(config);

      middleware(
        mockReq({ ip: "10.0.1.2" }) as Request,
        mockRes().res as Response,
        mockNext(),
      );

      for (let i = 0; i < 2; i++) {
        const { res, status } = mockRes();
        middleware(
          mockReq({ ip: "10.0.1.2" }) as Request,
          res as Response,
          mockNext(),
        );
        expect(status).toHaveBeenCalledWith(429);
      }

      expect(warnSpy).toHaveBeenCalledTimes(2);
      for (const call of warnSpy.mock.calls) {
        const entry = JSON.parse(String(call[0]));
        expect(entry.event).toBe("rate_limit_refused");
        expect(entry.ip).toBe("10.0.1.2");
        expect(entry.remaining).toBe(0);
      }
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("should never log credentials, auth headers, or request bodies", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const config: RateLimitConfig = { requestsPerMinute: 1 };
      const middleware = rateLimitMiddleware(config);

      middleware(
        mockReq({ ip: "10.0.1.3" }) as Request,
        mockRes().res as Response,
        mockNext(),
      );

      const { res, status } = mockRes();
      middleware(
        mockReq({
          ip: "10.0.1.3",
          headers: { authorization: "Bearer super-secret-token-abc123" },
          body: { content: "body-secret-value" },
        }) as Request,
        res as Response,
        mockNext(),
      );

      // The refusal must actually log (non-vacuous absence assertion)
      expect(status).toHaveBeenCalledWith(429);
      expect(warnSpy).toHaveBeenCalledTimes(1);

      const raw = String(warnSpy.mock.calls[0][0]);
      expect(raw).not.toContain("super-secret-token-abc123");
      expect(raw).not.toContain("Bearer");
      expect(raw).not.toContain("authorization");
      expect(raw).not.toContain("body-secret-value");
      expect(raw).not.toContain("body");
    } finally {
      warnSpy.mockRestore();
    }
  });
});
