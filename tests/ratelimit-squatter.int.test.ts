/**
 * TESTQ-2026-11-02-1 — the port-squatter trap.
 *
 * CI run 41453591399 failed `should include X-RateLimit-Limit header on
 * successful requests` with `expected [ 200, 503 ] to include 429`: a daemon
 * started with `--rate-limit=100` answered 429 to its first request.
 *
 * Root cause is not the limiter. `getRandomPort()` drew a port that a
 * still-running sibling daemon already owned, the new child died with
 * EADDRINUSE, `waitForUrl()` was answered by the SQUATTER (which is why the
 * reply carried `X-RateLimit-Limit: 5`), and the test then asserted against a
 * daemon it never started. Every integration suite runs in parallel inside the
 * same 21000-29999 window and `killProcess()` is a fire-and-forget SIGTERM, so
 * the collision is a matter of when.
 *
 * These tests pin the two harness guarantees that make that failure
 * impossible to misread again:
 *   1. `getRandomPort()` never hands out a port that something is listening on.
 *   2. `waitForUrl()` refuses to report readiness for a child that never bound.
 */
import { describe, it, expect, vi } from "vitest";
import { createServer, Server } from "net";
import { ChildProcess } from "child_process";
import {
  getRandomPort,
  isPortFree,
  startDuckbrainHttp,
  killProcess,
  waitForUrl,
  DAEMON_READY_TIMEOUT_MS,
} from "./helpers";

function listenOn(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => resolve(s));
  });
}

describe("port allocation cannot attach tests to a foreign daemon", () => {
  it("isPortFree() reports a bound port as taken and a released one as free", async () => {
    const port = getRandomPort();
    const server = await listenOn(port);
    try {
      expect(isPortFree(port)).toBe(false);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    expect(isPortFree(port)).toBe(true);
  });

  it("getRandomPort() never returns a port that is already listening", async () => {
    // Deterministic: force the first draw onto a port we hold, then let every
    // later draw land on a free one. A naive draw returns the held port (red);
    // the checked draw skips it and returns something free (green).
    const held = getRandomPort();
    const server = await listenOn(held);
    const free = getRandomPort();
    const rOf = (p: number) => (p - 21000 + 0.5) / 9000;
    const spy = vi.spyOn(Math, "random");
    try {
      expect(isPortFree(held)).toBe(false);
      expect(isPortFree(free)).toBe(true);
      spy.mockReturnValueOnce(rOf(held)).mockReturnValue(rOf(free));
      expect(getRandomPort()).toBe(free);
    } finally {
      spy.mockRestore();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("waitForUrl() refuses a child that could not bind, instead of reading the squatter", async () => {
    // Daemon A owns the port and is drained — exactly the CI shape.
    const port = getRandomPort();
    const a: ChildProcess = await startDuckbrainHttp({ port, rateLimit: 5 });
    let b: ChildProcess | undefined;
    try {
      await waitForUrl(
        `http://127.0.0.1:${port}/health`,
        DAEMON_READY_TIMEOUT_MS,
        a,
      );
      for (let i = 0; i < 15; i++) {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.status === 429) break;
      }

      // Daemon B asks for the SAME port with a generous limit.
      b = await startDuckbrainHttp({ port, rateLimit: 100 });

      // Before the fix this resolved (the squatter answers 200/503) and the
      // suite then measured daemon A. Now it must reject with the reason.
      await expect(
        waitForUrl(
          `http://127.0.0.1:${port}/health`,
          DAEMON_READY_TIMEOUT_MS,
          b,
        ),
      ).rejects.toThrow(/EADDRINUSE|never bound|already exited/i);
    } finally {
      killProcess(a);
      if (b) killProcess(b);
    }
  }, 180000);
});
