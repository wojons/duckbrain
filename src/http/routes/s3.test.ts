/**
 * SURFACE-S3-001 — the object-store verbs over HTTP.
 *
 * These tests drive the REAL engine: no mocked sync, no fake counts. A local
 * S3-compatible endpoint (src/testing/stub-s3.ts) stands in for the bucket, so
 * a push here performs the same walk, delta computation, PUTs, checksum
 * ledger and manifest write that `duckbrain s3 sync` performs, and the numbers
 * asserted are the numbers that engine produced.
 *
 * What is pinned, and why each one is a claim the row makes:
 *
 *   1. status answers with object counts on both sides, the drift between them
 *      and the last push — and reports an ABSENT remote count as "unknown",
 *      never as 0 ("bucket did not answer" and "bucket is empty" are opposite
 *      operational facts);
 *   2. sync answers with the counts the CLI prints, and a second sync uploads
 *      nothing (idempotence);
 *   3. a held lock is a 409 naming it — the reason SURFACE-HTTP-OPS-001 gave
 *      for keeping sync CLI-only is answered, not ignored;
 *   4. the namespace grant is the outer scope and the role is the inner one:
 *      ungranted 403, analyst cannot sync, write-less admin-only verbs 403;
 *   5. ghost listing + the SCOPED sweep (one namespace, no sibling damage);
 *   6. the destructive clear is dry-run by default, then confirm + reason;
 *   7. every run leaves one lifecycle-ledger line with op + principal;
 *   8. a namespace name that escapes the root is a 400 before any bucket call.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import express, { Request, Response, NextFunction } from "express";
import { createServer, Server } from "http";

import { authMiddleware, type AuthConfig } from "../../auth/middleware";
import { createS3Routes } from "./s3";
import { startStubS3, type StubS3 } from "../../testing/stub-s3";

const NS = "proof-ns";

const AUTH_CONFIG: AuthConfig = {
  type: "apikey",
  apiKeys: [
    { key: "admin-key", name: "s3-admin", roles: ["admin"] },
    { key: "writer-key", name: "s3-writer", roles: ["writer"], namespaces: [NS] },
    { key: "analyst-key", name: "s3-analyst", roles: ["analyst"], namespaces: [NS] },
    { key: "outsider-key", name: "s3-outsider", roles: ["writer"], namespaces: ["other-ns"] },
  ],
};

const ENV_KEYS = [
  "DUCKBRAIN_CONFIG_PATH",
  "DUCKBRAIN_NAMESPACES_PATH",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_REGION",
  "AWS_ENDPOINT_URL",
  "AWS_ENDPOINT_URL_S3",
  "AWS_PROFILE",
] as const;

let tmpDir: string;
let nsRoot: string;
let cfgFile: string;
let envSnapshot: Record<string, string | undefined>;
let server: Server;
let port: number;
let stub: StubS3;

/** Mount the production route shape: auth → json → /api/ns/:ns/s3. */
function mountApp(): express.Express {
  const app = express();
  app.use(authMiddleware(AUTH_CONFIG));
  app.use(express.json());
  app.use("/api/ns/:ns/s3", createS3Routes());
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.status || 500).json({
      error: err.message || "Internal server error",
      ...(err.code ? { code: err.code } : {}),
    });
  });
  return app;
}

