#!/usr/bin/env node
/**
 * DuckBrain CLI Executable
 *
 * Main CLI entry point that routes commands to appropriate handlers.
 *
 * Usage:
 *   duckbrain <command> [options]
 *
 * Commands:
 *   stdio       Start MCP server for local Claude (stdio mode)
 *   http        Start MCP server with HTTP transport
 *   remember    Remember a memory (human operator)
 *   recall      Query memories (human operator)
 *   list-keys   List memory keys (human operator)
 *   forget      Delete a memory (human operator)
 *   config      Show or set configuration
 *   namespaces  Manage namespaces
 *   status      Show system status
 *   ssh-test    Test SSH tunnel setup
 *   help        Show help message
 */

import { startStdioMode } from '../src/cli/stdio.js';
import { startHttpMode } from '../src/cli/http.js';
import { runHumanCLI } from '../src/cli/human.js';

/**
 * Show help message
 */
function showHelp() {
  console.log(`
DuckBrain v1.0.0 - AI Memory System

Usage: duckbrain <command> [options]

Commands:
  stdio              Start MCP server for local Claude
  http               Start MCP server with HTTP transport
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
  --port=PORT        HTTP server port (default: 3000)
  --help             Show this help

Examples:
  duckbrain stdio
  duckbrain http --port=3000
  duckbrain remember /contacts/alice --domain=person --attr='{"name":"Alice"}'
  duckbrain recall --prefix=/projects/
  duckbrain list-keys --depth=3 --limit=20
  duckbrain forget abc-123 --reason="obsolete"
  duckbrain status --namespace=default
`.trim());
}

/**
 * Main CLI entry point
 */
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const commandArgs = args.slice(1);
  
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    showHelp();
    process.exit(0);
  }
  
  try {
    switch (command) {
      case 'stdio':
        await startStdioMode();
        break;
        
      case 'http': {
        const portArg = commandArgs.find(arg => arg.startsWith('--port='));
        const port = portArg ? parseInt(portArg.split('=')[1]) : 3000;
        await startHttpMode({ port });
        break;
      }
        
      case 'remember':
      case 'recall':
      case 'list-keys':
      case 'forget':
      case 'config':
      case 'namespaces':
      case 'status':
      case 'squash':
      case 'ssh-test':
        await runHumanCLI(command, commandArgs);
        break;
        
      default:
        console.error(`Unknown command: ${command}`);
        console.error('Run "duckbrain help" for usage');
        process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Run CLI
main().catch((error) => {
  console.error('[duckbrain] Unhandled error:', error);
  process.exit(1);
});
