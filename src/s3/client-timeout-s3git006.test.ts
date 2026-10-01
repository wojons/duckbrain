/**
 * S3-GIT-006 — the S3 CLI must never hang a run again.
 *
 * The live failure: a sync tree sat VISIBLE-HEALTHY but never finished
 * (frozen write_bytes, ESTAB to :443) because buildClient set NO
 * request/socket bound — any slow or queued request could pin a run (and
 * with it the unified cron's flock) indefinitely.
 *
 * Three hermetic arms (no real S3, no external egress):
 *   1. buildClient wires a NodeHttpHandler with the S3-GIT-006 bounds:
 *      connectionTimeout 10s, requestTimeout 120s, maxSockets 20.
 *   2. A request against a refusing endpoint (localhost:1, ECONNREFUSED,
 *      in-process) REJECTS within 15s instead of hanging — env credentials
 *      are provided so the rejection happens on the WIRE path, not in the
 *      credential chain.
 *   3. The keepAlive agent never pins process exit: a one-shot CLI shape
 *      (build → two sends against a loopback server → done) exits on its
 *      own even with idle pooled sockets. Node's http.Agent unrefs free
 *      sockets; if a future refactor breaks that property, this arm fails
 *      with a kill-timeout instead of a clean exit.
 */

import { describe, it, expect } from "vitest";
import { spawn } from "child_process";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { buildClient, listRemoteObjects } from "./client";
import { DEFAULT_S3_CONFIG, type S3Config } from "./config";

/** An enabled config pointing at an address that refuses connections. */
const deadCfg = (): S3Config => ({
  ...DEFAULT_S3_CONFIG,
  enabled: true,
  endpoint: "http://localhost:1",
  forcePathStyle: true,
});

/** Seconds a request may take before the arm declares a hang. */
const REJECT_WITHIN_S = 15;

/**
 * Run `fn` with throwaway env credentials so the SDK's default chain
 * resolves IMMEDIATELY from env and the send actually attempts the
 * connection (no credential-chain rejection masking the wire behavior,
 * no IMDS probing delay). Restored afterwards.
 */
async function withS3TestCreds<T>(fn: () => Promise<T>): Promise<T> {
  const saved = {
    key: process.env.AWS_ACCESS_KEY_ID,
    secret: process.env.AWS_SECRET_ACCESS_KEY,
    imds: process.env.AWS_EC2_METADATA_DISABLED,
  };
  process.env.AWS_ACCESS_KEY_ID = "s3git006-test";
  process.env.AWS_SECRET_ACCESS_KEY = "s3git006-test";
  process.env.AWS_EC2_METADATA_DISABLED = "true";
  try {
    return await fn();
  } finally {
    if (saved.key === undefined) delete process.env.AWS_ACCESS_KEY_ID;
    else process.env.AWS_ACCESS_KEY_ID = saved.key;
    if (saved.secret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = saved.secret;
    if (saved.imds === undefined) delete process.env.AWS_EC2_METADATA_DISABLED;
    else process.env.AWS_EC2_METADATA_DISABLED = saved.imds;
  }
}

function expectRejectedWithin(
  p: Promise<unknown>,
  what: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(
          new Error(
            `${what}: still pending after ${REJECT_WITHIN_S}s (HANG — S3-GIT-006)`,
          ),
        );
      }
    }, REJECT_WITHIN_S * 1000);
    p.then(
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`${what}: resolved (expected a rejection)`));
        }
      },
      (err: unknown) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          expect(err).toBeInstanceOf(Error);
          resolve();
        }
      },
    );
  });
}

