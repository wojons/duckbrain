/**
 * Human Operator CLI Commands
 *
 * Provides human-readable CLI commands for managing memories.
 * These commands call the underlying MCP tools internally.
 *
 * Commands:
 * - remember <key> --domain=<domain> --attr=<json> [--namespace=<name>]
 * - recall [options]
 * - list-keys [options]
 * - forget <id> [--reason=<reason>]
 * - config show|set
 * - namespaces list|add
 * - status [--namespace=<name>]
 * - ssh-test --host=<user@server>
 */

import { recallTool } from '../mcp/tools/recall';
import { listKeysTool } from '../mcp/tools/list_keys';
import { rememberTool } from '../mcp/tools/remember';
import { forgetTool } from '../mcp/tools/forget';
import { squashTool, getCompactionStatsTool } from '../mcp/tools/squash';
import { getConfig, setConfig } from '../config/index';
import { getGitWorker } from '../git/worker';

/**
 * Parse command-line arguments
 * Returns object with positional args and named flags
 */
function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      flags[key] = value || 'true';
    } else if (arg.startsWith('-')) {
      // Short flags
      flags[arg.slice(1)] = 'true';
    } else {
      positional.push(arg);
    }
  }
  
  return { positional, flags };
}

/**
 * Format memory output for human readability
 */
function formatMemory(memory: any): string {
  return JSON.stringify(memory, null, 2);
}

/**
 * Format key tree for human readability
 */
function formatKeyTree(keys: string[], depth: number = 2): string {
  const tree: Record<string, any> = {};
  
  for (const key of keys) {
    const parts = key.split('/').slice(0, depth);
    let current = tree;
    for (const part of parts) {
      if (!current[part]) {
        current[part] = {};
      }
      current = current[part];
    }
  }
  
  return JSON.stringify(tree, null, 2);
}

/**
 * Remember command
 */
