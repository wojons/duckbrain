/**
 * Stdio MCP Entry Point
 *
 * Entry point for running DuckBrain as an MCP server with stdio transport.
 * Used by local Claude Desktop integration.
 *
 * Usage:
 *   node src/cli/stdio.ts
 *
 * Or via CLI:
 *   duckbrain stdio
 */

import { server, stopServer } from '../mcp/server.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

/**
 * Start DuckBrain MCP server in stdio mode
 *
 * This function:
 * 1. Creates a StdioServerTransport for stdin/stdout communication
 * 2. Connects the MCP server to the transport
 * 3. Logs startup message to stderr (stdout reserved for MCP protocol)
 * 4. Sets up graceful shutdown handlers
 */
export async function startStdioMode(): Promise<void> {
  try {
    // Create stdio transport for MCP protocol
    const transport = new StdioServerTransport();

    // Connect server to transport
    await server.connect(transport);

    // Log startup to stderr (NOT stdout - stdout is for MCP protocol)
    console.error('[duckbrain] MCP server started in stdio mode');

    // Handle graceful shutdown
    const shutdown = async () => {
      await stopServer();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    // Log errors to stderr
    console.error('[duckbrain] Failed to start stdio mode:', error);
    process.exit(1);
  }
}

// Auto-start if run directly
if (process.argv[1]?.endsWith('stdio.ts') || process.argv[1]?.endsWith('stdio.js')) {
  startStdioMode().catch((error: unknown) => {
    console.error('[duckbrain] Unhandled error:', error);
    process.exit(1);
  });
}
