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
 * Remember tool stub - to be implemented in Plan 02
 */
async function rememberTool(input: unknown) {
  return {
    success: false,
    error: 'remember() tool not yet implemented - coming in Plan 02'
  };
}

/**
 * Forget tool stub - to be implemented in Plan 04
 */
async function forgetTool(input: unknown) {
  return {
    success: false,
    error: 'forget() tool not yet implemented - coming in Plan 04'
  };
}

// listKeysTool imported from ./tools/list_keys

/**
 * Register all tools with the MCP server
 */
function registerTools(): void {
  // Register recall tool
  server.registerTool(recallToolMetadata.name, {
    title: recallToolMetadata.title,
    description: recallToolMetadata.description,
    inputSchema: recallToolMetadata.inputSchema,
    handler: recallTool
  });

  // Register remember tool (stub)
  server.registerTool('remember', {
    title: 'Remember',
    description: 'Store a new memory',
    inputSchema: {},
    handler: rememberTool
  });

  // Register list_keys tool
  server.registerTool(listKeysToolMetadata.name, {
    title: listKeysToolMetadata.title,
    description: listKeysToolMetadata.description,
    inputSchema: listKeysToolMetadata.inputSchema,
    handler: listKeysTool
  });

  // Register forget tool (stub)
  server.registerTool('forget', {
    title: 'Forget',
    description: 'Soft-delete a memory by appending tombstone',
    inputSchema: {},
    handler: forgetTool
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
