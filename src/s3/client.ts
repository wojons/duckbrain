/**
 * Minimal typed S3 client wrapper (AWS SDK v3).
 *
 * Credentials come from the SDK's default provider chain (env vars,
 * ~/.aws/credentials via AWS_PROFILE, etc.) — never from config.
 */

import {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import type { S3Config } from "./config";
import { resolveEffectiveEndpoint } from "./config";

export interface RemoteObject {
  key: string;
  size: number;
  etag?: string;
}

/**
 * Build an S3Client honoring endpoint + path-style settings from config.
 *
 * The endpoint is resolved via resolveEffectiveEndpoint() so an
 * AWS_ENDPOINT_URL_S3 / AWS_ENDPOINT_URL env override wins over the config
 * value — the client and the `s3 status` display can never diverge about
 * which store is actually in use. (DOGFOOD-030)
 */
export function buildClient(cfg: S3Config): S3Client {
  const endpoint = resolveEffectiveEndpoint(cfg);
  return new S3Client({
    region: cfg.region,
    // Profile is honored via AWS_PROFILE env by the default chain; pass it
    // explicitly only when set in config so callers don't need env juggling.
    ...(cfg.profile ? { profile: cfg.profile } : {}),
    ...(endpoint ? { endpoint, forcePathStyle: cfg.forcePathStyle } : {}),
  });
}

/** List all objects under a prefix (paginated). */
export async function listRemoteObjects(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<Map<string, RemoteObject>> {
  const out = new Map<string, RemoteObject>();
  let token: string | undefined;
  do {
    const resp = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    for (const o of resp.Contents ?? []) {
      if (!o.Key) continue;
      out.set(o.Key, { key: o.Key, size: o.Size ?? 0, etag: o.ETag });
    }
    token = resp.NextContinuationToken;
  } while (token);
  return out;
}

/** Upload a local file buffer to a key. */
export async function putObject(
  client: S3Client,
  bucket: string,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

/** Download an object's body as a Buffer. */
export async function getObject(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<Buffer> {
  const resp = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  // Body is a streaming blob in Node SDK v3
  const body = resp.Body as unknown as
    { transformToByteArray(): Promise<Uint8Array> } | undefined;
  if (!body) throw new Error(`Empty body for s3://${bucket}/${key}`);
  const bytes = await body.transformToByteArray();
  return Buffer.from(bytes);
}

/** Delete a single object (missing objects are treated as success by S3). */
export async function deleteObject(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
