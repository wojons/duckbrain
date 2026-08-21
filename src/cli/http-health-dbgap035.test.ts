/**
 * DB-GAP-035 regression tests: GET /health surfaces keys_error.
 *
 * The keys store corrupted (one torn JSONL line) 500ed every keys consumer
 * while /health still reported a green/degraded body with no mention of
 * keys. The handler now probes the keys store (same resilient read as
 * list_keys) and reports keys_error — null when healthy, a short error
 * string when the probe fails — flipping status to degraded.
 *
 * createHealthHandler takes both probes as injectable params (same pattern
 * as the DOGFOOD-020 embedding probe), so this unit test needs no server,
 * no DuckDB, and no embedding provider.
 */

import { describe, it, expect } from "vitest";
import { createHealthHandler } from "./http";

/** Minimal express Response double — the handler only calls res.json(). */
function fakeRes() {
  const captured: { body: unknown } = { body: null };
  const res: any = {
    json(body: unknown) {
      captured.body = body;
      return res;
    },
  };
  return { res, captured };
}

const healthyEmbedding = {
  provider: "lmstudio",
  model: "nomic-embed-text",
  healthy: true,
  providers: [],
};

describe("DB-GAP-035: /health keys_error", () => {
  it("reports keys_error: null and status healthy when both probes pass", async () => {
    const handler = createHealthHandler(
      async () => healthyEmbedding,
      async () => null,
    );
    const { res, captured } = fakeRes();
    await handler({} as any, res as any);

    expect((captured.body as any).keys_error).toBeNull();
    expect((captured.body as any).status).toBe("healthy");
  });

  it("flips status to degraded and reports the error string when the keys probe fails", async () => {
    const handler = createHealthHandler(
      async () => healthyEmbedding,
      async () => "Malformed JSON in file \".../10000.jsonl\", at byte 33",
    );
    const { res, captured } = fakeRes();
    await handler({} as any, res as any);

    expect((captured.body as any).keys_error).toContain("Malformed JSON");
    expect((captured.body as any).status).toBe("degraded");
  });

  it("keeps degraded status when embedding is down even with a healthy keys store", async () => {
    const handler = createHealthHandler(
      async () => ({ provider: "", model: "", healthy: false, providers: [] }),
      async () => null,
    );
    const { res, captured } = fakeRes();
    await handler({} as any, res as any);

    expect((captured.body as any).keys_error).toBeNull();
    expect((captured.body as any).status).toBe("degraded");
  });

  it("never takes /health down when the keys probe throws — degraded + short error", async () => {
    const handler = createHealthHandler(
      async () => healthyEmbedding,
      async () => {
        throw new Error("connection lost");
      },
    );
    const { res, captured } = fakeRes();
    await handler({} as any, res as any);

    expect((captured.body as any).keys_error).toContain("connection lost");
    expect((captured.body as any).keys_error!.length).toBeLessThanOrEqual(200);
    expect((captured.body as any).status).toBe("degraded");
  });
});
