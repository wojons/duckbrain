#!/usr/bin/env node
/**
 * S3 helpers for scripts/restore-proof.sh — BACKUP-RESTORE-PROOF-001.
 *
 * The restore proof must be able to (a) count what actually landed on the
 * remote, (b) destroy its own throwaway prefix, and (c) inject a fault so the
 * proof can be shown to FAIL loudly instead of reporting success. None of
 * those three is a product verb, so they live here rather than in the CLI.
 *
 * SAFETY: every command refuses a prefix that does not start with
 * `restore-proof/`. The proof therefore cannot delete production objects even
 * if a caller passes `--prefix duckbrain`.
 *
 * Credentials: the AWS SDK default provider chain (AWS_PROFILE / env keys),
 * exactly like src/s3/client.ts. Endpoint comes from AWS_ENDPOINT_URL_S3,
 * AWS_ENDPOINT_URL, or --endpoint.
 *
 * Commands (all print one JSON document on stdout):
 *   census       --bucket B --prefix P
 *   delete-prefix --bucket B --prefix P
 *   corrupt-one  --bucket B --prefix P [--ext .jsonl]
 *   delete-one   --bucket B --prefix P [--ext .jsonl]
 */
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";

const SAFE_PREFIX = "restore-proof/";

function usage(code = 2) {
  process.stderr.write(
    "usage: restore-proof-s3.mjs <census|delete-prefix|corrupt-one|delete-one> --bucket B --prefix P [--endpoint E] [--ext .jsonl]\n",
  );
  process.exit(code);
}

const argv = process.argv.slice(2);
const command = argv[0];
if (!command || command.startsWith("-")) usage();

const opts = {};
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) usage();
  opts[a.slice(2)] = argv[++i];
}

const bucket = opts.bucket;
let prefix = opts.prefix;
if (!bucket) usage();
if (!prefix) usage();
if (!prefix.endsWith("/")) prefix += "/";
if (!prefix.startsWith(SAFE_PREFIX)) {
  process.stderr.write(
    `REFUSED: prefix '${prefix}' is outside ${SAFE_PREFIX} — this helper only touches throwaway restore-proof prefixes.\n`,
  );
  process.exit(2);
}

const endpoint = opts.endpoint || process.env.AWS_ENDPOINT_URL_S3 || process.env.AWS_ENDPOINT_URL;
const client = new S3Client({
  region: opts.region || process.env.AWS_DEFAULT_REGION || "us-east-1",
  forcePathStyle: true,
  ...(endpoint ? { endpoint } : {}),
});

async function listAll() {
  const out = [];
  let token;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    for (const o of page.Contents ?? []) out.push({ key: o.Key, size: o.Size ?? 0 });
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return out;
}

async function deleteKeys(keys) {
  let deleted = 0;
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000).map((k) => ({ Key: k }));
    if (batch.length === 0) break;
    await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch } }));
    deleted += batch.length;
  }
  return deleted;
}

/** Payload candidates: the largest object matching `ext` (deterministic). */
async function pickTarget(ext) {
  const objects = (await listAll()).filter((o) => (ext ? o.key.endsWith(ext) : true));
  if (objects.length === 0) {
    process.stderr.write(`no objects under ${prefix} match '${ext || "*"}'\n`);
    process.exit(2);
  }
  objects.sort((a, b) => b.size - a.size || (a.key < b.key ? -1 : 1));
  return objects[0];
}

if (command === "census") {
  const objects = await listAll();
  const bytes = objects.reduce((n, o) => n + o.size, 0);
  console.log(JSON.stringify({ bucket, prefix, objects: objects.length, bytes, sample: objects.slice(0, 3).map((o) => o.key) }));
} else if (command === "delete-prefix") {
  const objects = await listAll();
  const deleted = await deleteKeys(objects.map((o) => o.key));
  const remaining = await listAll();
  console.log(JSON.stringify({ bucket, prefix, deleted, remaining: remaining.length }));
  if (remaining.length !== 0) process.exit(1);
} else if (command === "corrupt-one") {
  // Overwrite one object with DIFFERENT bytes of the SAME length: a restore
  // that only checks file counts or sizes would call this a success, so the
  // negative control also proves the proof compares content, not metadata.
  const target = await pickTarget(opts.ext || ".jsonl");
  const body = await client
    .send(new GetObjectCommand({ Bucket: bucket, Key: target.key }))
    .then((r) => r.Body.transformToByteArray());
  const corrupted = Buffer.from(body);
  for (let i = 0; i < corrupted.length; i++) corrupted[i] ^= 0xff; // same length, different bytes
  await client.send(
    new PutObjectCommand({ Bucket: bucket, Key: target.key, Body: corrupted, ContentType: "application/x-ndjson" }),
  );
  console.log(JSON.stringify({ corrupted: target.key, bytes: corrupted.length }));
} else if (command === "delete-one") {
  const target = await pickTarget(opts.ext || ".jsonl");
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: target.key }));
  console.log(JSON.stringify({ deleted: target.key, bytes: target.size }));
} else {
  usage();
}
