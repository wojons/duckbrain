/**
 * DuckBrain Configuration Management
 *
 * Manages configuration file with Zod validation.
 * Stores user preferences, namespace mappings, and git settings.
 */

import fs from "fs";
import path from "path";
import { z } from "zod";

/**
 * Configuration schema
 */
export const DuckBrainConfigSchema = z.object({
  /** Default namespace for operations */
  defaultNamespace: z.string().default("default"),

  /** Author email for attributing memories */
  authorEmail: z.string().email().default("duckbrain@localhost.localdomain"),

  /** Path to namespaces directory */
  namespacesPath: z.string().default("./namespaces"),

  /** Git commit batching settings */
  gitBatching: z
    .object({
      /** Max lines before forcing commit */
      maxLines: z.number().default(100),
      /** Max seconds before forcing commit */
      maxSeconds: z.number().default(30),
      /** Enable/disable background worker */
      enabled: z.boolean().default(true),
    })
    .default({ maxLines: 100, maxSeconds: 30, enabled: true }),

  /** Storage settings */
  storage: z
    .object({
      /** Chunk size in lines */
      maxLinesPerChunk: z.number().default(1000),
      /** Max chunk size in bytes */
      maxBytesPerChunk: z.number().default(1024 * 1024),
    })
    .default({ maxLinesPerChunk: 1000, maxBytesPerChunk: 1024 * 1024 }),

  /** Squash/compaction settings */
  squash: z
    .object({
      /** Compact partitions older than N days */
      maxAgeDays: z.number().default(30),
      /** Only compact if partition has > N records */
      thresholdRecords: z.number().default(1000),
      /** Enable background compaction */
      autoCompact: z.boolean().default(false),
      /** Rewrite git history during compaction */
      squashGitHistory: z.boolean().default(true),
      /** Parquet compression level (1-9) */
      compressionLevel: z.number().min(1).max(9).default(6),
    })
    .default({
      maxAgeDays: 30,
      thresholdRecords: 1000,
      autoCompact: false,
      squashGitHistory: true,
      compressionLevel: 6,
    }),

  /** Namespace mappings (alias -> path) */
  namespaceMappings: z.record(z.string(), z.string()).default({}),

  /** Embedding store settings (vectors are NEVER stored in git) */
  embedding: z
    .object({
      /** Provider id: lmstudio | ollama | openai | auto (default: auto) */
      provider: z.string().default("auto"),
      /** Model name passed to the provider */
      model: z.string().default("text-embedding-qwen3-embedding-0.6b"),
      /** Provider base URL override (e.g. http://localhost:1234/v1) */
      baseUrl: z.string().optional(),
      /** API key for remote providers (env DUCKBRAIN_EMBEDDING_API_KEY preferred) */
      apiKey: z.string().optional(),
      /** Vector dimensions (default 384) */
      dimensions: z.number().default(384),
      /** Cache directory inside the namespace (default .embeddings, gitignored) */
      cacheDir: z.string().default(".embeddings"),
      /** Concurrent embedding requests during rebuild (default 4) */
      concurrency: z.number().default(4),
    })
    .default({
      provider: "auto",
      model: "text-embedding-qwen3-embedding-0.6b",
      dimensions: 384,
      cacheDir: ".embeddings",
      concurrency: 4,
    }),

  /** Native S3 sync/query settings (DISABLED by default — see docs/s3-native.md) */
  s3: z
    .object({
      /** Master switch — all S3 features inert while false */
      enabled: z.boolean().default(false),
      /** S3-compatible endpoint URL; omit for real AWS S3 */
      endpoint: z.string().url().optional(),
      /** AWS region (ignored by most S3-compatible providers) */
      region: z.string().default("us-east-1"),
      /** Bucket name (required when enabled) */
      bucket: z.string().default("duckbrain"),
      /** Top-level key prefix under the bucket */
      prefix: z.string().default("duckbrain"),
      /** ~/.aws/credentials profile name (optional; env AWS_PROFILE also honored) */
      profile: z.string().optional(),
      /** Path-style addressing — required by Hetzner/MinIO-style endpoints */
      forcePathStyle: z.boolean().default(true),
      /** Push namespace deltas after each autocommit batch flush */
      pushOnCommit: z.boolean().default(false),
      /** Reserved: periodic sync interval for a future daemon loop */
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
    }),
});

export type DuckBrainConfig = z.infer<typeof DuckBrainConfigSchema>;

/**
 * Default configuration file name
 */
const CONFIG_FILENAME = "duckbrain.config.json";

/**
 * Get config file path
 *
 * @param configDir - Directory containing config file
 * @returns Full path to config file
 */