function writeConfig(s3?: Record<string, unknown>): void {
  fs.writeFileSync(
    cfgFile,
    JSON.stringify(
      {
        namespacesPath: "namespaces",
        defaultNamespace: NS,
        ...(s3 ? { s3 } : {}),
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function enableS3(): void {
  writeConfig({
    enabled: true,
    endpoint: stub.endpoint,
    bucket: "duckbrain",
    prefix: "proj",
    forcePathStyle: true,
    region: "us-east-1",
  });
}

/** A namespace with two syncable files (a partition and a manifest). */
function seedNamespace(ns = NS, files = 2): void {
  const dir = path.join(nsRoot, ns, "event", "2026-11");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "current.jsonl"), '{"id":"r1"}\n', "utf-8");
  if (files > 1) {
    fs.writeFileSync(
      path.join(nsRoot, ns, "manifest.json"),
      JSON.stringify({ partitions: ["event/2026-11"] }),
      "utf-8",
    );
  }
}

function lifecycleLines(): any[] {
  const file = path.join(nsRoot, ".s3state", "lifecycle.log");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function request(
  method: string,
  urlPath: string,
  opts: { key?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port,
      path: urlPath,
      method,
      headers: {
        Host: "localhost",
        ...(opts.key ? { "X-API-Key": opts.key } : {}),
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (c: Buffer) => (data += c.toString()));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: data });
        }
      });
    });
    req.on("error", reject);
    if (opts.body !== undefined) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-s3-route-"));
  nsRoot = path.join(tmpDir, "namespaces");
  fs.mkdirSync(nsRoot, { recursive: true });
  cfgFile = path.join(tmpDir, "duckbrain.config.json");

  envSnapshot = {};
  for (const key of ENV_KEYS) envSnapshot[key] = process.env[key];
  process.env.DUCKBRAIN_CONFIG_PATH = cfgFile;
  delete process.env.DUCKBRAIN_NAMESPACES_PATH;
  delete process.env.AWS_ENDPOINT_URL;
  delete process.env.AWS_ENDPOINT_URL_S3;
  delete process.env.AWS_PROFILE;
  // The stub ignores signatures; the SDK still refuses to sign without a key.
  process.env.AWS_ACCESS_KEY_ID = "stub-key";
  process.env.AWS_SECRET_ACCESS_KEY = "stub-secret";
  process.env.AWS_REGION = "us-east-1";

  stub = await startStubS3("duckbrain");
  writeConfig();

  const app = mountApp();
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stub.stop();
  for (const key of ENV_KEYS) {
    const value = envSnapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/ns/:ns/s3 — status", () => {
  it("answers local counts with an ABSENT remote count (never 0) while S3 is disabled", async () => {
    seedNamespace();
    const res = await request("GET", `/api/ns/${NS}/s3`, { key: "admin-key" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      namespace: NS,
      enabled: false,
      store: null,
      objects: { local: 2, remote: null, bookkeeping: null, data: null },
      drift: { state: "s3-disabled", objects: null },
      lastPushAt: null,
    });
  });

  it("reports drift against the bucket once enabled, before and after a push", async () => {
    seedNamespace();
    enableS3();

    const before = await request("GET", `/api/ns/${NS}/s3`, { key: "admin-key" });
    expect(before.status).toBe(200);
    expect(before.body.enabled).toBe(true);
    expect(before.body.store).toMatchObject({ bucket: "duckbrain", prefix: "proj" });
    expect(before.body.objects).toEqual({
      local: 2,
      remote: 0,
      bookkeeping: 0,
      data: 0,
    });
    expect(before.body.drift).toEqual({ state: "local-ahead", objects: 2 });
    expect(before.body.lastPushAt).toBeNull();

    // probe=false must not touch the network and must say "unknown".
    const noProbe = await request("GET", `/api/ns/${NS}/s3?probe=false`, { key: "admin-key" });
    expect(noProbe.body.objects.remote).toBeNull();
    expect(noProbe.body.drift.state).toBe("unknown");
    expect(stub.requests().LIST).toBe(1); // only the first status listed
  });
});

