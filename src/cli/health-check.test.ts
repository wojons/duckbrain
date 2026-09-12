/**
 * OPS-001 tests: dark-port health check with the embedding-health liveness
 * contract — HTTP 200 OR 503 counts as ALIVE (503 degraded is an
 * intentional DuckBrain state), connection failure or any other status is
 * DARK. Fully hermetic: the transport is injected, no test opens a socket,
 * and no API keys are involved (/health is auth-exempt).
 */

import { describe, it, expect } from "vitest";
import net from "net";
import type { AddressInfo } from "net";
import { spawnSync } from "child_process";
import {
  ALIVE_STATUSES,
  checkHttpHealth,
  parseHealthCheckArgs,
  runHealthCheckCli,
  httpFetcher,
  isRequestTimeout,
  HUNG_EXIT_CODE,
  type HealthFetcher,
} from "./health-check";

describe("ALIVE_STATUSES contract", () => {
  it("accepts exactly 200 and 503", () => {
    expect([...ALIVE_STATUSES].sort((a, b) => a - b)).toEqual([200, 503]);
  });
});

describe("checkHttpHealth — the 200/503-alive contract", () => {
  const url = "http://127.0.0.1:3000/health";

  it("200 → alive", async () => {
    const fetcher: HealthFetcher = async () => ({ status: 200 });
    const result = await checkHttpHealth(url, fetcher);
    expect(result.status).toBe("alive");
    expect(result.httpStatus).toBe(200);
  });

  it("503 → alive (degraded is intentional, not dark)", async () => {
    const fetcher: HealthFetcher = async () => ({ status: 503 });
    const result = await checkHttpHealth(url, fetcher);
    expect(result.status).toBe("alive");
    expect(result.httpStatus).toBe(503);
    expect(result.detail).toContain("degraded");
  });

  it("connection refused → dark, and the check never throws", async () => {
    const fetcher: HealthFetcher = async () => {
      const error = new Error(
        "connect ECONNREFUSED 127.0.0.1:3000",
      ) as NodeJS.ErrnoException;
      error.code = "ECONNREFUSED";
      throw error;
    };
    const result = await checkHttpHealth(url, fetcher);
    expect(result.status).toBe("dark");
    expect(result.httpStatus).toBeNull();
    expect(result.detail).toContain("ECONNREFUSED");
  });

  it("our own timeout with no answer → HUNG (reachable but not answering)", async () => {
    const fetcher: HealthFetcher = async (_url, timeoutMs) => {
      throw new Error(
        `The operation was aborted due to timeout of ${timeoutMs}ms`,
      );
    };
    const result = await checkHttpHealth(url, fetcher, 1_234);
    expect(result.status).toBe("hung");
    expect(result.httpStatus).toBeNull();
    expect(result.detail).toContain("1234ms");
  });

  it("a Node AbortSignal.timeout TimeoutError → HUNG", async () => {
    const fetcher: HealthFetcher = async () => {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    };
    const result = await checkHttpHealth(url, fetcher, 500);
    expect(result.status).toBe("hung");
  });

  it("a connect-phase ETIMEDOUT is UNREACHABLE (dark), not hung", async () => {
    const fetcher: HealthFetcher = async () => {
      const error = new Error(
        "connect ETIMEDOUT 10.0.0.9:3000",
      ) as NodeJS.ErrnoException;
      error.code = "ETIMEDOUT";
      throw error;
    };
    const result = await checkHttpHealth(url, fetcher, 500);
    expect(result.status).toBe("dark");
  });

  it("a wrapped fetch failure with a timeout cause → HUNG", async () => {
    const fetcher: HealthFetcher = async () => {
      const cause = new Error("The operation was aborted due to timeout");
      cause.name = "TimeoutError";
      throw new Error("fetch failed", { cause });
    };
    const result = await checkHttpHealth(url, fetcher, 900);
    expect(result.status).toBe("hung");
  });

  it("unexpected status (squatter 404, proxy 401, 500) → dark", async () => {
    for (const status of [204, 301, 401, 404, 500]) {
      const fetcher: HealthFetcher = async () => ({ status });
      const result = await checkHttpHealth(url, fetcher);
      expect(result.status).toBe("dark");
      expect(result.httpStatus).toBe(status);
    }
  });

  it("passes the timeout through to the transport", async () => {
    let seen: number | null = null;
    const fetcher: HealthFetcher = async (_url, timeoutMs) => {
      seen = timeoutMs;
      return { status: 200 };
    };
    await checkHttpHealth(url, fetcher, 7_777);
    expect(seen).toBe(7_777);
  });
});