describe("buildClient request bounds (S3-GIT-006)", () => {
  it("wires a NodeHttpHandler with connectionTimeout=10s, requestTimeout=120s, maxSockets=20", async () => {
    const client = buildClient(deadCfg());
    const handler = client.config.requestHandler as NodeHttpHandler;
    expect(handler).toBeInstanceOf(NodeHttpHandler);
    const resolved = await (
      handler as unknown as {
        configProvider: Promise<Record<string, unknown>>;
      }
    ).configProvider;
    expect(resolved.requestTimeout).toBe(120_000);
    expect(resolved.connectionTimeout).toBe(10_000);
    const httpsAgent = resolved.httpsAgent as { maxSockets?: number };
    expect(httpsAgent?.maxSockets).toBe(20);
    client.destroy();
  });
});

describe("a dead endpoint rejects instead of hanging (S3-GIT-006)", () => {
  it(
    "listRemoteObjects REJECTS within 15s against localhost:1 (ECONNREFUSED)",
    async () => {
      await withS3TestCreds(async () => {
        const client = buildClient(deadCfg());
        await expectRejectedWithin(
          listRemoteObjects(client, "duckbrain", "duckbrain/"),
          "listRemoteObjects against localhost:1",
        );
        client.destroy();
      });
    },
    REJECT_WITHIN_S * 1000 + 5_000,
  );

  it(
    "client.send REJECTS within 15s against localhost:1",
    async () => {
      await withS3TestCreds(async () => {
        const client = buildClient(deadCfg());
        await expectRejectedWithin(
          client.send(
            new ListObjectsV2Command({ Bucket: "duckbrain", Prefix: "x" }),
          ),
          "client.send against localhost:1",
        );
        client.destroy();
      });
    },
    REJECT_WITHIN_S * 1000 + 5_000,
  );
});

describe("the keepAlive agent never pins process exit (S3-GIT-006)", () => {
  // A real child process in the one-shot CLI shape: build → 2 successful
  // sends against an in-process loopback server (so an idle keepAlive
  // socket really exists in the pool) → exit. The server closes its own
  // connections so the EXIT assertion measures the CLIENT's sockets.
  it(
    "a one-shot run with pooled keepAlive sockets exits on its own",
    async () => {
      const repoRoot = process.cwd();
      const childScript = [
        `process.env.AWS_ACCESS_KEY_ID = "s3git006-test";`,
        `process.env.AWS_SECRET_ACCESS_KEY = "s3git006-test";`,
        `process.env.AWS_EC2_METADATA_DISABLED = "true";`,
        `const http = await import("node:http");`,
        `const { buildClient } = await import("./src/s3/client.ts");`,
        `const { DEFAULT_S3_CONFIG } = await import("./src/s3/config.ts");`,
        `const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");`,
        `const server = http.createServer((req, res) => {`,
        `  res.setHeader("content-type", "application/xml");`,
        `  res.end('<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated></ListBucketResult>');`,
        `});`,
        `await new Promise((res) => server.listen(0, "127.0.0.1", res));`,
        `const port = server.address().port;`,
        `const client = buildClient({ ...DEFAULT_S3_CONFIG, enabled: true, endpoint: "http://127.0.0.1:" + port, forcePathStyle: true });`,
        `await client.send(new ListObjectsV2Command({ Bucket: "duckbrain" }));`,
        `await client.send(new ListObjectsV2Command({ Bucket: "duckbrain" }));`,
        `server.closeAllConnections();`,
        `server.close();`,
        `console.log("sent-and-done");`,
      ].join("\n");
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--eval", childScript],
        { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
      );
      const result = await new Promise<{
        code: number | null;
        sig: string | null;
        out: string;
      }>((resolve) => {
        let out = "";
        const killTimer = setTimeout(
          () => child.kill("SIGKILL"),
          REJECT_WITHIN_S * 1000,
        );
        child.stdout!.on("data", (d: Buffer) => (out += d.toString()));
        child.stderr!.on("data", (d: Buffer) => (out += d.toString()));
        child.on("exit", (code, sig) => {
          clearTimeout(killTimer);
          resolve({ code, sig, out });
        });
      });
      expect(result.out).toContain("sent-and-done");
      expect(result.sig).toBeNull();
      expect(result.code).toBe(0);
    },
    REJECT_WITHIN_S * 1000 + 10_000,
  );
});