describe("POST /api/ns/:ns/s3/sync — the CLI verb, with its counts", () => {
  it("pushes, returns the CLI's counts, and the second push uploads nothing", async () => {
    seedNamespace();
    enableS3();

    const first = await request("POST", `/api/ns/${NS}/s3/sync`, { key: "admin-key" });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      success: true,
      namespace: NS,
      direction: "push",
      uploaded: 2,
      downloaded: 0,
      skipped: 0,
      failed: 0,
    });
    expect(first.body.summary).toBe(
      `[S3] push ${NS}: uploaded=2 downloaded=0 skipped=0 in ${first.body.durationMs}ms`,
    );
    expect(stub.keys()).toEqual([
      `proj/${NS}/.s3state/checksums.json`,
      `proj/${NS}/event/2026-11/current.jsonl`,
      `proj/${NS}/manifest.json`,
    ]);

    const after = await request("GET", `/api/ns/${NS}/s3`, { key: "admin-key" });
    // remote 3 = two data objects + the engine's checksum ledger, which is
    // reported separately so it cannot mask drift: data objects match disk.
    expect(after.body.objects).toEqual({
      local: 2,
      remote: 3,
      bookkeeping: 1,
      data: 2,
    });
    expect(after.body.drift).toEqual({ state: "in-sync", objects: 0 });
    expect(typeof after.body.lastPushAt).toBe("string");

    const second = await request("POST", `/api/ns/${NS}/s3/sync`, { key: "admin-key" });
    expect(second.status).toBe(200);
    expect(second.body.uploaded).toBe(0);
    expect(second.body.skipped).toBeGreaterThan(0);
  });

  it("refuses a push for a namespace with no local directory (404 + the pull hint)", async () => {
    enableS3();
    const res = await request("POST", `/api/ns/${NS}/s3/sync`, { key: "admin-key" });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NAMESPACE_NOT_FOUND");
    expect(res.body.error).toContain('direction="pull"');
  });

  it("rejects an unknown direction instead of silently pushing", async () => {
    seedNamespace();
    enableS3();
    const res = await request("POST", `/api/ns/${NS}/s3/sync`, {
      key: "admin-key",
      body: { direction: "sideways" },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(stub.requests().PUT).toBe(0);
  });

  it("answers a held lock with 409 SYNC_IN_PROGRESS and does no work", async () => {
    seedNamespace();
    enableS3();
    const { acquireLock, releaseLock } = await import("../../s3/sync.js");
    const lock = acquireLock(nsRoot);
    expect(lock).not.toBeNull();
    try {
      const res = await request("POST", `/api/ns/${NS}/s3/sync`, { key: "admin-key" });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("SYNC_IN_PROGRESS");
      expect(res.body.error).toContain("lock");
      expect(stub.requests().PUT).toBe(0);
    } finally {
      releaseLock(lock);
    }
  });

  it("is 409 S3_DISABLED when the object store is switched off", async () => {
    seedNamespace();
    const res = await request("POST", `/api/ns/${NS}/s3/sync`, { key: "admin-key" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("S3_DISABLED");
    expect(res.body.error).toContain("s3.enabled");
  });
});

describe("authorization — namespace grant outside, role inside", () => {
  it("401 without a key, 403 for a token without the namespace grant", async () => {
    seedNamespace();
    const anon = await request("GET", `/api/ns/${NS}/s3`);
    expect(anon.status).toBe(401);

    const outsider = await request("GET", `/api/ns/${NS}/s3`, { key: "outsider-key" });
    expect(outsider.status).toBe(403);
    expect(outsider.body.error).toContain("no grant for namespace");
  });

  it("an analyst may read status but may not trigger a sync", async () => {
    seedNamespace();
    enableS3();
    const read = await request("GET", `/api/ns/${NS}/s3`, { key: "analyst-key" });
    expect(read.status).toBe(200);

    const write = await request("POST", `/api/ns/${NS}/s3/sync`, { key: "analyst-key" });
    expect(write.status).toBe(403);
    expect(write.body.code).toBe("FORBIDDEN");
    expect(stub.requests().PUT).toBe(0);
  });

  it("a writer scoped to the namespace may sync it", async () => {
    seedNamespace();
    enableS3();
    const res = await request("POST", `/api/ns/${NS}/s3/sync`, { key: "writer-key" });
    expect(res.status).toBe(200);
    expect(res.body.uploaded).toBe(2);
  });

  it("a namespace name that escapes the root is 400 before any store call", async () => {
    enableS3();
    const res = await request("GET", `/api/ns/..%2Fetc/s3`, { key: "admin-key" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_NAMESPACE");
    expect(stub.requests().LIST).toBe(0);
  });
});

describe("ghost sync state", () => {
  function seedGhost(ns: string): void {
    fs.mkdirSync(path.join(nsRoot, ".s3state"), { recursive: true });
    fs.writeFileSync(
      path.join(nsRoot, ".s3state", `${ns}.json`),
      JSON.stringify({ version: 1, ns, lastSyncAt: "2026-11-01T00:00:00Z", files: {} }),
      "utf-8",
    );
  }

  it("lists ghosts even while S3 is disabled, and names the one in the path", async () => {
    seedNamespace();
    seedGhost("dead-a");
    seedGhost("dead-b");
    const res = await request("GET", `/api/ns/dead-a/s3/ghosts`, { key: "admin-key" });
    expect(res.status).toBe(200);
    expect(res.body.isGhost).toBe(true);
    expect(res.body.thisNamespace.ghostManifest).toMatchObject({ ns: "dead-a" });
    expect(res.body.ghosts.total).toBe(2);
    expect(res.body.ghosts.manifests.map((g: any) => g.ns).sort()).toEqual([
      "dead-a",
      "dead-b",
    ]);

    const live = await request("GET", `/api/ns/${NS}/s3/ghosts`, { key: "admin-key" });
    expect(live.body.isGhost).toBe(false);
  });

  it("clears only the namespace in the path, and only with confirm", async () => {
    seedNamespace();
    seedGhost("dead-a");
    seedGhost("dead-b");

    const unconfirmed = await request("POST", `/api/ns/dead-a/s3/ghosts/clear`, {
      key: "admin-key",
      body: {},
    });
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.body.code).toBe("CONFIRMATION_REQUIRED");
    expect(fs.existsSync(path.join(nsRoot, ".s3state", "dead-a.json"))).toBe(true);

    const cleared = await request("POST", `/api/ns/dead-a/s3/ghosts/clear`, {
      key: "admin-key",
      body: { confirm: true, reason: "compaction runbook step 3" },
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ success: true, cleared: true });
    expect(cleared.body.manifestsPruned).toEqual(["dead-a"]);
    expect(fs.existsSync(path.join(nsRoot, ".s3state", "dead-a.json"))).toBe(false);
    // The sibling ghost is untouched: the route is scoped to its own namespace.
    expect(fs.existsSync(path.join(nsRoot, ".s3state", "dead-b.json"))).toBe(true);
  });

  it("is admin-only", async () => {
    seedGhost("dead-a");
    const res = await request("POST", `/api/ns/dead-a/s3/ghosts/clear`, {
      key: "writer-key",
      body: { confirm: true },
    });
    expect(res.status).toBe(403);
    expect(fs.existsSync(path.join(nsRoot, ".s3state", "dead-a.json"))).toBe(true);
  });
});

describe("POST /api/ns/:ns/s3/clear — destructive, confirmed, audited", () => {
  it("dry-runs by default, then requires confirm AND a reason, then destroys the remote", async () => {
    seedNamespace();
    enableS3();
    await request("POST", `/api/ns/${NS}/s3/sync`, { key: "admin-key" });
    const pushed = stub.keys().length;
    expect(pushed).toBeGreaterThan(0);

    const plan = await request("POST", `/api/ns/${NS}/s3/clear`, { key: "admin-key", body: {} });
    expect(plan.status).toBe(200);
    expect(plan.body.dryRun).toBe(true);
    expect(plan.body.plan.objectCount).toBe(pushed);
    expect(stub.keys().length).toBe(pushed);

    const noConfirm = await request("POST", `/api/ns/${NS}/s3/clear`, {
      key: "admin-key",
      body: { dryRun: false },
    });
    expect(noConfirm.status).toBe(400);
    expect(noConfirm.body.code).toBe("CONFIRMATION_REQUIRED");

    const noReason = await request("POST", `/api/ns/${NS}/s3/clear`, {
      key: "admin-key",
      body: { dryRun: false, confirm: true },
    });
    expect(noReason.status).toBe(400);
    expect(noReason.body.code).toBe("VALIDATION_ERROR");

    const cleared = await request("POST", `/api/ns/${NS}/s3/clear`, {
      key: "admin-key",
      body: { dryRun: false, confirm: true, reason: "tenant offboarding" },
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.deleted).toBe(pushed);
    expect(stub.keys()).toEqual([]);
    // Remote only: disk is untouched.
    expect(fs.existsSync(path.join(nsRoot, NS, "event", "2026-11", "current.jsonl"))).toBe(true);
  });
});

describe("audit ledger", () => {
  it("appends one line per run carrying op, surface and principal", async () => {
    seedNamespace();
    enableS3();
    await request("GET", `/api/ns/${NS}/s3`, { key: "admin-key" });
    await request("POST", `/api/ns/${NS}/s3/sync`, { key: "writer-key" });
    await request("GET", `/api/ns/dead-z/s3/ghosts`, { key: "admin-key" });

    const lines = lifecycleLines();
    const ops = lines.map((l) => l.op);
    expect(ops).toContain("s3-status");
    expect(ops).toContain("s3-push");
    expect(ops).toContain("s3-ghosts-list");
    const push = lines.find((l) => l.op === "s3-push");
    expect(push).toMatchObject({ surface: "rest", principal: "s3-writer", ns: NS, uploaded: 2 });
    const status = lines.find((l) => l.op === "s3-status");
    expect(status).toMatchObject({ surface: "rest", principal: "s3-admin", ns: NS });
  });
});
