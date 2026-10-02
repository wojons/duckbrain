/**
 * DUCKBRAIN-ALLOWED-HOSTS-001 — the DNS-rebinding Host guard must accept
 * operator-declared extra hosts (tailnet address / proxy hostname) without
 * forcing --bind-all, while keeping the loopback-only default unchanged.
 *
 * Two layers are covered:
 *  1. createHttpServer({ allowedHosts }) — the guard itself.
 *  2. handleHttpCommand() — --allowed-hosts flag parsing (repeatable,
 *     comma-separated, port-stripped) and the DUCKBRAIN_ALLOWED_HOSTS env
 *     fallback, asserted through the injected `start` seam.
 */
import http from "http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpServer, handleHttpCommand } from "./http";

const TAILNET = "100.97.236.14";
const PROXY_NAME = "karahermes-mde-7840hs-2";

const openServers: http.Server[] = [];

afterEach(async () => {
  while (openServers.length > 0) {
    const server = openServers.pop();
    if (!server) break;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  delete process.env.DUCKBRAIN_ALLOWED_HOSTS;
});

async function start(options: Parameters<typeof createHttpServer>[0]) {
  const server = http.createServer(createHttpServer(options));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  openServers.push(server);
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("no TCP address");
  return `http://127.0.0.1:${address.port}`;
}

/** Returns the status plus whether the reply is the rebinding-guard denial.
 *
 * Uses node:http rather than fetch(): undici treats Host as a forbidden
 * header and silently drops an explicit override, which would make every
 * probe look like it came from 127.0.0.1 and pass vacuously.
 */
function probe(base: string, hostHeader: string) {
  // A route that matches nothing on purpose: when the Host guard lets the
  // request through, the reply is the fast 404/401, never the (slow,
  // embedding-probing) /health handler.
  const url = new URL(base);
  return new Promise<{ status: number; blockedByHostGuard: boolean }>(
    (resolve, reject) => {
      const req = http.request(
        {
          host: url.hostname,
          port: url.port,
          path: "/__host-guard-probe__",
          method: "GET",
          headers: { Host: hostHeader },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              blockedByHostGuard:
                res.statusCode === 403 && body.includes("Invalid host"),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    },
  );
}

describe("dns-rebinding Host guard (DUCKBRAIN-ALLOWED-HOSTS-001)", () => {
  it("defaults to loopback only — a tailnet Host is rejected", async () => {
    const base = await start({ rateLimit: 1000 });
    expect(await probe(base, "localhost")).toEqual({
      status: expect.any(Number),
      blockedByHostGuard: false,
    });
    expect(await probe(base, TAILNET)).toEqual({
      status: 403,
      blockedByHostGuard: true,
    });
  });

  it("accepts an explicitly allowed tailnet host (and keeps rejecting others)", async () => {
    const base = await start({ rateLimit: 1000, allowedHosts: [TAILNET] });
    expect((await probe(base, TAILNET)).blockedByHostGuard).toBe(false);
    expect((await probe(base, PROXY_NAME)).blockedByHostGuard).toBe(true);
  });

  it("strips ports from allowed entries and incoming Host values", async () => {
    const base = await start({
      rateLimit: 1000,
      allowedHosts: [`${TAILNET}:3001`],
    });
    expect((await probe(base, `${TAILNET}:3001`)).blockedByHostGuard).toBe(
      false,
    );
    expect((await probe(base, TAILNET)).blockedByHostGuard).toBe(false);
  });

  it("accepts a proxy hostname entry", async () => {
    const base = await start({ rateLimit: 1000, allowedHosts: [PROXY_NAME] });
    expect((await probe(base, PROXY_NAME)).blockedByHostGuard).toBe(false);
  });

  it("CLI collects --allowed-hosts values (repeatable + comma-separated)", async () => {
    const startSpy = vi.fn(async () => {});
    await handleHttpCommand(
      [
        "--allowed-hosts",
        `${TAILNET},${PROXY_NAME}`,
        `--allowed-hosts=extra.example.ts.net:3001`,
      ],
      { start: startSpy },
    );
    expect(startSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedHosts: [TAILNET, PROXY_NAME, "extra.example.ts.net"],
      }),
    );
  });

  it("CLI falls back to DUCKBRAIN_ALLOWED_HOSTS only when the flag is absent", async () => {
    process.env.DUCKBRAIN_ALLOWED_HOSTS = `${TAILNET}, from-env.example`;
    const envSpy = vi.fn(async () => {});
    await handleHttpCommand([], { start: envSpy });
    expect(envSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedHosts: [TAILNET, "from-env.example"],
      }),
    );

    const flagSpy = vi.fn(async () => {});
    await handleHttpCommand([`--allowed-hosts=${PROXY_NAME}`], {
      start: flagSpy,
    });
    expect(flagSpy).toHaveBeenCalledWith(
      expect.objectContaining({ allowedHosts: [PROXY_NAME] }),
    );
  });

  it("CLI omits allowedHosts entirely when neither flag nor env is set", async () => {
    const startSpy = vi.fn(async () => {});
    await handleHttpCommand([], { start: startSpy });
    expect(startSpy).toHaveBeenCalledWith(
      expect.not.objectContaining({ allowedHosts: expect.anything() }),
    );
  });
});
