/**
 * SURFACE-S3-001 — a minimal in-process S3-compatible endpoint for tests and
 * proofs.
 *
 * The native sync engine talks to the bucket through @aws-sdk/client-s3 with
 * `forcePathStyle`, so an object store is only four verbs wide: ListObjectsV2
 * (`GET /<bucket>?list-type=2`), PutObject (`PUT /<bucket>/<key>`), GetObject
 * and DeleteObject. This stub implements exactly those against an in-memory
 * map, which lets a route test (or a proof script) exercise the REAL engine —
 * the same `syncNamespace()` the CLI runs — with no network, no credentials
 * and no MinIO dependency.
 *
 * It is deliberately NOT a general S3 mock: unknown query shapes and
 * unsupported verbs answer 400/501 rather than silently succeeding, so a test
 * cannot pass against behaviour the engine never uses.
 *
 * Usage:
 *   const s3 = await startStubS3();
 *   s3.endpoint  // "http://127.0.0.1:<port>" — put it in s3.endpoint
 *   s3.keys()    // the object keys currently stored
 *   await s3.stop()
 */

import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { createHash } from "crypto";

export interface StubS3 {
  endpoint: string;
  bucket: string;
  /** Every stored key, sorted. */
  keys(): string[];
  /** Stored bytes for one key (undefined when absent). */
  get(key: string): Buffer | undefined;
  /** Seed an object without going through the HTTP surface. */
  put(key: string, body: string | Buffer): void;
  /** Number of requests answered so far (per verb). */
  requests(): Record<string, number>;
  stop(): Promise<void>;
}

const MAX_KEYS_PER_PAGE = 1000;

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function md5(body: Buffer): string {
  return createHash("md5").update(body).digest("hex");
}

/** Split a path-style URL into bucket + key (both URL-decoded). */
function splitPath(rawUrl: string): { bucket: string; key: string } {
  const url = new URL(rawUrl, "http://stub.invalid");
  const segments = url.pathname.replace(/^\/+/, "").split("/");
  const bucket = decodeURIComponent(segments.shift() ?? "");
  const key = segments.map((s) => decodeURIComponent(s)).join("/");
  return { bucket, key };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function startStubS3(bucket = "duckbrain"): Promise<StubS3> {
  const objects = new Map<string, { body: Buffer; lastModified: string }>();
  const counts: Record<string, number> = { GET: 0, PUT: 0, DELETE: 0, LIST: 0 };

  const server: Server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://stub.invalid");
      const { bucket: reqBucket, key } = splitPath(req.url ?? "/");
      if (reqBucket !== bucket) {
        res.writeHead(404, { "Content-Type": "application/xml" });
        res.end(
          `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchBucket</Code><Message>no bucket ${xmlEscape(reqBucket)}</Message></Error>`,
        );
        return;
      }

      // ListObjectsV2
      if (method === "GET" && !key) {
        if (url.searchParams.get("list-type") !== "2") {
          res.writeHead(400, { "Content-Type": "application/xml" });
          res.end(
            `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NotImplemented</Code><Message>only list-type=2 is supported</Message></Error>`,
          );
          return;
        }
        counts.LIST++;
        const prefix = url.searchParams.get("prefix") ?? "";
        const all = [...objects.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .sort(([a], [b]) => a.localeCompare(b));
        const start = Number(url.searchParams.get("continuation-token") ?? "0") || 0;
        const page = all.slice(start, start + MAX_KEYS_PER_PAGE);
        const next = start + MAX_KEYS_PER_PAGE < all.length ? String(start + MAX_KEYS_PER_PAGE) : null;
        const contents = page
          .map(
            ([k, v]) =>
              `<Contents><Key>${xmlEscape(k)}</Key><LastModified>${v.lastModified}</LastModified><ETag>"${md5(v.body)}"</ETag><Size>${v.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`,
          )
          .join("");
        res.writeHead(200, { "Content-Type": "application/xml" });
        res.end(
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${MAX_KEYS_PER_PAGE}</MaxKeys><IsTruncated>${next ? "true" : "false"}</IsTruncated>${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ""}${contents}</ListBucketResult>`,
        );
        return;
      }

      if (method === "PUT" && key) {
        counts.PUT++;
        const body = await readBody(req);
        objects.set(key, { body, lastModified: new Date().toISOString() });
        res.writeHead(200, { ETag: `"${md5(body)}"`, "Content-Type": "application/xml" });
        res.end("");
        return;
      }

      if (method === "GET" && key) {
        counts.GET++;
        const found = objects.get(key);
        if (!found) {
          res.writeHead(404, { "Content-Type": "application/xml" });
          res.end(
            `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>missing ${xmlEscape(key)}</Message></Error>`,
          );
          return;
        }
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(found.body.length),
          ETag: `"${md5(found.body)}"`,
        });
        res.end(found.body);
        return;
      }

      if (method === "DELETE" && key) {
        counts.DELETE++;
        objects.delete(key);
        res.writeHead(204);
        res.end();
        return;
      }

      res.writeHead(501, { "Content-Type": "application/xml" });
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NotImplemented</Code><Message>${xmlEscape(method)} ${xmlEscape(url.pathname)}</Message></Error>`,
      );
    },
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    endpoint: `http://127.0.0.1:${port}`,
    bucket,
    keys: () => [...objects.keys()].sort(),
    get: (k: string) => objects.get(k)?.body,
    put: (k: string, body: string | Buffer) =>
      objects.set(k, {
        body: Buffer.isBuffer(body) ? body : Buffer.from(body),
        lastModified: new Date().toISOString(),
      }),
    requests: () => ({ ...counts }),
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
