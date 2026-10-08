/**
 * DF-0924-08 — the HTTP daemon serves the built Web UI.
 *
 * Two states are asserted against a real listening server (not a hand-built
 * app — the wiring under test lives in createHttpServer's mount order):
 *
 * 1. dist present  → GET / returns the built index.html (200, text/html),
 *                    a deep link (SPA fallback) returns index.html too,
 *                    and every API route still wins over the static mount.
 * 2. dist missing  → GET / returns a 404 JSON with code UI_NOT_BUILT and a
 *                    pointer at the README build step.
 *
 * The dist directory is pinned via DUCKBRAIN_UI_DIST_DIR to a fixture
 * directory created in beforeAll, so the test never depends on whether
 * packages/ui has been built on this checkout.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { createHttpServer, resolveUiDistDir } from "./http";
import { resetEmbeddingHealthCache } from "../embedding/health";

let server: Server;
let port: number;
let fixtureDist: string;
let savedEnv: string | undefined;
let savedEmbeddingProvider: string | undefined;

const INDEX_HTML = "<!doctype html><html><body>fixture ui</body></html>\n";
const ASSET_JS = "console.log('fixture');\n";

function get(
  requestPath: string,
): Promise<{
  status: number | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: requestPath, method: "GET" },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  // Fixture dist with a plausible vite layout: index.html + hashed asset.
  fixtureDist = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-ui-dist-"));
  fs.writeFileSync(path.join(fixtureDist, "index.html"), INDEX_HTML);
  fs.mkdirSync(path.join(fixtureDist, "assets"), { recursive: true });
  fs.writeFileSync(path.join(fixtureDist, "assets", "app-abc123.js"), ASSET_JS);

  // INT-CI-023 hermeticity: the /health handler runs the REAL embedding
  // health probe. On a dev box LM Studio answers and /health is 200; on CI
  // no embedding backend exists so /health is 503 degraded (GAP-030) and the
  // "API routes still win" assertions fail. Pin provider=none (DF-0923-04):
  // nothing is probed and the aggregate is healthy deterministically.
  savedEnv = process.env.DUCKBRAIN_UI_DIST_DIR;
  process.env.DUCKBRAIN_UI_DIST_DIR = fixtureDist;
  savedEmbeddingProvider = process.env.DUCKBRAIN_EMBEDDING_PROVIDER;
  process.env.DUCKBRAIN_EMBEDDING_PROVIDER = "none";
  resetEmbeddingHealthCache();

  const app = createHttpServer({ authConfig: { type: "none" } });
  server = await new Promise<Server>((resolve) => {
    const candidate = app.listen(0, "127.0.0.1", () => resolve(candidate));
  });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (savedEnv === undefined) delete process.env.DUCKBRAIN_UI_DIST_DIR;
  else process.env.DUCKBRAIN_UI_DIST_DIR = savedEnv;
  if (savedEmbeddingProvider === undefined)
    delete process.env.DUCKBRAIN_EMBEDDING_PROVIDER;
  else process.env.DUCKBRAIN_EMBEDDING_PROVIDER = savedEmbeddingProvider;
  resetEmbeddingHealthCache();
  fs.rmSync(fixtureDist, { recursive: true, force: true });
});

describe("DF-0924-08 built UI serving", () => {
  it("resolveUiDistDir honors DUCKBRAIN_UI_DIST_DIR", () => {
    expect(resolveUiDistDir()).toBe(path.resolve(fixtureDist));
  });

  it("serves index.html at / with 200 and text/html", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toBe(INDEX_HTML);
  });

  it("serves built assets from dist", async () => {
    const res = await get("/assets/app-abc123.js");
    expect(res.status).toBe(200);
    expect(res.body).toBe(ASSET_JS);
  });

  it("SPA fallback: deep link returns index.html, not 404", async () => {
    const res = await get("/namespaces/some-view");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toBe(INDEX_HTML);
  });

  it("API routes still win over the static mount", async () => {
    // /health is the unauthenticated liveness route.
    const health = await get("/health");
    expect(health.status).toBe(200);
    expect(() => JSON.parse(health.body)).not.toThrow();
    expect(JSON.parse(health.body).uptime).toBeGreaterThan(0);

    // An unknown /api path must stay a JSON 404, not the SPA index.
    const apiMiss = await get("/api/definitely-not-a-route");
    expect(apiMiss.status).toBe(404);
    expect(apiMiss.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(apiMiss.body).error).toBeDefined();

    // A route registered AFTER the static mount must still answer.
    const mcpGet = await get("/mcp");
    expect(mcpGet.status).toBe(405);
    expect(mcpGet.headers["allow"]).toBe("POST");
  });

  it("unknown non-API path falls through to the SPA index", async () => {
    const res = await get("/totally-unknown-page");
    expect(res.status).toBe(200);
    expect(res.body).toBe(INDEX_HTML);
  });
});

describe("DF-0924-08 missing dist", () => {
  /**
   * Second app instance with the dist pin aimed at an empty (nonexistent)
   * directory — the exact fresh-clone state.
   */
  let bareServer: Server;
  let barePort: number;

  beforeAll(async () => {
    process.env.DUCKBRAIN_UI_DIST_DIR = path.join(
      os.tmpdir(),
      `duckbrain-ui-missing-${Date.now()}`,
    );
    const app = createHttpServer({ authConfig: { type: "none" } });
    bareServer = await new Promise<Server>((resolve) => {
      const candidate = app.listen(0, "127.0.0.1", () => resolve(candidate));
    });
    barePort = (bareServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => bareServer.close(() => resolve()));
    // Restore the fixture pin for any later describes.
    process.env.DUCKBRAIN_UI_DIST_DIR = fixtureDist;
  });

  it("GET / returns a helpful UI_NOT_BUILT JSON hint", async () => {
    const res = await new Promise<{
      status: number | undefined;
      body: string;
    }>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: barePort, path: "/", method: "GET" },
        (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (c: Buffer) => chunks.push(c));
          r.on("end", () =>
            resolve({
              status: r.statusCode,
              body: Buffer.concat(chunks).toString("utf-8"),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("UI_NOT_BUILT");
    expect(body.error).toContain("pnpm build");
  });

  it("API routes still work without dist", async () => {
    const res = await new Promise<{ status: number | undefined }>(
      (resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port: barePort, path: "/health", method: "GET" },
          (r) => {
            r.resume();
            r.on("end", () => resolve({ status: r.statusCode }));
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
    expect(res.status).toBe(200);
  });
});
