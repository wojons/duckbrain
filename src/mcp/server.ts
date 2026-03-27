/**
 * DuckBrain MCP Server
 *
 * Main MCP server with stdio transport.
 * Registers all tools: remember, recall, list_keys, forget
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { recallTool, recallToolMetadata } from './tools/recall';
import { listKeysTool, listKeysToolMetadata } from './tools/list_keys';
import { rememberToolDef } from './tools/remember';
import { forgetToolDef } from './tools/forget';
import path from 'path';
import fs from 'fs';

/**
 * MCP Server instance
 */
export const server = new McpServer({
  name: 'duckbrain',
  version: '1.0.0'
});

/**
 * Register all tools with the MCP server
 */
function registerTools(): void {
  server.registerTool(recallToolMetadata.name, {
    title: recallToolMetadata.title,
    description: recallToolMetadata.description,
    inputSchema: recallToolMetadata.inputSchema,
    handler: recallTool
  });

  server.registerTool(rememberToolDef.name, {
    title: rememberToolDef.title,
    description: rememberToolDef.description,
    inputSchema: rememberToolDef.inputSchema,
    handler: rememberToolDef.handler
  });

  server.registerTool(listKeysToolMetadata.name, {
    title: listKeysToolMetadata.title,
    description: listKeysToolMetadata.description,
    inputSchema: listKeysToolMetadata.inputSchema,
    handler: listKeysTool
  });

  server.registerTool(forgetToolDef.name, {
    title: forgetToolDef.title,
    description: forgetToolDef.description,
    inputSchema: forgetToolDef.inputSchema,
    handler: forgetToolDef.handler
  });
}

/**
 * Start the MCP server with stdio transport
 */
export async function startServer(): Promise<void> {
  // Register all tools
  registerTools();

  // Create stdio transport
  const transport = new StdioServerTransport();

  // Connect server to transport
  await server.connect(transport);

  // Log to stderr (stdout reserved for MCP protocol)
  console.error('DuckBrain MCP server started');
}

/**
 * Stop the MCP server gracefully
 */
export async function stopServer(): Promise<void> {
  await server.close();
  console.error('DuckBrain MCP server stopped');
}

// Auto-start if run directly
if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  startServer().catch(error => {
    console.error('Failed to start MCP server:', error);
    process.exit(1);
  });
}
