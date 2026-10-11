/**
 * MCP-CUSTOM-RUNTIME-001 — custom-tool registration with the MCP server.
 *
 * Bridges `CustomRuntimeManager` into the standard MCP surface:
 *
 * - each validated custom tool becomes an INDIVIDUAL entry of tools/list
 *   (its own name, description, JSON input schema — no wrapper tool, no
 *   second hop);
 * - tools/call on the tool's own name executes it directly through the
 *   sandboxed runtime;
 * - a failed registration (bad contract / bad module) never blocks the
 *   built-in tools: the failure is reported to the caller and recorded in
 *   the manager's `invalid` list.
 *
 * The built-in function-calling path is untouched: custom tool names live
 * in their own namespace check (the manager), and a name colliding with a
 * built-in is refused at registration (BUILTIN_PREFIXES + collision with
 * the built-in tool list supplied by the caller).
 */

import type { ServerResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CustomRuntimeManager,
  type CustomToolFailure,
} from "../custom-runtime";
import { safeJsonStringify } from "../../utils/serialize";

/**
 * Name segments reserved for built-in tool vocabulary. A custom tool whose
 * name equals one of these is refused — a config file must not be able to
 * shadow `remember`/`recall`/etc. and silently redirect memory writes.
 */
const RESERVED_TOOL_NAMES = new Set([
  "remember",
  "recall",
  "list_keys",
  "forget",
  "squash",
  "get_compaction_stats",
  "create_namespace",
  "list_namespaces",
  "switch_namespace",
  "delete_namespace",
  "server_status",
  "server_http_start",
]);

export function isReservedToolName(name: string): boolean {
  return RESERVED_TOOL_NAMES.has(name);
}

/** MCP tool/list entry for one custom tool. */
export function customToolToDefinition(def: {
  name: string;
  description: string;
  version: string;
  runtime: string;
  inputSchema: unknown;
  capabilities: string[];
}): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  _meta: Record<string, unknown>;
} {
  return {
    name: def.name,
    description: def.description,
    // The declared JSON Schema is already wire-format (JSON Schema object);
    // the SDK serializes it verbatim — no zod re-encoding.
    inputSchema: def.inputSchema as Record<string, unknown>,
    _meta: {
      "duckbrain.dev/customTool": {
        version: def.version,
        runtime: def.runtime,
        capabilities: def.capabilities,
      },
    },
  };
}

/**
 * Convert a sandbox outcome into the MCP CallToolResult shape — the same
 * dual-channel convention the built-ins use (`wrapHandler` in
 * src/mcp/server.ts): the JSON payload is always in content[0].text and a
 * structured failure ALSO sets isError:true.
 */
export function customToolCallResult(
  outcome: CustomToolFailure | { success: true; result: unknown },
): ServerResult {
  const text = safeJsonStringify(outcome, 2);
  return {
    content: [{ type: "text", text }],
    ...(outcome.success ? {} : { isError: true as const }),
  };
}

/**
 * Register every valid custom tool from the manager on the MCP server.
 *
 * `register` is the server's `registerTool` (injected so tests can drive a
 * fresh McpServer without module-level singleton state). `builtinNames` is
 * the set of tool names already registered by the host — a collision is
 * refused with a loud warning, never a silent shadow.
 *
 * Returns the names that were actually registered (and the refusals) so
 * callers/tests can assert the surface.
 */
export function registerCustomTools(
  manager: CustomRuntimeManager,
  register: (
    name: string,
    config: {
      description: string;
      _meta: Record<string, unknown>;
      /** The declared JSON Schema object, for transport-level validation. */
      inputSchema: unknown;
    },
    handler: (args: unknown) => Promise<unknown>,
  ) => unknown,
  builtinNames: ReadonlySet<string>,
): { registered: string[]; refused: Array<{ name: string; reason: string }> } {
  const registered: string[] = [];
  const refused: Array<{ name: string; reason: string }> = [];

  for (const def of manager.listTools()) {
    if (isReservedToolName(def.name)) {
      refused.push({
        name: def.name,
        reason: "name collides with a built-in DuckBrain tool",
      });
      console.error(
        `[MCP Custom Tools] refused '${def.name}': collides with a built-in tool`,
      );
      continue;
    }
    if (builtinNames.has(def.name)) {
      refused.push({
        name: def.name,
        reason: "name already registered by the host",
      });
      console.error(
        `[MCP Custom Tools] refused '${def.name}': already registered by the host`,
      );
      continue;
    }

    try {
      register(
        def.name,
        {
          description: def.description,
          _meta: {
            "duckbrain.dev/customTool": {
              version: def.version,
              runtime: def.runtime,
              capabilities: def.capabilities,
            },
          },
          inputSchema: def.inputSchema,
        },
        async (args: unknown) => {
          const outcome = await manager.exec(def.name, args);
          return outcome; // customToolCallResult() shapes it at the boundary
        },
      );
      registered.push(def.name);
    } catch (e) {
      refused.push({
        name: def.name,
        reason: `registration failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      console.error(`[MCP Custom Tools] failed to register '${def.name}':`, e);
    }
  }

  // Startup diagnostics for every invalid declaration — visible to the
  // operator on stderr, never thrown.
  for (const bad of manager.listInvalid()) {
    console.error(
      `[MCP Custom Tools] invalid declaration at tools[${bad.index}] ignored: ${bad.reason}`,
    );
  }

  return { registered, refused };
}
