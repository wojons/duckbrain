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
 *   service     Manage systemd service (install/start/stop/restart/status)
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
import { createHttpServer, startHttpMode } from '../src/cli/http.js';
import { runHumanCLI } from '../src/cli/human.js';
import { closeAllConnections } from '../src/duckdb/connection.js';
import { installService, manageService } from '../src/cli/service.js';

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
  service            Manage systemd service
  remember <key>     Remember a memory
  recall             Query memories
  list-keys          Browse memory structure
  forget <id>        Delete a memory
  config             Show or set configuration
  namespace(s)       Manage namespaces
  pull               Pull changes from remote
  push               Push changes to remote
  remote             Configure remote repository
  status             Show system status
  ssh-test           Test SSH tunnel setup
  squash             Compact old partitions
  help               Show this help

HTTP Options:
  --port=PORT        HTTP server port (default: 3000)
  --bind-all         Bind to all interfaces (0.0.0.0) instead of localhost
  --auth=TYPE        Authentication type: none, basic, apikey (default: none)
  --rate-limit=N     Requests per minute per IP (default: 100)

Service Commands:
  service install [--system]  Install as systemd service
  service start               Start the service
  service stop                Stop the service
  service restart             Restart the service
  service status              Show service status

Options:
  --namespace=NAME   Select namespace (default: default)
  --help             Show this help

Examples:
  duckbrain stdio
  duckbrain http --port=3000
  duckbrain http --auth=basic --rate-limit=60
  duckbrain http --bind-all --port=8080
  duckbrain service install
  duckbrain service start
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
        const bindAll = commandArgs.includes('--bind-all');
        const authArg = commandArgs.find(arg => arg.startsWith('--auth='));
        const rateLimitArg = commandArgs.find(arg => arg.startsWith('--rate-limit='));

        const port = portArg ? parseInt(portArg.split('=')[1]) : 3000;
        const host = bindAll ? '0.0.0.0' : '127.0.0.1';
        const authType = authArg ? authArg.split('=')[1] as 'none' | 'basic' | 'apikey' : 'none';
        const rateLimit = rateLimitArg ? parseInt(rateLimitArg.split('=')[1]) : 100;

        await startHttpMode({ port, host });
        break;
      }
        
      case 'service': {
        const serviceAction = commandArgs[0];
        if (!serviceAction) {
          console.error('Usage: duckbrain service <install|start|stop|restart|status> [--system]');
          process.exit(1);
        }
        
        if (serviceAction === 'install') {
          const isSystem = commandArgs.includes('--system');
          await installService({ system: isSystem });
        } else if (['start', 'stop', 'restart', 'status'].includes(serviceAction)) {
          await manageService(serviceAction as 'start' | 'stop' | 'restart' | 'status');
        } else {
          console.error(`Unknown service action: ${serviceAction}`);
          console.error('Use: install, start, stop, restart, or status');
          process.exit(1);
        }
        break;
      }
        
      case 'remember':
      case 'recall':
      case 'list-keys':
      case 'forget':
      case 'config':
      case 'namespace':
      case 'namespaces':
      case 'pull':
      case 'push':
      case 'remote':
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

// Clear any stale cached connections on startup
// This prevents Napi::Error crashes from corrupted DuckDB singletons
try {
  closeAllConnections();
  console.error('[duckbrain] Cleared stale DuckDB connections');
} catch (e) {
  // Ignore errors during cleanup
}

// Run CLI
main().catch((error) => {
  console.error('[duckbrain] Unhandled error:', error);
  process.exit(1);
});
