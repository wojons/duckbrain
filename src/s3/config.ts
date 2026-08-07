/**
 * Native S3 configuration for DuckBrain.
 *
 * DISABLED BY DEFAULT (2026-08-07, prepared but not activated — see docs/s3-native.md).
 * All S3 features are inert while `s3.enabled` is false.
 *
 * SECRETS POLICY: never store access keys in duckbrain.config.json (it is
 * git-tracked). The AWS SDK v3 default credential chain is used instead:
 *   - env AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, or
 *   - env AWS_PROFILE pointing at ~/.aws/credentials, or
 *   - the default profile in ~/.aws/credentials.
 * The DuckDB httpfs query path (src/s3/query.ts) reads the same env vars.
 */

import { z } from "zod";

/** Zod schema for the `s3` config block (mirrors the gitBatching style). */
export const S3ConfigSchema = z
  .object({
    /** Master switch — all S3 features inert while false */
    enabled: z.boolean().default(false),
    /**
     * S3-compatible endpoint URL, e.g. https://hel1.your-objectstorage.com
     * Omit (undefined) for real AWS S3.
     */
    endpoint: z.string().url().optional(),
    /** AWS region; ignored by most S3-compatible providers (Hetzner: hel1/us-east-1 both work) */
    region: z.string().default("us-east-1"),
    /** Bucket name (required when enabled) */
    bucket: z.string().default("duckbrain"),
    /** Top-level key prefix under the bucket, e.g. "duckbrain" → s3://bucket/duckbrain/<ns>/... */
    prefix: z.string().default("duckbrain"),
    /** ~/.aws/credentials profile name (optional; env AWS_PROFILE is also honored) */
    profile: z.string().optional(),
    /**
     * Path-style addressing (bucket in path, not virtual-host). REQUIRED by
     * Hetzner / MinIO-style endpoints; harmless on AWS.
     */
    forcePathStyle: z.boolean().default(true),
    /**
     * Push namespace deltas to S3 after each autocommit batch flush
     * (piggybacks on the existing gitBatching debounce window → ~30s RPO).
     */
    pushOnCommit: z.boolean().default(false),
    /** Reserved: periodic sync interval (sec) for a future daemon loop */
    intervalSec: z.number().default(300),
  })
  .default({
    enabled: false,
    region: "us-east-1",
    bucket: "duckbrain",
    prefix: "duckbrain",
    forcePathStyle: true,
    pushOnCommit: false,
    intervalSec: 300,
  });

export type S3Config = z.infer<typeof S3ConfigSchema>;

/** Default S3 config (disabled). */
export const DEFAULT_S3_CONFIG = S3ConfigSchema.parse({});