async function rememberCommand(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  
  if (positional.length < 1) {
    console.error('Usage: duckbrain remember <key> --domain=<domain> [--attr=<json>] [--namespace=<name>] [--wait]');
    process.exit(1);
  }
  
  const key = positional[0];
  const domain = flags.domain || 'general';
  const namespace = flags.namespace || 'default';
  const embeddingText = flags['embedding-text'] || key;
  const waitForCommit = flags.wait !== undefined;
  let attributes = {};
  
  if (flags.attr) {
    try {
      attributes = JSON.parse(flags.attr);
    } catch (error) {
      console.error('Error: --attr must be valid JSON');
      process.exit(1);
    }
  }
  
  try {
    const result = await rememberTool({
      key,
      domain: domain as 'message' | 'person' | 'event' | 'concept' | 'config' | 'raw_note',
      attributes,
      embedding_text: embeddingText,
      namespace
    }, waitForCommit);
    
    if (result.success) {
      if (waitForCommit) {
        console.log(`✓ Remembered ${key} (ID: ${result.id}) - committed`);
      } else {
        console.log(`✓ Remembered ${key} (ID: ${result.id}) - will be committed in batch`);
      }
    } else {
      console.error('✗ Failed to remember:', result.error);
      process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

/**
 * Recall command
 */
async function recallCommand(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  
  const input: any = {
    namespace: flags.namespace || 'default',
    limit: parseInt(flags.limit) || 10
  };
  
  if (flags.key) {
    input.mode = 'exact';
    input.key = flags.key;
  } else if (flags.prefix) {
    input.mode = 'prefix';
    input.prefix = flags.prefix;
  } else if (flags.domain) {
    input.mode = 'domain';
    input.domain = flags.domain;
  } else if (flags.query) {
    input.mode = 'semantic';
    input.query = flags.query;
  } else {
    input.mode = 'prefix';
    input.prefix = '/';
  }
  
  try {
    const result = await recallTool(input);
    
    if (result.memories && result.memories.length > 0) {
      console.log(`Found ${result.memories.length} memories:`);
      for (const memory of result.memories) {
        console.log(formatMemory(memory));
      }
    } else {
      console.log('No memories found');
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

/**
 * List-keys command
 */
async function listKeysCommand(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  
  const input: any = {
    namespace: flags.namespace || 'default',
    limit: parseInt(flags.limit) || 50,
    offset: parseInt(flags.offset) || 0
  };
  
  if (flags.prefix) {
    input.prefix = flags.prefix;
  }
  
  if (flags.depth) {
    input.depth = parseInt(flags.depth);
  }
  
  if (flags.regex) {
    input.regex = flags.regex;
  }
  
  try {
    const result = await listKeysTool(input);
    
    if (result.keys) {
      console.log(`Keys (${result.keys.length} total):`);
      console.log(formatKeyTree(result.keys, input.depth || 2));
      
      if (result.hasMore) {
        console.log(`\nPage ${Math.floor(input.offset / input.limit) + 1} - Use --offset=${input.offset + input.limit} for next page`);
      }
    } else {
      console.log('No keys found');
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

/**
 * Forget command
 */
async function forgetCommand(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  
  if (positional.length < 1) {
    console.error('Usage: duckbrain forget <id> [--reason=<reason>]');
    process.exit(1);
  }
  
  const id = positional[0];
  const reason = flags.reason || 'User requested';
  
  try {
    const result = await forgetTool({ id, namespace: 'default', reason });
    
    if (result.success) {
      console.log(`✓ Forgotten ${id}`);
    } else {
      console.error('✗ Failed to forget:', result.error);
      process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

/**
 * Config command
 */
async function configCommand(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const subcommand = positional[0];
  
  if (!subcommand) {
    console.error('Usage: duckbrain config <show|set>');
    process.exit(1);
  }
  
  if (subcommand === 'show') {
    try {
      const config = getConfig();
      console.log('DuckBrain Configuration:');
      console.log(JSON.stringify(config, null, 2));
    } catch (error) {
      console.error('Error reading config:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  } else if (subcommand === 'set') {
    const key = positional[1];
    const value = positional[2];
    
    if (!key || value === undefined) {
      console.error('Usage: duckbrain config set <key> <value>');
      process.exit(1);
    }
    
    // Handle nested keys like git.batchLines
    if (key === 'git.batchLines') {
      const config = getConfig();
      config.gitBatching.maxLines = parseInt(value, 10);
      setConfig('gitBatching', config.gitBatching);
      console.log(`✓ Config git.batchLines set to ${value}`);
    } else if (key === 'git.batchIntervalMs') {
      const config = getConfig();
      config.gitBatching.maxSeconds = Math.floor(parseInt(value, 10) / 1000);
      setConfig('gitBatching', config.gitBatching);
      console.log(`✓ Config git.batchIntervalMs set to ${value}`);
    } else if (key === 'git.batching.enabled') {
      const config = getConfig();
      config.gitBatching.enabled = value === 'true';
      setConfig('gitBatching', config.gitBatching);
      console.log(`✓ Config git.batching.enabled set to ${value}`);
    } else {
      setConfig(key as any, value);
      console.log(`✓ Config ${key} set to ${value}`);
    }
  } else {
    console.error(`Unknown config subcommand: ${subcommand}`);
    process.exit(1);
  }
}

/**
 * Namespaces command
 */
async function namespacesCommand(args: string[]): Promise<void> {
  const { positional } = parseArgs(args);
  const subcommand = positional[0];
  
  if (!subcommand) {
    console.error('Usage: duckbrain namespaces <list|add>');
    process.exit(1);
  }
  
  if (subcommand === 'list') {
    try {
      const config = getConfig();
      const namespaces = config.namespaceMappings || { default: './memory/default' };
      
      console.log('Configured namespaces:');
      for (const [name, path] of Object.entries(namespaces)) {
        console.log(`  ${name}: ${path}`);
      }
    } catch (error) {
      console.error('Error reading namespaces:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  } else if (subcommand === 'add') {
    const name = positional[1];
    const path = positional[2];
    
    if (!name || !path) {
      console.error('Usage: duckbrain namespaces add <name> <path-or-git-url>');
      process.exit(1);
    }
    
    console.log(`✓ Namespace "${name}" added (config update not yet implemented)`);
  } else {
    console.error(`Unknown namespaces subcommand: ${subcommand}`);
    process.exit(1);
  }
}

/**
 * Status command
 */
async function statusCommand(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const namespace = flags.namespace || 'default';
  
  try {
    const config = getConfig();
    const nsPath = config.namespaceMappings?.[namespace] || './memory/default';
    
    console.log(`DuckBrain Status`);
    console.log(`================`);
    console.log(`Namespace: ${namespace}`);
    console.log(`Path: ${nsPath}`);
    console.log(`Status: OK`);
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

/**
 * SSH test command
 */
async function sshTestCommand(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const host = flags.host;
  
  if (!host) {
    console.error('Usage: duckbrain ssh-test --host=<user@server>');
    process.exit(1);
  }
  
  console.log(`SSH Tunnel Test`);
  console.log(`===============`);
  console.log(`Host: ${host}`);
  console.log(``);
  console.log(`To connect via SSH tunnel:`);
  console.log(`  ssh ${host} "duckbrain stdio"`);
  console.log(``);
  console.log(`For Claude Desktop config, add to claude_desktop_config.json:`);
  console.log(`  {`);
  console.log(`    "mcpServers": {`);
  console.log(`      "duckbrain": {`);
  console.log(`        "command": "ssh",`);
  console.log(`        "args": ["${host}", "duckbrain", "stdio"]`);
  console.log(`      }`);
  console.log(`    }`);
  console.log(`  }`);
}

/**
 * Squash command
 */
async function squashCommand(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);

  const input: any = {
    dryRun: flags['dry-run'] || false,
    aggressive: flags.aggressive || false
  };

  if (flags.partition) {
    input.partition = flags.partition;
  }

  // Handle --stats flag separately
  if (flags.stats) {
    try {
      const result = await getCompactionStatsTool({});

      if (result.success && result.stats) {
        const stats = result.stats;
        console.log('DuckBrain Compaction Statistics');
        console.log('================================');
        console.log(`Total Size: ${(stats.totalSize / 1024 / 1024).toFixed(2)} MB`);
        console.log(`Total Partitions: ${stats.totalPartitions}`);
        console.log(`  - JSONL: ${stats.jsonlPartitions}`);
        console.log(`  - Parquet: ${stats.parquetPartitions}`);
        console.log(``);
        console.log(`Total Records: ${stats.totalRecords.toLocaleString()}`);
        console.log(`Tombstones: ${stats.tombstoneRecords.toLocaleString()} (${stats.tombstonePercent}%)`);
        console.log(`Parquet Ratio: ${stats.parquetRatio}%`);
        console.log(``);

        if (stats.oldPartitions.length > 0) {
          console.log(`Old Partitions (>30 days): ${stats.oldPartitions.length}`);
          for (const p of stats.oldPartitions.slice(0, 5)) {
            console.log(`  - ${p}`);
          }
          if (stats.oldPartitions.length > 5) {
            console.log(`  ... and ${stats.oldPartitions.length - 5} more`);
          }
        }

        if (stats.largePartitions.length > 0) {
          console.log(``);
          console.log(`Large Partitions (>1000 records): ${stats.largePartitions.length}`);
          for (const p of stats.largePartitions.slice(0, 5)) {
            console.log(`  - ${p.path}: ${p.records.toLocaleString()} records, ${(p.size / 1024).toFixed(2)} KB`);
          }
          if (stats.largePartitions.length > 5) {
            console.log(`  ... and ${stats.largePartitions.length - 5} more`);
          }
        }
      } else {
        console.error('Error getting stats:', result.error);
        process.exit(1);
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
    return;
  }

  try {
    const result = await squashTool(input);

    if (result.success) {
      console.log(result.message);
      if (result.stats) {
        console.log('');
        console.log('Statistics:');
        if (result.stats.partitionsCompacted !== undefined) {
          console.log(`  Partitions compacted: ${result.stats.partitionsCompacted}`);
        }
        if (result.stats.totalRecordsKept !== undefined) {
          console.log(`  Records kept: ${result.stats.totalRecordsKept.toLocaleString()}`);
        }
        if (result.stats.totalRecordsRemoved !== undefined) {
          console.log(`  Records removed: ${result.stats.totalRecordsRemoved.toLocaleString()}`);
        }
      }
      if (result.errors && result.errors.length > 0) {
        console.log('');
        console.log('Warnings:');
        for (const err of result.errors) {
          console.log(`  - ${err}`);
        }
      }
    } else {
      console.error('✗ Squash failed:', result.message);
      if (result.errors) {
        for (const err of result.errors) {
          console.error(`  - ${err}`);
        }
      }
      process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

/**
 * Show help message
 */
function showHelp(): void {
  console.log(`
 DuckBrain v1.0.0 - AI Memory System

 Usage: duckbrain <command> [options]

 Commands:
   stdio              Start MCP server for local Claude
   remember <key>     Remember a memory
   recall             Query memories
   list-keys          Browse memory structure
   forget <id>        Delete a memory
   config             Show or set configuration
   namespaces         Manage namespaces
   status             Show system status
   squash             Compact old partitions
   ssh-test           Test SSH tunnel setup
   help               Show this help

 Options:
   --namespace=NAME   Select namespace (default: default)
   --wait             Wait for git commit (remember command only)
   --help             Show this help

 Squash Options:
   --partition=PATH   Target specific partition
   --dry-run          Preview without modifying files
   --aggressive       Include git history squashing
   --stats            Show compaction statistics

 Examples:
   duckbrain stdio
   duckbrain remember /contacts/alice --domain=person --attr='{"name":"Alice"}'
   duckbrain remember /notes/test --domain=raw_note --wait
   duckbrain recall --prefix=/projects/
   duckbrain list-keys --depth=3 --limit=20
   duckbrain forget abc-123 --reason="obsolete"
   duckbrain status --namespace=default
   duckbrain config set git.batchLines 100
   duckbrain squash --stats
   duckbrain squash --dry-run
   duckbrain squash --partition=person/2025-01 --aggressive
 `.trim());
}

/**
 * Run human CLI command
 * @param command Command name
 * @param args Command arguments
 */
export async function runHumanCLI(command: string, args: string[]): Promise<void> {
  const commands: Record<string, (args: string[]) => Promise<void>> = {
    remember: rememberCommand,
    recall: recallCommand,
    'list-keys': listKeysCommand,
    forget: forgetCommand,
    config: configCommand,
    namespaces: namespacesCommand,
    status: statusCommand,
    'ssh-test': sshTestCommand,
    squash: squashCommand,
    help: async () => showHelp()
  };
  
  const handler = commands[command];
  
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    console.error('Run "duckbrain help" for usage');
    process.exit(1);
  }
  
  await handler(args);
}
