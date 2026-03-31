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
import { squashToolDef, compactionStatsToolDef } from './tools/squash';
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
 * Wrap a tool handler to convert output to MCP format
 */
function wrapHandler<T>(handler: (input: any) => Promise<T>) {
  return async (args: any) => {
    try {
      const result = await handler(args);
      // Convert result to MCP format
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      console.error('[MCP Handler Error]', error);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
          }
        ]
      };
    }
  };
}

/**
 * Register all tools with the MCP server
 */
function registerTools(): void {
  server.registerTool(recallToolMetadata.name, {
    title: recallToolMetadata.title,
    description: recallToolMetadata.description,
    inputSchema: recallToolMetadata.inputSchema
  }, wrapHandler(recallTool));

  server.registerTool(rememberToolDef.name, {
    title: rememberToolDef.title,
    description: rememberToolDef.description,
    inputSchema: rememberToolDef.inputSchema
  }, wrapHandler(rememberToolDef.handler));

  server.registerTool(listKeysToolMetadata.name, {
    title: listKeysToolMetadata.title,
    description: listKeysToolMetadata.description,
    inputSchema: listKeysToolMetadata.inputSchema
  }, wrapHandler(listKeysTool));

  server.registerTool(forgetToolDef.name, {
    title: forgetToolDef.title,
    description: forgetToolDef.description,
    inputSchema: forgetToolDef.inputSchema
  }, wrapHandler(forgetToolDef.handler));

  server.registerTool(squashToolDef.name, {
    title: squashToolDef.title,
    description: squashToolDef.description,
    inputSchema: squashToolDef.inputSchema
  }, wrapHandler(squashToolDef.handler));

  server.registerTool(compactionStatsToolDef.name, {
    title: compactionStatsToolDef.title,
    description: compactionStatsToolDef.description,
    inputSchema: compactionStatsToolDef.inputSchema
  }, wrapHandler(compactionStatsToolDef.handler));
}

/**
 * Start the MCP server with stdio transport
 */
export async function startServer(): Promise<void> {
  // Register all tools
  registerTools();

  // Log debug info to stderr
  console.error('DuckBrain MCP server starting...');
  console.error('CWD:', process.cwd());
  console.error('Expected .duckbrain path:', path.join(process.cwd(), '.duckbrain'));

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
