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

  it("should allow requests under the limit", async () => {
    const res = await curl(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
  });

  it("should return 429 after exceeding rate limit", async () => {
    let got429 = false;
    for (let i = 0; i < 15; i++) {
      const res = await curl(`http://127.0.0.1:${port}/health`);
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
      const res = await curl(`http://127.0.0.1:${rateLimitPort}/health`);
      expect(res.status).toBe(200);
      expect(res.headers).toMatch(/X-RateLimit-Limit/i);
    } finally {
      killProcess(rlServer);
    }
  });
});
