/**
 * DuckBrain Configuration Management
 *
 * Manages configuration file with Zod validation.
 * Stores user preferences, namespace mappings, and git settings.
 */

import fs from 'fs';
import path from 'path';
import { z } from 'zod';

/**
 * Configuration schema
 */
export const DuckBrainConfigSchema = z.object({
  /** Default namespace for operations */
  defaultNamespace: z.string().default('default'),

  /** Author email for attributing memories */
  authorEmail: z.string().email().default("duckbrain@localhost"),

  /** Path to namespaces directory */
  namespacesPath: z.string().default('./namespaces'),

  /** Git commit batching settings */
  gitBatching: z
    .object({
      /** Max lines before forcing commit */
      maxLines: z.number().default(100),
      /** Max seconds before forcing commit */
      maxSeconds: z.number().default(30),
      /** Enable/disable background worker */
      enabled: z.boolean().default(true)
    })
    .default({ maxLines: 100, maxSeconds: 30, enabled: true }),

  /** Storage settings */
  storage: z
    .object({
      /** Chunk size in lines */
      maxLinesPerChunk: z.number().default(1000),
      /** Max chunk size in bytes */
      maxBytesPerChunk: z.number().default(1024 * 1024)
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
      compressionLevel: z.number().min(1).max(9).default(6)
    })
    .default({
      maxAgeDays: 30,
      thresholdRecords: 1000,
      autoCompact: false,
      squashGitHistory: true,
      compressionLevel: 6
    }),

  /** Namespace mappings (alias -> path) */
  namespaceMappings: z.record(z.string(), z.string()).default({})
});

export type DuckBrainConfig = z.infer<typeof DuckBrainConfigSchema>;

/**
 * Default configuration file name
 */
const CONFIG_FILENAME = 'duckbrain.config.json';

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
export function getConfig(configDir: string = '.'): DuckBrainConfig {
  const configPath = getConfigPath(configDir);

  if (!fs.existsSync(configPath)) {
    // Return defaults
    return DuckBrainConfigSchema.parse({});
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(content);
    return DuckBrainConfigSchema.parse(parsed);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.warn(
        `Warning: Config validation failed at ${configPath}:`,
        (error as any).issues.map((i: any) => i.message).join(', ')
      );
      // Return defaults on validation failure
      return DuckBrainConfigSchema.parse({});
    }
    console.warn(
      `Warning: Could not parse config at ${configPath}, using defaults`
    );
    return DuckBrainConfigSchema.parse({});
  }
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
  updates: Partial<DuckBrainConfig>
): DuckBrainConfig {
  const current = getConfig(configDir);
  const merged = { ...current, ...updates };

  // Validate merged config
  const validated = DuckBrainConfigSchema.parse(merged);

  // Write atomically
  const configPath = getConfigPath(configDir);
  const tmpPath = configPath + '.tmp';

  fs.writeFileSync(tmpPath, JSON.stringify(validated, null, 2), 'utf-8');
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
  authorEmail: string
): DuckBrainConfig {
  const config: DuckBrainConfig = {
    defaultNamespace: 'default',
    authorEmail,
    namespacesPath: './namespaces',
    gitBatching: {
      maxLines: 100,
      maxSeconds: 30,
      enabled: true
    },
    storage: {
      maxLinesPerChunk: 1000,
      maxBytesPerChunk: 1024 * 1024
    },
    squash: {
      maxAgeDays: 30,
      thresholdRecords: 1000,
      autoCompact: false,
      squashGitHistory: true,
      compressionLevel: 6
    },
    namespaceMappings: {}
  };

  // Ensure directory exists
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  // Write config
  const configPath = getConfigPath(configDir);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

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
  fullPath: string
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
  value: any
): DuckBrainConfig {
  return updateConfig('.', { [key]: value });
}
