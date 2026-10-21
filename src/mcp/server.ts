/**
 * DuckBrain MCP Server
 *
 * Main MCP server with stdio transport.
 * Registers all tools: remember, recall, list_keys, forget
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeJsonStringify } from "../utils/serialize";
import { z } from "zod";
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
import {
  listProfilesToolDef,
  createProfileToolDef,
  updateProfileToolDef,
  selectProfilesToolDef,
} from "./tools/profiles";
import { filterToolsList } from "./profiles";
import path from "path";
import { CustomRuntimeManager, jsonSchemaToZodShape } from "./custom-runtime";
import { registerCustomTools, customToolCallResult } from "./tools/custom-tool";
import type { CustomToolFailure, CustomToolResult } from "./custom-runtime";
import { resolveDuckbrainRoot, getConfig } from "../config/index";

/**
 * MCP Server instance
 */
export const server = new McpServer({
  name: "duckbrain",
  version: "1.1.0",
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

  // MCP-CUSTOM-RUNTIME-001: integrator-declared custom tools become
  // first-class MCP tools. A bad customTools config never blocks the
  // built-ins — every refusal is reported and the surface stays up.
  const customManager = getCustomRuntimeManager();
  if (customManager !== undefined) {
    registerCustomToolsOnServer(customManager);
  }

  // MCP-CONNECTION-PROFILES-001: profile management tools. Visibility-only
  // surfaces — they never grant, revoke, or broaden authority (see
  // src/mcp/profiles.ts for the composition contract and the hard boundary).
  const profileTools: Array<{
    name: string;
    title: string;
    description: string;
    inputSchema: z.ZodTypeAny;
    handler: (input: any) => Promise<any>;
  }> = [
    listProfilesToolDef,
    createProfileToolDef,
    updateProfileToolDef,
    selectProfilesToolDef,
  ];
  for (const def of profileTools) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema,
      },
      wrapHandler(def.handler),
    );
  }
}

/**
 * MCP-CUSTOM-RUNTIME-001: the custom runtime manager for this process.
 *
 * Built once from the resolved config (test seam: `setCustomRuntimeManager`);
 * `undefined` when the config carries no `customTools` block or the block is
 * disabled — the custom surface is then simply absent from tools/list.
 */
let customRuntimeManager: CustomRuntimeManager | undefined;

/** Test/embedder seam: install or clear the process-wide manager. */
export function setCustomRuntimeManager(
  manager: CustomRuntimeManager | undefined,
): void {
  customRuntimeManager = manager;
}

function getCustomRuntimeManager(): CustomRuntimeManager | undefined {
  if (customRuntimeManager !== undefined) return customRuntimeManager;
  const config = getConfig(resolveDuckbrainRoot());
  const block = (config as { customTools?: { enabled?: boolean } }).customTools;
  if (!block?.enabled) return undefined;
  customRuntimeManager = new CustomRuntimeManager(
    config,
    resolveDuckbrainRoot(),
  );
  return customRuntimeManager;
}

/**
 * Wire the manager's tools onto the MCP server: one registerTool per valid
 * declaration, executing directly through the sandbox on tools/call.
 */
function registerCustomToolsOnServer(manager: CustomRuntimeManager): void {
  registerCustomTools(
    manager,
    (name, config, handler) => {
      // The declared JSON Schema becomes the tool's transport-level
      // inputSchema (via zod): tools/list shows the integrator's contract
      // and the SDK rejects malformed args before the handler runs. The
      // runtime re-validates the same schema at execution time.
      server.registerTool(
        name,
        {
          description: config.description,
          _meta: config._meta,
          inputSchema: jsonSchemaToZodShape(config.inputSchema),
        },
        async (args: Record<string, unknown>) => {
          const outcome = (await handler(args)) as
            CustomToolResult | CustomToolFailure;
          return customToolCallResult(outcome) as {
            content: Array<{ type: "text"; text: string }>;
            isError?: boolean;
          };
        },
      );
    },
    new Set([
      recallToolMetadata.name,
      rememberToolDef.name,
      listKeysToolMetadata.name,
      forgetToolDef.name,
      squashToolDef.name,
      compactionStatsToolDef.name,
      "create_namespace",
      "list_namespaces",
      "switch_namespace",
      "delete_namespace",
      "server_status",
      "server_http_start",
    ]),
  );
}

/**
 * Start the MCP server with stdio transport
 */

/**
 * MCP-CONNECTION-PROFILES-001: filter tools/list by the ACTIVE profile
 * selection (visibility only).
 *
 * Installed AFTER registerTools() so the SDK's own handlers exist; the SDK's
 * setRequestHandler contract explicitly replaces the previous handler for a
 * method, and we wrap the replaced one rather than reimplementing schema
 * conversion. Dispatch also stays inside Protocol._requestHandlers (the
 * Map the JSON-RPC layer looks handlers up in), so a handler that reaches
 * in and replaces ours still sees its replacement called through this
 * wrapper.
 *
 * HARD BOUNDARY: this touches tools/list ONLY. tools/call is untouched —
 * hidden-but-authorized tools keep the existing authorization contract, and
 * a profile can never make an unauthorized call succeed.
 */
let profilesListInterceptionInstalled = false;
export function installProfilesListInterception(): void {
  if (profilesListInterceptionInstalled) return;
  const protocol = (server as unknown as { server: ProtocolLike }).server;
  const existing = protocol._requestHandlers.get("tools/list");
  if (!existing) {
    throw new Error(
      "installProfilesListInterception: no tools/list handler found — call registerTools() first",
    );
  }
  protocol._requestHandlers.set("tools/list", async (request: unknown) => {
    const result = await existing(request, undefined as never);
    if (
      result &&
      typeof result === "object" &&
      Array.isArray((result as { tools?: unknown }).tools)
    ) {
      const filtered = filterToolsList(
        (result as { tools: Array<{ name: string }> }).tools,
      );
      return { ...result, tools: filtered.tools };
    }
    return result;
  });
  profilesListInterceptionInstalled = true;
}

/** Structural seam the interception needs from the SDK Protocol class. */
interface ProtocolLike {
  _requestHandlers: Map<
    string,
    (request: unknown, extra: unknown) => Promise<unknown>
  >;
}

export async function startServer(): Promise<void> {
  // Register all tools
  registerTools();
  installProfilesListInterception();

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
