/**
 * OPS-002 regression tests: GET /health can never hang.
 *
 * The live incident: the production daemon kept serving /stats and /api/* in
 * milliseconds while /health never answered at all — no bytes, ever — because
 * a sub-probe awaited a promise that never settled. The handler had NO outer
 * deadline, so the request stayed parked until the process was restarted, and
 * the dark-port watchdog reported DARK for a daemon that was serving traffic.
 *
 * These tests are hermetic: the probes are injected (no server, no ports, no
 * DuckDB, no embedding provider, no network) and the deadline is injected so
 * "never settles" is provable in milliseconds instead of minutes.
 *
 * Contract under test:
 *   - the handler ALWAYS answers within the deadline, on every path;
 *   - a sub-probe that misses it yields HTTP 503 + status "degraded";
 *   - `deadline_exceeded` names the culprit ("embedding" / "keys") and the
 *     section's own note says why;
 *   - normal probes keep the DOGFOOD-020 / DB-GAP-035 / GAP-030 contract
 *     (healthy → 200, unhealthy → 503, keys failure → 503 + keys_error);
 *   - an abandoned probe that rejects late cannot surface as an unhandled
 *     rejection.
 */

import { describe, it, expect } from "vitest";
import { createHealthHandler, HEALTH_HANDLER_DEADLINE_MS } from "./http";

/** Minimal express Response double — the handler calls res.status() + res.json(). */
function fakeRes() {
  const captured: { body: any; statusCode: number } = {
    body: null,
    statusCode: 200,
  };
  const res: any = {
    status(code: number) {
      captured.statusCode = code;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
      return res;
    },
  };
  return { res, captured };
}

const healthyEmbedding = {
  provider: "lmstudio",
  model: "text-embedding-qwen3-embedding-0.6b",
  healthy: true,
  providers: [{ id: "lmstudio", healthy: true, note: "ok" }],
};

/** A promise that never settles — the shape of the live defect. */
const never = <T>(): Promise<T> => new Promise<T>(() => {});

/** Small deadline so a "hung probe" test costs milliseconds, not seconds. */
const TEST_DEADLINE_MS = 60;

describe("OPS-002: HEALTH_HANDLER_DEADLINE_MS", () => {
  it("defaults to a bounded 4000ms budget", () => {
    expect(HEALTH_HANDLER_DEADLINE_MS).toBe(4_000);
  });
});

describe("OPS-002: /health always answers within the deadline", () => {
  it("a NEVER-settling embedding probe → 503 degraded naming the embedding probe", async () => {
    const handler = createHealthHandler(
      () => never(),
      async () => null,
      undefined,
      TEST_DEADLINE_MS,
    );
    const { res, captured } = fakeRes();

    const started = Date.now();
    await handler({} as any, res as any);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(TEST_DEADLINE_MS + 1_000);
    expect(captured.statusCode).toBe(503);
    expect(captured.body.status).toBe("degraded");
    expect(captured.body.deadline_exceeded).toContain("embedding");
    expect(captured.body.embedding.healthy).toBe(false);
    expect(captured.body.embedding.providers[0].note).toContain(
      `${TEST_DEADLINE_MS}ms /health deadline`,
    );
  });

  it("a NEVER-settling keys probe → 503 degraded naming the keys probe (embedding preserved)", async () => {
    const handler = createHealthHandler(
      async () => healthyEmbedding,
      () => never(),
      undefined,
      TEST_DEADLINE_MS,
    );
    const { res, captured } = fakeRes();

    const started = Date.now();
    await handler({} as any, res as any);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(TEST_DEADLINE_MS + 1_000);
    expect(captured.statusCode).toBe(503);
    expect(captured.body.status).toBe("degraded");
    expect(captured.body.deadline_exceeded).toEqual(["keys"]);
    expect(captured.body.keys_error).toContain(
      `${TEST_DEADLINE_MS}ms /health deadline`,
    );
    // The probe that DID answer keeps its real answer.
    expect(captured.body.embedding).toEqual(healthyEmbedding);
  });

  it("BOTH probes hung → still answers inside the deadline (no stacked budgets)", async () => {
    const handler = createHealthHandler(
      () => never(),
      () => never(),
      undefined,
      TEST_DEADLINE_MS,
    );
    const { res, captured } = fakeRes();

    const started = Date.now();
    await handler({} as any, res as any);
    const elapsed = Date.now() - started;

    // One shared budget: two hung probes must not add up to 2× the deadline.
    expect(elapsed).toBeLessThan(TEST_DEADLINE_MS + 1_000);
    expect(captured.statusCode).toBe(503);
    expect(captured.body.deadline_exceeded).toEqual(
      expect.arrayContaining(["embedding", "keys"]),
    );
  });

  it("the durability probe stays synchronous — it can never miss a deadline", async () => {
    const handler = createHealthHandler(
      async () => healthyEmbedding,
      async () => null,
      () => ({ defaultMode: "buffered", overrides: { nsA: "fsync" } }),
      TEST_DEADLINE_MS,
    );
    const { res, captured } = fakeRes();

    await handler({} as any, res as any);

    expect(captured.statusCode).toBe(200);
    expect(captured.body.durability).toEqual({
      defaultMode: "buffered",
      overrides: { nsA: "fsync" },
    });
    expect(captured.body.deadline_exceeded).toEqual([]);
  });
});

