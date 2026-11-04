import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ChildProcess } from "child_process";
import {
  getRandomPort,
  startDuckbrainHttp,
  killProcess,
  waitForUrl,
  curl,
  DAEMON_READY_TIMEOUT_MS,
} from "./helpers";

const port = getRandomPort();
let server: ChildProcess;

describe("Rate Limiting Integration", () => {
  beforeAll(async () => {
    server = await startDuckbrainHttp({ port, rateLimit: 5 });
    // INT-CI-002: hardened wait (30s + child stderr tail on timeout).
    // INT-CI-003: 60s via shared constant — the 3rd flake was this suite
    // (run 32071985468) with the daemon's "started" line landing AT 30s.
    await waitForUrl(
      `http://127.0.0.1:${port}/health`,
      DAEMON_READY_TIMEOUT_MS,
      server,
    );
    // INT-CI-003: hook timeout must exceed the 60s daemon wait or vitest
    // fails the hook BEFORE waitForUrl's cap (masking the stderr tail).
  }, 120000);

  afterAll(() => {
    killProcess(server);
  });

  // NOTE (HARDEN-DUCKBRAIN-003): these tests used /health as the cheapest URL
  // to hammer. /health is now EXEMPT from the limiter on purpose — a liveness
  // probe that can be throttled reports a healthy daemon as dead (that is how
  // the Hermes memory provider went dark on 2026-11-03). The limiter is
  // therefore exercised on a rate-limited route instead, and an unauthenticated
  // 401 is a perfectly good "under the limit" answer: the limiter runs BEFORE
  // auth, which is exactly why its headers appear on the 401 too.
  const LIMITED_URL = () => `http://127.0.0.1:${port}/api/namespaces`;

  it("should allow requests under the limit", async () => {
    const res = await curl(LIMITED_URL());
    expect([200, 401, 503]).toContain(res.status);
  });

  it("should return 429 after exceeding rate limit", async () => {
    let got429 = false;
    for (let i = 0; i < 15; i++) {
      const res = await curl(LIMITED_URL());
      if (res.status === 429) {
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);
  });

  it("should include X-RateLimit-Limit header on successful requests", async () => {
    const rateLimitPort = getRandomPort();
    const rlServer = await startDuckbrainHttp({
      port: rateLimitPort,
      rateLimit: 100,
    });
    try {
      await waitForUrl(
        `http://127.0.0.1:${rateLimitPort}/health`,
        DAEMON_READY_TIMEOUT_MS,
        rlServer,
      );
      const res = await curl(`http://127.0.0.1:${rateLimitPort}/api/namespaces`);
      // GAP-030: accept 503 (degraded); 401 is expected when the daemon wants
      // a key — the limiter ran first and stamped its headers regardless.
      expect([200, 401, 503]).toContain(res.status);
      // TESTQ-2026-11-02-1: assert the VALUE, not merely that the header
      // exists. A port squatter would answer with ITS configured limit (the
      // CI failure carried `X-RateLimit-Limit: 5` from a different daemon), so
      // pinning 100 turns "measuring the wrong server" into an explicit red.
      expect(res.headers).toMatch(/X-RateLimit-Limit:\s*100/i);
    } finally {
      killProcess(rlServer);
    }
  });
});
