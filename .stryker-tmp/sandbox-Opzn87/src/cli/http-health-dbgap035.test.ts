/**
 * DB-GAP-035 regression tests: GET /health surfaces keys_error.
 *
 * The keys store corrupted (one torn JSONL line) 500ed every keys consumer
 * while /health still reported a green/degraded body with no mention of
 * keys. The handler now probes the keys store (same resilient read as
 * list_keys) and reports keys_error — null when healthy, a short error
 * string when the probe fails — flipping status to degraded.
 *
 * GAP-030: the HTTP status code now carries the signal too — 503 when
 * degraded (embedding.healthy=false or keys_error set), 200 when healthy —
 * so a supervisor watching HTTP codes sees non-200 while semantic search is
 * down.
 *
 * createHealthHandler takes both probes as injectable params (same pattern
 * as the DOGFOOD-020 embedding probe), so this unit test needs no server,
 * no DuckDB, and no embedding provider.
 */
// @ts-nocheck


import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createHealthHandler } from "./http";

/** Minimal express Response double — the handler calls res.status() + res.json(). */
function fakeRes() {
  const captured: { body: unknown; statusCode: number } = {
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

    expect(captured.statusCode).toBe(200);
    expect((captured.body as any).keys_error).toBeNull();
    expect((captured.body as any).status).toBe("healthy");
  });

  it("flips status to degraded and reports the error string when the keys probe fails", async () => {
    const handler = createHealthHandler(
      async () => healthyEmbedding,
      async () => 'Malformed JSON in file ".../10000.jsonl", at byte 33',
    );
    const { res, captured } = fakeRes();
    await handler({} as any, res as any);

    expect(captured.statusCode).toBe(503);
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

    expect(captured.statusCode).toBe(503);
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

    expect(captured.statusCode).toBe(503);
    expect((captured.body as any).keys_error).toContain("connection lost");
    expect((captured.body as any).keys_error!.length).toBeLessThanOrEqual(200);
    expect((captured.body as any).status).toBe("degraded");
  });
});

/**
 * HEALTH-KEYS-UNDEFINED-001: a fresh install has an EMPTY namespaces root —
 * the config default namespace does not exist yet. The wired-in keys probe
 * (probeKeysStore with no explicit namespace, exactly what createHttpServer
 * mounts) must resolve the config default and report healthy, so /health is
 * 200 — pre-fix the probe fed the raw `undefined` argument to list_keys and
 * /health answered 503 with keys_error "Namespace 'undefined' does not
 * exist".
 *
 * Runs against a real (empty) namespaces root via DUCKBRAIN_NAMESPACES_PATH,
 * with the embedding probe injected healthy so keys is the only live signal.
 */
describe("HEALTH-KEYS-UNDEFINED-001: fresh install /health is healthy", () => {
  it("empty namespaces root — default namespace absent — is NOT degraded", async () => {
    const freshRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-fresh-install-"),
    );
    const savedNsPath = process.env.DUCKBRAIN_NAMESPACES_PATH;
    const savedNsName = process.env.DUCKBRAIN_NAMESPACE;
    process.env.DUCKBRAIN_NAMESPACES_PATH = freshRoot;
    try {
      // Default keysProbe — the same resolution the HTTP layer mounts.
      const handler = createHealthHandler(async () => healthyEmbedding);
      const { res, captured } = fakeRes();
      await handler({} as any, res as any);

      expect(captured.statusCode).toBe(200);
      expect((captured.body as any).status).toBe("healthy");
      expect((captured.body as any).keys_error).toBeNull();
      expect(JSON.stringify(captured.body)).not.toContain("undefined");
    } finally {
      if (savedNsPath === undefined)
        delete process.env.DUCKBRAIN_NAMESPACES_PATH;
      else process.env.DUCKBRAIN_NAMESPACES_PATH = savedNsPath;
      if (savedNsName === undefined) delete process.env.DUCKBRAIN_NAMESPACE;
      else process.env.DUCKBRAIN_NAMESPACE = savedNsName;
      fs.rmSync(freshRoot, { recursive: true, force: true });
    }
  });
});