describe("parseHealthCheckArgs", () => {
  it("defaults to the production port 3000 /health URL", () => {
    const parsed = parseHealthCheckArgs([]);
    expect(parsed.url).toBe("http://127.0.0.1:3000/health");
    expect(parsed.error).toBeUndefined();
  });

  it("parses --url and --timeout-ms in both forms", () => {
    expect(
      parseHealthCheckArgs(["--url=http://127.0.0.1:4777/health"]).url,
    ).toBe("http://127.0.0.1:4777/health");
    expect(
      parseHealthCheckArgs(["--url", "http://127.0.0.1:4778/health"]).url,
    ).toBe("http://127.0.0.1:4778/health");
    expect(parseHealthCheckArgs(["--timeout-ms=2500"]).timeoutMs).toBe(2500);
    expect(parseHealthCheckArgs(["--timeout-ms", "2600"]).timeoutMs).toBe(2600);
  });

  it("rejects non-http URLs, bad timeouts, and unknown flags", () => {
    expect(parseHealthCheckArgs(["--url=ftp://x"]).error).toBeDefined();
    expect(parseHealthCheckArgs(["--url=/health"]).error).toBeDefined();
    expect(parseHealthCheckArgs(["--url"]).error).toBeDefined();
    expect(parseHealthCheckArgs(["--timeout-ms=0"]).error).toBeDefined();
    expect(parseHealthCheckArgs(["--timeout-ms=x"]).error).toBeDefined();
    expect(parseHealthCheckArgs(["--nope"]).error).toBeDefined();
  });
});

describe("isRequestTimeout (OPS-002 hung/dark split)", () => {
  it("classifies our own abort as a timeout", () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    expect(isRequestTimeout(timeout)).toBe(true);
    expect(
      isRequestTimeout(
        new Error("The operation was aborted due to timeout of 5000ms"),
      ),
    ).toBe(true);
    const abort = new Error("This operation was aborted");
    abort.name = "AbortError";
    expect(isRequestTimeout(abort)).toBe(true);
  });

  it("classifies connection failures as NOT timeouts (dark)", () => {
    const refused = new Error(
      "connect ECONNREFUSED 127.0.0.1:3000",
    ) as NodeJS.ErrnoException;
    refused.code = "ECONNREFUSED";
    expect(isRequestTimeout(refused)).toBe(false);
    const connectTimeout = new Error(
      "connect ETIMEDOUT",
    ) as NodeJS.ErrnoException;
    connectTimeout.code = "ETIMEDOUT";
    expect(isRequestTimeout(connectTimeout)).toBe(false);
    expect(isRequestTimeout(new Error("socket hang up"))).toBe(false);
    expect(isRequestTimeout(undefined)).toBe(false);
  });
});

describe("runHealthCheckCli (exit-code contract)", () => {
  it("exit 0 alive / 1 dark / 3 hung / 2 usage error / 0 help", async () => {
    const ok: HealthFetcher = async () => ({ status: 503 });
    const dark: HealthFetcher = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    // OPS-002: the hang gets its OWN code so a restart-on-dark escalation can
    // never restart-loop a daemon that is still serving traffic.
    const hung: HealthFetcher = async (_url, timeoutMs) => {
      throw new Error(
        `The operation was aborted due to timeout of ${timeoutMs}ms`,
      );
    };

    expect(await runHealthCheckCli([], ok)).toBe(0);
    expect(await runHealthCheckCli([], dark)).toBe(1);
    expect(await runHealthCheckCli([], hung)).toBe(HUNG_EXIT_CODE);
    expect(HUNG_EXIT_CODE).not.toBe(1);
    expect(await runHealthCheckCli(["--bogus"], ok)).toBe(2);
    expect(await runHealthCheckCli(["--help"], dark)).toBe(0);
  });
});

describe("httpFetcher (production transport shape)", () => {
  it("is a function taking (url, timeoutMs) — real fetch wired at call time", () => {
    expect(typeof httpFetcher).toBe("function");
    expect(httpFetcher.length).toBe(2);
  });
});

describe("scripts/health-check.js end-to-end (OPS-002 hung exit code)", () => {
  it("a socket that accepts but never answers yields exit 3 (hung), not 1 (dark)", async () => {
    // Ephemeral port on loopback; no prod daemon, no fixed port. The socket
    // accepts the TCP connection and never writes a byte — exactly the live
    // shape of a daemon whose /health handler is parked.
    const server = net.createServer(() => {
      /* accept and stay silent */
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const port = (server.address() as AddressInfo).port;

    try {
      const result = spawnSync(
        process.execPath,
        [
          "scripts/health-check.js",
          `--url=http://127.0.0.1:${port}/health`,
          "--timeout-ms=400",
        ],
        { cwd: process.cwd(), encoding: "utf-8", timeout: 30_000 },
      );

      expect(result.status).toBe(HUNG_EXIT_CODE);
      expect(result.stderr).toMatch(/HUNG/);
      expect(result.stderr).toMatch(/reachable but \/health did not answer/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 40_000);
});
