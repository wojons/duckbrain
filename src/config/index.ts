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
 * DUCKBRAIN_CONFIG_PATH (GAP-022) redirects the config FILE location for
 * BOTH reads and writes — the same env-only pattern as
 * DUCKBRAIN_NAMESPACES_PATH (BUG-037): set only at runtime, never persisted
 * into the file, unset in production = the file in configDir is
 * authoritative. The test suite uses it to keep vitest's updateConfig()
 * writes out of the tracked duckbrain.config.json at the repo root
 * (DOGFOOD-004 parallel-write race observed tick #370).
 *
 * @param configDir - Directory containing config file
 * @returns Full path to config file
 */
function getConfigPath(configDir: string): string {
  const override = process.env.DUCKBRAIN_CONFIG_PATH;
  if (override) {
    return override;
  }
  return path.join(configDir, CONFIG_FILENAME);
}

/**
 * Read and validate the config FILE without applying env overrides.
 *
 * Returns the schema-parsed config exactly as it lives on disk (or schema
 * defaults when the file is missing or invalid). This is the authoritative
 * on-disk state — updateConfig() merges against THIS, not the env-overridden
 * getConfig(), so env-only fields (DUCKBRAIN_NAMESPACES_PATH) never leak into
 * the file. (GAP-007)
 *
 * @param configDir - Directory containing config file
 * @returns Validated config from file (no env overrides applied)
 */
function readFileConfig(configDir: string): DuckBrainConfig {
  const configPath = getConfigPath(configDir);

  if (!fs.existsSync(configPath)) {
    return DuckBrainConfigSchema.parse({});
  }

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(content);
    return DuckBrainConfigSchema.parse(parsed);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.warn(
        `Warning: Config validation failed at ${configPath}:`,
        (error as any).issues.map((i: any) => i.message).join(", "),
      );
    } else {
      console.warn(
        `Warning: Could not parse config at ${configPath}, using defaults`,
      );
    }
    return DuckBrainConfigSchema.parse({});
  }
}

/**
 * Get or create configuration
 *
 * @param configDir - Directory for config file (defaults to current dir)
 * @returns Configuration object (with env overrides applied)
 */
export function getConfig(configDir: string = "."): DuckBrainConfig {
  return applyEnvOverrides(readFileConfig(configDir));
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
 * Merges `updates` into the RAW on-disk config (NOT the env-overridden
 * getConfig()), so env-only fields like DUCKBRAIN_NAMESPACES_PATH — which are
 * runtime-only by design and unset in production — never persist into the file.
 * (GAP-007: the old code used getConfig() as the merge base, which leaked the
 * test suite's /tmp namespacesPath into duckbrain.config.json.)
 *
 * The returned config HAS env overrides applied (callers that immediately use
 * the result see the effective runtime config), but the written file does not.
 *
 * @param configDir - Directory for config file
 * @param updates - Partial configuration to merge
 * @returns Updated configuration (with env overrides applied)
 */
export function updateConfig(
  configDir: string,
  updates: Partial<DuckBrainConfig>,
): DuckBrainConfig {
  // Merge against the raw file config — never the env-overridden getConfig().
  const fileConfig = readFileConfig(configDir);
  const merged = { ...fileConfig, ...updates };

  // Validate merged config
  const validated = DuckBrainConfigSchema.parse(merged);

  // Write atomically — `validated` is derived from the file config so it never
  // carries env-only overrides.
  const configPath = getConfigPath(configDir);
  const tmpPath = configPath + ".tmp";

  fs.writeFileSync(tmpPath, JSON.stringify(validated, null, 2) + "\n", "utf-8");
  fs.renameSync(tmpPath, configPath);

  return applyEnvOverrides(validated);
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
  // Merge the single new mapping into the RAW file config's namespaceMappings.
  // We must NOT pass getConfig() (env-overridden) as the `updates` payload —
  // that would leak env-only fields into the file via the spread merge. (GAP-007)
  const fileConfig = readFileConfig(configDir);
  const namespaceMappings = {
    ...fileConfig.namespaceMappings,
    [alias]: fullPath,
  };
  return updateConfig(configDir, { namespaceMappings });
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