function getConfigPath(configDir: string): string {
  return path.join(configDir, CONFIG_FILENAME);
}

/**
 * Get or create configuration
 *
 * @param configDir - Directory for config file (defaults to current dir)
 * @returns Configuration object
 */
export function getConfig(configDir: string = "."): DuckBrainConfig {
  const configPath = getConfigPath(configDir);

  if (!fs.existsSync(configPath)) {
    // Return defaults
    return applyEnvOverrides(DuckBrainConfigSchema.parse({}));
  }

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(content);
    return applyEnvOverrides(DuckBrainConfigSchema.parse(parsed));
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.warn(
        `Warning: Config validation failed at ${configPath}:`,
        (error as any).issues.map((i: any) => i.message).join(", "),
      );
      // Return defaults on validation failure
      return applyEnvOverrides(DuckBrainConfigSchema.parse({}));
    }
    console.warn(
      `Warning: Could not parse config at ${configPath}, using defaults`,
    );
    return applyEnvOverrides(DuckBrainConfigSchema.parse({}));
  }
}

/**
 * Apply environment-variable overrides on top of file config.
 *
 * BUG-037: DUCKBRAIN_NAMESPACES_PATH lets the test suite redirect ALL
 * namespace storage (JSONL + DuckDB files) to an isolated temp directory,
 * so vitest/E2E never collide with the live MCP server's DuckDB file lock
 * on namespaces/default/duckdb.db (root cause of BUG-027 flakiness).
 * Unset in production — file config is authoritative there.
 */
function applyEnvOverrides(config: DuckBrainConfig): DuckBrainConfig {
  const nsPathOverride = process.env.DUCKBRAIN_NAMESPACES_PATH;
  if (nsPathOverride) {
    return { ...config, namespacesPath: nsPathOverride };
  }
  return config;
}

/**
 * Update configuration
 *
 * @param configDir - Directory for config file
 * @param updates - Partial configuration to merge
 * @returns Updated configuration
 */
export function updateConfig(
  configDir: string,
  updates: Partial<DuckBrainConfig>,
): DuckBrainConfig {
  const current = getConfig(configDir);
  const merged = { ...current, ...updates };

  // Validate merged config
  const validated = DuckBrainConfigSchema.parse(merged);

  // Write atomically
  const configPath = getConfigPath(configDir);
  const tmpPath = configPath + ".tmp";

  fs.writeFileSync(tmpPath, JSON.stringify(validated, null, 2) + "\n", "utf-8");
  fs.renameSync(tmpPath, configPath);

  return validated;
}

/**
 * Initialize default configuration
 *
 * @param configDir - Directory for config file
 * @param authorEmail - Required author email
 * @returns Initialized configuration
 */
export function initializeConfig(
  configDir: string,
  authorEmail: string,
): DuckBrainConfig {
  const config: DuckBrainConfig = {
    defaultNamespace: "default",
    authorEmail,
    namespacesPath: "./namespaces",
    gitBatching: {
      maxLines: 100,
      maxSeconds: 30,
      enabled: true,
    },
    storage: {
      maxLinesPerChunk: 1000,
      maxBytesPerChunk: 1024 * 1024,
    },
    squash: {
      maxAgeDays: 30,
      thresholdRecords: 1000,
      autoCompact: false,
      squashGitHistory: true,
      compressionLevel: 6,
    },
    namespaceMappings: {},
    embedding: {
      provider: "auto",
      model: "text-embedding-qwen3-embedding-0.6b",
      dimensions: 384,
      cacheDir: ".embeddings",
      concurrency: 4,
    },
    s3: {
      enabled: false,
      region: "us-east-1",
      bucket: "duckbrain",
      prefix: "duckbrain",
      forcePathStyle: true,
      pushOnCommit: false,
      intervalSec: 300,
    },
  };

  // Ensure directory exists
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  // Write config
  const configPath = getConfigPath(configDir);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

  return config;
}

/**
 * Register namespace mapping
 *
 * @param configDir - Directory for config file
 * @param alias - Short alias for namespace
 * @param fullPath - Absolute path to namespace
 * @returns Updated configuration
 */
export function registerNamespace(
  configDir: string,
  alias: string,
  fullPath: string,
): DuckBrainConfig {
  const config = getConfig(configDir);
  config.namespaceMappings[alias] = fullPath;
  return updateConfig(configDir, config);
}

/**
 * Set a single config key
 *
 * @param key - Config key to set
 * @param value - Value to set
 * @returns Updated configuration
 */
export function setConfig(
  key: keyof DuckBrainConfig,
  value: any,
): DuckBrainConfig {
  return updateConfig(".", { [key]: value });
}
