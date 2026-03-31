/**
 * DuckBrain Memory Schema
 *
 * Hybrid schema with strict base fields + flexible attributes.
 * Enforces filesystem-style hierarchical keys.
 */

import { z } from 'zod';

/**
 * Domain enumeration for memory categorization
 * Defines the top-level partition folders
 */
export const DomainEnum = z.enum([
  'person',
  'event',
  'concept',
  'message',
  'config',
  'raw_note'
]);

export type Domain = z.infer<typeof DomainEnum>;

/**
 * Action types for memory records
 * - add: new memory
 * - update: superseding version (old record stays for history)
 * - tombstone: soft delete marker
 */
export const ActionEnum = z.enum(['add', 'update', 'tombstone']);

export type Action = z.infer<typeof ActionEnum>;

/**
 * Hybrid Memory Schema
 *
 * Base fields (strict, required):
 * - id: UUID for unique identification
 * - key: Hierarchical path starting with / (e.g., /projects/mcp/schema)
 * - domain: Categorization for partitioning
 * - timestamp: ISO-8601 creation time
 * - author: Git email for attribution
 * - action: Operation type
 * - embedding_text: Text for vector search
 *
 * Attributes (flexible):
 * - Any additional structured data as JSON
 */
export const MemorySchema = z.object({
  /** Unique identifier (UUID v4) */
  id: z.string().uuid(),

  /**
   * Hierarchical key with filesystem-style path
   * Must start with / (e.g., /projects/mcp/schema)
   * Used for partitioning and glob queries
   */
  key: z.string().regex(
    /^\//,
    'Key must be a filesystem-style path starting with / (e.g., /projects/mcp)'
  ),

  /** Domain categorization for storage partitioning */
  domain: DomainEnum,

  /** ISO-8601 timestamp of record creation */
  timestamp: z.string().datetime(),

  /** Git email address for authorship attribution */
  author: z.string().email(),

  /** Operation type: add, update, or tombstone */
  action: ActionEnum,

  /** Text content for vector embedding generation */
  embedding_text: z.string(),

  /** Flexible attributes as arbitrary JSON */
  attributes: z.record(z.string(), z.any()).default({})
});

export type MemoryType = z.infer<typeof MemorySchema>;

/**
 * Validate memory record against schema
 * @param data - Raw data to validate
 * @returns Validated MemoryType
 * @throws ZodError if validation fails
 */
export function validateMemory(data: unknown): MemoryType {
  return MemorySchema.parse(data);
}

/**
 * Safe validation that returns errors instead of throwing
 * @param data - Raw data to validate
 * @returns { success: boolean, data?: MemoryType, error?: string }
 */
export function safeValidateMemory(
  data: unknown
): { success: boolean; data?: MemoryType; error?: string } {
  const result = MemorySchema.safeParse(data);
  if (!result.success) {
    return {
      success: false,
      error: (result.error as any).issues.map((i: any) => i.message).join('; ')
    };
  }
  return { success: true, data: result.data };
}

/**
 * Create a new memory record with defaults
 * @param params - Partial memory without generated fields
 * @returns Complete MemoryType with id and timestamp
 */
export function createMemory(params: {
  key: string;
  domain: Domain;
  author: string;
  embedding_text: string;
  attributes?: Record<string, unknown>;
  action?: Action;
}): MemoryType {
  return {
    id: crypto.randomUUID(),
    key: params.key,
    domain: params.domain,
    timestamp: new Date().toISOString(),
    author: params.author,
    action: params.action ?? 'add',
    embedding_text: params.embedding_text,
    attributes: params.attributes ?? {}
  };
}