describe("OPS-002: the pre-existing contract is unchanged when probes answer", () => {
  it("healthy probes → 200 healthy, empty deadline_exceeded", async () => {
    const handler = createHealthHandler(
      async () => healthyEmbedding,
      async () => null,
      undefined,
      TEST_DEADLINE_MS,
    );
    const { res, captured } = fakeRes();

    await handler({} as any, res as any);

    expect(captured.statusCode).toBe(200);
    expect(captured.body.status).toBe("healthy");
    expect(captured.body.keys_error).toBeNull();
    expect(captured.body.deadline_exceeded).toEqual([]);
  });

  it("unhealthy embedding → 503 degraded (GAP-030), not a deadline report", async () => {
    const handler = createHealthHandler(
      async () => ({
        provider: "",
        model: "m",
        healthy: false,
        providers: [{ id: "lmstudio", healthy: false, note: "unreachable" }],
      }),
      async () => null,
      undefined,
      TEST_DEADLINE_MS,
    );
    const { res, captured } = fakeRes();

    await handler({} as any, res as any);

    expect(captured.statusCode).toBe(503);
    expect(captured.body.status).toBe("degraded");
    expect(captured.body.deadline_exceeded).toEqual([]);
    expect(captured.body.embedding.providers[0].note).toBe("unreachable");
  });

  it("a keys-store error → 503 with keys_error (DB-GAP-035), not a deadline report", async () => {
    const handler = createHealthHandler(
      async () => healthyEmbedding,
      async () => 'Malformed JSON in file ".../10000.jsonl"',
      undefined,
      TEST_DEADLINE_MS,
    );
    const { res, captured } = fakeRes();

    await handler({} as any, res as any);

    expect(captured.statusCode).toBe(503);
    expect(captured.body.keys_error).toContain("Malformed JSON");
    expect(captured.body.deadline_exceeded).toEqual([]);
  });

  it("a throwing probe → 503 with the probe error, never a throw (liveness)", async () => {
    const handler = createHealthHandler(
      () => {
        throw new Error("probe exploded");
      },
      async () => null,
      undefined,
      TEST_DEADLINE_MS,
    );
    const { res, captured } = fakeRes();

    await expect(handler({} as any, res as any)).resolves.toBeUndefined();

    expect(captured.statusCode).toBe(503);
    expect(captured.body.embedding.providers[0].note).toContain(
      "probe error: probe exploded",
    );
  });
});

describe("OPS-002: abandoned probes cannot destabilise the process", () => {
  it("a probe that REJECTS after the deadline → answered at the deadline, no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      const lateReject = new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("late probe failure")), 80);
      });
      const handler = createHealthHandler(
        () => lateReject,
        async () => null,
        undefined,
        TEST_DEADLINE_MS,
      );
      const { res, captured } = fakeRes();

      const started = Date.now();
      await handler({} as any, res as any);
      expect(Date.now() - started).toBeLessThan(TEST_DEADLINE_MS + 1_000);
      expect(captured.body.deadline_exceeded).toContain("embedding");

      // Let the abandoned rejection land, then check nothing escaped.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });
});
