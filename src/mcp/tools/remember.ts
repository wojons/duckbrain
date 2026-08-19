/**
 * Remember MCP Tool
 *
 * Append a memory to JSONL storage.
 * Validates input, assigns UUID, timestamp, and author from git config.
 */

import { z } from "zod";
import {
  DomainEnum,
  safeValidateMemory,
  createMemory,
} from "../../schema/memory";
import {
  getPartitionPath,
  createPartition,
  appendToJsonl,
} from "../../storage/jsonl";
import { addPartition } from "../../storage/manifest";
import { getAuthorEmail } from "../../git/attribution";
import { commitNamespace } from "../../git/autocommit";
import { normalizeAttributes } from "../../utils/serialize";
import { resolveNamespaceName, resolveNamespacePath } from "./shared";
import path from "path";
import fs from "fs";

/**
 * Input schema for remember tool
 */
const RememberInputSchema = z.object({
  /** Hierarchical key path (e.g., /projects/mcp/schema) */
  key: z
    .string()
    .describe("Hierarchical key path (e.g., /projects/mcp/schema)"),
  /** Domain categorization */
  domain: DomainEnum.describe("Domain categorization"),
  /** Memory attributes as arbitrary JSON (REQUIRED — pass {} if none) */
  attributes: z
    .record(z.string(), z.any(), {
      error:
        'attributes is required (object of arbitrary key/value metadata, e.g. {"author": "alice"})',
    })
    .describe("Memory attributes"),
  /** Text for vector embedding */
  embedding_text: z.string().describe("Text for vector embedding"),
  /** Namespace to write to (defaults to the ACTIVE namespace — config
   *  defaultNamespace, which switch_namespace persists and is therefore
   *  sticky across processes; see docs/api/mcp-tools.md) */
  namespace: z.string().optional().describe("Namespace to write to"),
  /** Author identity override (DB-GAP-031: HTTP routes stamp the
   *  authenticated principal's name here; absent = git-config fallback,
   *  preserving local single-user behavior) */
  author: z
    .string()
    .optional()
    .describe("Author identity (overrides the git config fallback)"),
});

type RememberInput = z.infer<typeof RememberInputSchema>;

/**
 * Output schema for remember tool (hybrid format per D-05)
 */
interface RememberOutput {
  success: boolean;
  id?: string;
  key?: string;
  partition?: string;
  author?: string;
  /** Namespace actually written — resolved from the arg or the active
   *  (config defaultNamespace) namespace when omitted (DOGFOOD-017) */
  namespace?: string;
  /** Present when the write landed outside the 'default' namespace
   *  (DOGFOOD-017) */
  warning?: string;
  error?: string;
}

/**
 * Resolve namespace path from namespace name using config.
 * Falls back to config's defaultNamespace when no namespace is provided.
 */
/**
 * Determine partition value (time-based partitioning)
 * Returns YYYY-MM format
 */
function getTimeBasedPartition(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * Remember tool handler
 *
 * @param input - Tool input parameters
 * @returns Hybrid response with id, key, partition, author
 */
export async function rememberTool(
  input: RememberInput,
): Promise<RememberOutput> {
  try {
    // Validate input
    const parseResult = RememberInputSchema.safeParse(input);
    if (!parseResult.success) {
      return {
        success: false,
        error: `Invalid input: ${(parseResult.error as any).issues.map((i: any) => i.message).join("; ")}`,
      };
    }

    const { key, domain, attributes, embedding_text, namespace, author } =
      parseResult.data;

    // DOGFOOD-010: canonicalize attributes before persisting (JSON
    // round-trip — strips non-JSON values so the JSONL row is exactly what
    // the reader parses back; duplicate keys are impossible in JS objects).
    const normalizedAttributes = normalizeAttributes(attributes);

    // DB-GAP-031: the authenticated principal's identity wins when provided
    // (HTTP routes never forward a client-supplied author); the git-config
    // fallback remains for local single-user (auth=none) mode.
    const authorIdentity = author ?? getAuthorEmail();

    // Create memory with defaults
    const memory = createMemory({
      key,
      domain,
      author: authorIdentity,
      embedding_text,
      attributes: normalizedAttributes,
      action: "add",
    });

    // Validate complete memory
    const validationResult = safeValidateMemory(memory);
    if (!validationResult.success) {
      return {
        success: false,
        error: `Memory validation failed: ${validationResult.error}`,
      };
    }

    // Resolve namespace path — DOGFOOD-017: the response must echo the
    // namespace ACTUALLY written (the resolved one, including when the arg
    // was omitted and the active config defaultNamespace was used).
    const resolvedNamespace = resolveNamespaceName(namespace);
    const namespacePath = resolveNamespacePath(resolvedNamespace);

    // Ensure namespace directory exists
    if (!fs.existsSync(namespacePath)) {
      fs.mkdirSync(namespacePath, { recursive: true });
    }

    // Determine partition path (time-based)
    const partitionValue = getTimeBasedPartition();
    const partitionRelPath = getPartitionPath(
      namespace!,
      domain,
      "time",
      partitionValue,
    );
    const partitionPath = path.join(namespacePath, partitionRelPath);

    // Create partition if not exists
    createPartition(partitionPath);

    // Append to JSONL
    const chunkPath = path.join(partitionPath, "current.jsonl");
    appendToJsonl(chunkPath, memory);

    // Update manifest
    addPartition(namespacePath, partitionRelPath);

    // Auto-commit to namespace git repo
    commitNamespace(namespacePath);

    // Return hybrid response — DOGFOOD-017: echo the namespace actually
    // written, and warn when it is not the 'default' namespace (the active
    // namespace is sticky across processes, so an omitted arg can silently
    // land somewhere the user did not intend).
    const response: RememberOutput = {
      success: true,
      id: memory.id,
      key: memory.key,
      partition: partitionRelPath,
      author: memory.author,
      namespace: resolvedNamespace,
    };
    if (resolvedNamespace !== "default") {
      response.warning = `Memory written to namespace '${resolvedNamespace}', not 'default'. The active namespace is sticky across processes — pass namespace explicitly to control where writes land.`;
    }
    return response;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * MCP tool registration
 */
export const rememberToolDef = {
  name: "remember",
  title: "Remember Memory",
  description: "Append a memory to JSONL storage",
  inputSchema: RememberInputSchema,
  handler: rememberTool,
};
