/**
 * A liveness probe that can be throttled is not a probe.
 *
 * The rate limiter is a per-IP token bucket, and every caller of this daemon is
 * local — agents, cron, MCP servers, supervisors — so 127.0.0.1 is one shared
 * bucket. Observed live 2026-11-03 on the production daemon: 2 of 10 sequential
 * `/health` probes returned 429 while the process was perfectly healthy. The
 * Hermes memory provider's liveness check requires 200, so it flipped to
 * "unavailable" and silently disabled external memory for the whole session.
 *
 * These tests pin both halves: liveness and the metrics surface never throttle,
 * and everything else still does (so the exemption is a real exemption, not a
 * disabled limiter).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { createHttpServer } from "./http";

let server: http.Server;
let port = 0;
let scratchDir = "";
const RATE_LIMIT = 2;

function request(
  reqPath: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: reqPath, method: "GET", headers },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-health-rl-"));
  const app = createHttpServer({
    authConfig: { type: "none" },
    namespacesPath: scratchDir,
    rateLimit: RATE_LIMIT,
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr !== "string") port = addr.port;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (scratchDir) fs.rmSync(scratchDir, { recursive: true, force: true });
});

describe("liveness is not throttled (ratelimit 2/min shares the loopback bucket)", () => {
  it("never 429s /health, however many probes arrive", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      const res = await request("/health");
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 429)).toEqual([]);
    // 200 healthy / 503 degraded are both a real answer; neither is throttling.
    expect(statuses.every((s) => s === 200 || s === 503)).toBe(true);
  });

  it("never 429s /metrics either — a scrape that throttles is useless", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await request("/metrics")).status);
    expect(statuses.filter((s) => s === 429)).toEqual([]);
    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  it("still 429s everything else — the limiter is exempting two routes, not sleepwalking", async () => {
    // The bucket was already drained by the probes above if those shared it; the
    // falsifier is that a normal API route hits the cap at all.
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      statuses.push((await request("/stats")).status);
    }
    expect(statuses).toContain(429);
  });

  it("the 429 carries Retry-After, so a caller can behave", async () => {
    const res = await new Promise<{ status: number; retryAfter?: string }>(
      (resolve, reject) => {
        const req = http.request(
          { hostname: "127.0.0.1", port, path: "/stats", method: "GET" },
          (r) => {
            let data = "";
            r.on("data", (c) => (data += c.toString()));
            r.on("end", () =>
              resolve({
                status: r.statusCode ?? 0,
                retryAfter: r.headers["retry-after"] as string | undefined,
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
    expect(res.status).toBe(429);
    expect(res.retryAfter).toBeDefined();
  });
});
