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
import { getConfig, setConfig } from '../config/index';

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
    console.error('Usage: duckbrain remember <key> --domain=<domain> [--attr=<json>] [--namespace=<name>]');
    process.exit(1);
  }
  
  const key = positional[0];
  const domain = flags.domain || 'general';
  const namespace = flags.namespace || 'default';
  const embeddingText = flags['embedding-text'] || key;
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
      domain,
      attributes,
      embedding_text: embeddingText,
      namespace
    });
    
    if (result.success) {
      console.log(`✓ Remembered ${key} (ID: ${result.id})`);
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
      console.log(`Keys (${result.total || result.keys.length} total):`);
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
    const result = await forgetTool({ id, reason });
    
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
  const { positional } = parseArgs(args);
  const subcommand = positional[0];
  
  if (!subcommand) {
    console.error('Usage: duckbrain config <show|set> [key] [value]');
    process.exit(1);
  }
  
  if (subcommand === 'show') {
    try {
      const config = await getConfig();
      console.log('Current configuration:');
      console.log(JSON.stringify(config, null, 2));
    } catch (error) {
      console.error('Error reading config:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  } else if (subcommand === 'set') {
    const key = positional[1];
    const value = positional[2];
    
    if (!key || !value) {
      console.error('Usage: duckbrain config set <key> <value>');
      process.exit(1);
    }
    
    try {
      await setConfig(key, value);
      console.log(`✓ Set ${key} = ${value}`);
    } catch (error) {
      console.error('Error setting config:', error instanceof Error ? error.message : error);
      process.exit(1);
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
      const config = await getConfig();
      const namespaces = config.namespaces || { default: './memory/default' };
      
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
    const config = await getConfig();
    const nsPath = config.namespaces?.[namespace] || './memory/default';
    
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
  ssh-test           Test SSH tunnel setup
  help               Show this help

Options:
  --namespace=NAME   Select namespace (default: default)
  --help             Show this help

Examples:
  duckbrain stdio
  duckbrain remember /contacts/alice --domain=person --attr='{"name":"Alice"}'
  duckbrain recall --prefix=/projects/
  duckbrain list-keys --depth=3 --limit=20
  duckbrain forget abc-123 --reason="obsolete"
  duckbrain status --namespace=default
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
    help: () => showHelp()
  };
  
  const handler = commands[command];
  
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    console.error('Run "duckbrain help" for usage');
    process.exit(1);
  }
  
  await handler(args);
}
