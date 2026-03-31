/**
 * Remember MCP Tool
 *
 * Append a memory to JSONL storage.
 * Validates input, assigns UUID, timestamp, and author from git config.
 */

import { z } from 'zod';
import { DomainEnum, ActionEnum, safeValidateMemory, createMemory } from '../../schema/memory';
import { getPartitionPath, createPartition, appendToJsonl } from '../../storage/jsonl';
import { addPartition } from '../../storage/manifest';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

/**
 * Input schema for remember tool
 */
const RememberInputSchema = z.object({
  /** Hierarchical key path (e.g., /projects/mcp/schema) */
  key: z.string().describe('Hierarchical key path (e.g., /projects/mcp/schema)'),
  /** Domain categorization */
  domain: DomainEnum.describe('Domain categorization'),
  /** Memory attributes as arbitrary JSON */
  attributes: z.record(z.string(), z.any()).describe('Memory attributes'),
  /** Text for vector embedding */
  embedding_text: z.string().describe('Text for vector embedding'),
  /** Namespace to write to */
  namespace: z.string().default('default').describe('Namespace to write to')
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
  error?: string;
}

/**
 * Get git config value
 */
function getGitConfig(key: string): string {
  try {
    return execSync(`git config ${key}`, { encoding: 'utf-8' }).trim();
  } catch (error) {
    throw new Error(`Git config '${key}' not set. Run: git config ${key} "value"`);
  }
}

/**
 * Resolve namespace path from namespace name
 */
function resolveNamespacePath(namespace: string): string {
  if (namespace === 'default') {
    return path.join(process.cwd(), '.duckbrain', 'namespaces', 'default');
  }
  return path.join(process.cwd(), '.duckbrain', 'namespaces', namespace);
}

/**
 * Determine partition value (time-based partitioning)
 * Returns YYYY-MM format
 */
function getTimeBasedPartition(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Remember tool handler
 *
 * @param input - Tool input parameters
 * @returns Hybrid response with id, key, partition, author
 */
export async function rememberTool(input: RememberInput): Promise<RememberOutput> {
  try {
    // Validate input
    const parseResult = RememberInputSchema.safeParse(input);
    if (!parseResult.success) {
      return {
        success: false,
        error: `Invalid input: ${(parseResult.error as any).issues.map((i: any) => i.message).join('; ')}`
      };
    }

    const { key, domain, attributes, embedding_text, namespace } = parseResult.data;

    // Get author from git config
    const author = getGitConfig('user.email');

    // Create memory with defaults
    const memory = createMemory({
      key,
      domain,
      author,
      embedding_text,
      attributes,
      action: 'add'
    });

    // Validate complete memory
    const validationResult = safeValidateMemory(memory);
    if (!validationResult.success) {
      return {
        success: false,
        error: `Memory validation failed: ${validationResult.error}`
      };
    }

    // Resolve namespace path
    const namespacePath = resolveNamespacePath(namespace);

    // Ensure namespace directory exists
    if (!fs.existsSync(namespacePath)) {
      fs.mkdirSync(namespacePath, { recursive: true });
    }

    // Determine partition path (time-based)
    const partitionValue = getTimeBasedPartition();
    const partitionRelPath = getPartitionPath(namespace, domain, 'time', partitionValue);
    const partitionPath = path.join(namespacePath, partitionRelPath);

    // Create partition if not exists
    createPartition(partitionPath);

    // Append to JSONL
    const chunkPath = path.join(partitionPath, 'current.jsonl');
    appendToJsonl(chunkPath, memory);

    // Update manifest
    addPartition(namespacePath, partitionRelPath);

    // Return hybrid response
    return {
      success: true,
      id: memory.id,
      key: memory.key,
      partition: partitionRelPath,
      author: memory.author
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * MCP tool registration
 */
export const rememberToolDef = {
  name: 'remember',
  title: 'Remember Memory',
  description: 'Append a memory to JSONL storage',
  inputSchema: RememberInputSchema,
  handler: rememberTool
};
