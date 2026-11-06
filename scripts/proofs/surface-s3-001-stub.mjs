#!/usr/bin/env node
/**
 * SURFACE-S3-001 proof — a minimal S3-compatible endpoint (ListObjectsV2,
 * PutObject, GetObject, DeleteObject) in one dependency-free file.
 *
 * The route tests use the typed version in src/testing/stub-s3.ts; this one
 * exists so the PROOF can hand the daemon a real bucket endpoint without
 * booting the TypeScript toolchain for the stub itself. Kept deliberately
 * dumb: unknown verbs answer 501 instead of pretending.
 *
 * Usage: node scripts/proofs/surface-s3-001-stub.mjs <port> <bucket>
 */
import { createServer } from "http";
import { createHash } from "crypto";

const port = Number(process.argv[2] ?? 28790);
const bucket = process.argv[3] ?? "duckbrain";
const objects = new Map();

const md5 = (buf) => createHash("md5").update(buf).digest("hex");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function splitPath(rawUrl) {
  const url = new URL(rawUrl, "http://stub.invalid");
  const segs = url.pathname.replace(/^\/+/, "").split("/");
  const b = decodeURIComponent(segs.shift() ?? "");
  const key = segs.map((s) => decodeURIComponent(s)).join("/");
  return { bucket: b, key, url };
}

createServer((req, res) => {
  const { bucket: reqBucket, key, url } = splitPath(req.url ?? "/");
  if (reqBucket !== bucket) {
    res.writeHead(404, { "Content-Type": "application/xml" });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchBucket</Code><Message>${esc(reqBucket)}</Message></Error>`);
    return;
  }
  if (req.method === "GET" && !key) {
    if (url.searchParams.get("list-type") !== "2") {
      res.writeHead(400, { "Content-Type": "application/xml" });
      res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>NotImplemented</Code><Message>list-type=2 only</Message></Error>`);
      return;
    }
    const prefix = url.searchParams.get("prefix") ?? "";
    const all = [...objects.entries()].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
    const start = Number(url.searchParams.get("continuation-token") ?? "0") || 0;
    const page = all.slice(start, start + 1000);
    const next = start + 1000 < all.length ? String(start + 1000) : null;
    const contents = page.map(([k, v]) =>
      `<Contents><Key>${esc(k)}</Key><LastModified>${v.updated}</LastModified><ETag>"${md5(v.body)}"</ETag><Size>${v.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`).join("");
    res.writeHead(200, { "Content-Type": "application/xml" });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><Prefix>${esc(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>${next ? "true" : "false"}</IsTruncated>${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ""}${contents}</ListBucketResult>`);
    return;
  }
  if (req.method === "PUT" && key) {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      objects.set(key, { body, updated: new Date().toISOString() });
      res.writeHead(200, { ETag: `"${md5(body)}"` });
      res.end();
    });
    return;
  }
  if (req.method === "GET" && key) {
    const found = objects.get(key);
    if (!found) {
      res.writeHead(404, { "Content-Type": "application/xml" });
      res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>${esc(key)}</Message></Error>`);
      return;
    }
    res.writeHead(200, { "Content-Length": String(found.body.length), ETag: `"${md5(found.body)}"`, "Content-Type": "application/octet-stream" });
    res.end(found.body);
    return;
  }
  if (req.method === "DELETE" && key) {
    objects.delete(key);
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(501, { "Content-Type": "application/xml" });
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>NotImplemented</Code><Message>${req.method} ${esc(url.pathname)}</Message></Error>`);
}).listen(port, "127.0.0.1", () => {
  process.stdout.write(`stub-s3 listening on 127.0.0.1:${port} bucket=${bucket}\n`);
});
