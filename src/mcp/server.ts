/**
 * DuckBrain MCP Server
 *
 * Main MCP server with stdio transport.
 * Registers all tools: remember, recall, list_keys, forget
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeJsonStringify } from "../utils/serialize";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeAllConnections } from "../duckdb/connection.js";
import { recallTool, recallToolMetadata } from "./tools/recall";
import { listKeysTool, listKeysToolMetadata } from "./tools/list_keys";
import { rememberToolDef } from "./tools/remember";
import { forgetToolDef } from "./tools/forget";
import { squashToolDef, compactionStatsToolDef } from "./tools/squash";
import {
  createNamespaceTool,
  listNamespacesTool,
  switchNamespaceTool,
  deleteNamespaceTool,
  CreateNamespaceInputSchema,
  ListNamespacesInputSchema,
  SwitchNamespaceInputSchema,
  DeleteNamespaceInputSchema,
} from "./tools/namespace";
import {
  serverStatusTool,
  ServerStatusInputSchema,
  serverHttpStartTool,
  ServerHttpStartInputSchema,
} from "./tools/server";
import path from "path";

/**
 * MCP Server instance
 */
export const server = new McpServer({
  name: "duckbrain",
  version: "1.0.0",
});

/**
 * Wrap a tool handler to convert output to MCP format
 *
 * DOGFOOD-002 (b): tool handlers return error payloads as ordinary objects
 * ({error: "..."}) — without isError, MCP clients cannot distinguish "no
 * results" from "failed". Any result object with a truthy `error` field (or
 * a thrown exception) is surfaced as isError:true while keeping the text
 * payload so the error message stays visible to the agent.
 */
export function wrapHandler<T>(handler: (input: any) => Promise<T>) {
  return async (args: any) => {
    try {
      const result = await handler(args);
      // Convert result to MCP format
      const isError =
        typeof result === "object" &&
        result !== null &&
        "error" in result &&
        Boolean((result as { error?: unknown }).error);
      return {
        content: [
          {
            type: "text" as const,
            text: safeJsonStringify(result, 2),
          },
        ],
        ...(isError ? { isError: true as const } : {}),
      };
    } catch (error) {
      console.error("[MCP Handler Error]", error);
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true as const,
      };
    }
  };
}

/**
 * Register all tools with the MCP server
 */
export function registerTools(): void {
  server.registerTool(
    recallToolMetadata.name,
    {
      title: recallToolMetadata.title,
      description: recallToolMetadata.description,
      inputSchema: recallToolMetadata.inputSchema,
    },
    wrapHandler(recallTool),
  );

  server.registerTool(
    rememberToolDef.name,
    {
      title: rememberToolDef.title,
      description: rememberToolDef.description,
      inputSchema: rememberToolDef.inputSchema,
    },
    wrapHandler(rememberToolDef.handler),
  );

  server.registerTool(
    listKeysToolMetadata.name,
    {
      title: listKeysToolMetadata.title,
      description: listKeysToolMetadata.description,
      inputSchema: listKeysToolMetadata.inputSchema,
    },
    wrapHandler(listKeysTool),
  );

  server.registerTool(
    forgetToolDef.name,
    {
      title: forgetToolDef.title,
      description: forgetToolDef.description,
      inputSchema: forgetToolDef.inputSchema,
    },
    wrapHandler(forgetToolDef.handler),
  );

  server.registerTool(
    squashToolDef.name,
    {
      title: squashToolDef.title,
      description: squashToolDef.description,
      inputSchema: squashToolDef.inputSchema,
    },
    wrapHandler(squashToolDef.handler),
  );

  server.registerTool(
    compactionStatsToolDef.name,
    {
      title: compactionStatsToolDef.title,
      description: compactionStatsToolDef.description,
      inputSchema: compactionStatsToolDef.inputSchema,
    },
    wrapHandler(compactionStatsToolDef.handler),
  );

  server.registerTool(
    "create_namespace",
    {
      title: "Create Namespace",
      description: "Create a new memory namespace (separate git repo)",
      inputSchema: CreateNamespaceInputSchema,
    },
    wrapHandler(createNamespaceTool),
  );

  server.registerTool(
    "list_namespaces",
    {
      title: "List Namespaces",
      description: "List all available namespaces",
      inputSchema: ListNamespacesInputSchema,
    },
    wrapHandler(listNamespacesTool),
  );

  server.registerTool(
    "switch_namespace",
    {
      title: "Switch Namespace",
      description: "Switch to a different namespace",
      inputSchema: SwitchNamespaceInputSchema,
    },
    wrapHandler(switchNamespaceTool),
  );

  server.registerTool(
    "delete_namespace",
    {
      title: "Delete Namespace",
      description: "Delete a namespace (requires confirmation)",
      inputSchema: DeleteNamespaceInputSchema,
    },
    wrapHandler(deleteNamespaceTool),
  );

  server.registerTool(
    "server_status",
    {
      title: "Server Status",
      description:
        "Check whether the DuckBrain HTTP server is listening (TCP port and/or Unix socket), report PID and MCP-over-HTTP endpoints",
      inputSchema: ServerStatusInputSchema,
    },
    wrapHandler(serverStatusTool),
  );

  server.registerTool(
    "server_http_start",
    {
      title: "Start HTTP Server",
      description:
        "Trigger the DuckBrain HTTP server to start as a detached background process if not already running. Supports TCP port, Unix socket, socket permissions and group. Use to enable MCP-over-HTTP.",
      inputSchema: ServerHttpStartInputSchema,
    },
    wrapHandler(serverHttpStartTool),
  );
}

/**
 * Start the MCP server with stdio transport
 */
export async function startServer(): Promise<void> {
  // Register all tools
  registerTools();

  // Log debug info to stderr
  console.error("DuckBrain MCP server starting...");
  console.error("CWD:", process.cwd());
  console.error(
    "Expected .duckbrain path:",
    path.join(process.cwd(), ".duckbrain"),
  );

  // Create stdio transport
  const transport = new StdioServerTransport();

  // Connect server to transport
  await server.connect(transport);

  // Log to stderr (stdout reserved for MCP protocol)
  console.error("DuckBrain MCP server started");
}

/**
 * Stop the MCP server gracefully
 */
export async function stopServer(): Promise<void> {
  await server.close();
  await closeAllConnections();
  console.error("DuckBrain MCP server stopped");
}

// Auto-start if run directly
if (
  process.argv[1]?.endsWith("server.ts") ||
  process.argv[1]?.endsWith("server.js")
) {
  startServer().catch((error) => {
    console.error("Failed to start MCP server:", error);
    process.exit(1);
  });
}
