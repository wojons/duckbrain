/**
 * DuckBrain Memory Schema
 *
 * Hybrid schema with strict base fields + flexible attributes.
 * Enforces filesystem-style hierarchical keys.
 */

import { z } from "zod";

/**
 * Domain enumeration for memory categorization
 * Defines the top-level partition folders
 */
export const DomainEnum = z.enum([
  "person",
  "event",
  "concept",
  "message",
  "config",
  "raw_note",
]);

export type Domain = z.infer<typeof DomainEnum>;

/**
 * Action types for memory records
 * - add: new memory
 * - update: superseding version (old record stays for history)
 * - tombstone: soft delete marker
 */
export const ActionEnum = z.enum(["add", "update", "tombstone"]);

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
  key: z
    .string()
    .regex(
      /^\//,
      "Key must be a filesystem-style path starting with / (e.g., /projects/mcp)",
    ),

  /** Domain categorization for storage partitioning */
  domain: DomainEnum,

  /** ISO-8601 timestamp of record creation */
  timestamp: z.string().datetime({ offset: true }),

  /** RETR-011: optional validity-window start (ISO-8601 datetime).
   *  Absent = valid from the moment of writing. A future valid_from keeps
   *  the memory out of the current recall view until that instant (it
   *  remains visible with historical=true). */
  valid_from: z.string().datetime().optional(),

  /** RETR-011: optional validity-window end (ISO-8601 datetime).
   *  Absent = valid indefinitely (always current). A past valid_until
   *  keeps the memory out of the current recall view; it remains visible
   *  with historical=true. */
  valid_until: z.string().datetime().optional(),

  /** Git email address for authorship attribution */
  author: z.string().email(),

  /** Operation type: add, update, or tombstone */
  action: ActionEnum,

  /** Text content for vector embedding generation */
  embedding_text: z.string(),

  /** Flexible attributes as arbitrary JSON */
  attributes: z.record(z.string(), z.any()).default({}),
});

export type MemoryType = z.infer<typeof MemorySchema>;

/**
 * DB-GAP-058 — the non-blank content rule.
 *
 * A real memory must carry actual text. An empty or whitespace-only
 * `embedding_text` is not a memory; it is the corruption class behind the
 * 60k+ empty-payload rows in the fleet. Measured before this fix:
 * `"   "`, `"\t\n  "` and the placeholder strings `"null"` / `"undefined"`
 * were accepted by BOTH layers that guard a write — the HTTP route's
 * truthiness test (`!body.content`) and this schema (`z.string()` with no
 * minimum) — so such rows were stored AND replicated to S3.
 *
 * WHY THE RULE IS NOT PART OF `MemorySchema`
 * -----------------------------------------
 * `MemorySchema` is also the READ validator: `readFromJsonl()` calls
 * `MemorySchema.parse()` on every line and throws on failure. Enforcing the
 * non-blank rule there would make every pre-existing blank row unreadable,
 * turning a data problem into a read outage across namespaces that already
 * contain such rows. The rule therefore lives on the WRITE path only, which
 * is where the damage was being done. Tombstones are exempt by definition —
 * a deletion marker has no content (see `tombstoneMemory`).
 */
export const BLANK_CONTENT_MESSAGE =
  "embedding_text must not be empty or whitespace-only";

/**
 * Placeholder bodies that are never a real memory. DECISION (recorded per
 * DB-GAP-058): these are REJECTED. The owner requirement is that memories
 * cannot be written as null, and a row whose body is literally `"null"` is
 * that defect wearing a string costume — it is what made the empty-payload
 * rows indistinguishable from real ones in the corpus. If a genuine note
 * ever needs to be exactly `"null"`, this set is the single place to change.
 */
export const PLACEHOLDER_CONTENT: ReadonlySet<string> = new Set([
  "null",
  "undefined",
  "n/a",
]);

/** True when `text` is not a usable memory body (missing, empty, or blank). */
export function isBlankContent(text: unknown): boolean {
  return typeof text !== "string" || text.trim().length === 0;
}

/** True when `text` is a lone placeholder literal rather than real content. */
export function isPlaceholderContent(text: unknown): boolean {
  return (
    typeof text === "string" &&
    PLACEHOLDER_CONTENT.has(text.trim().toLowerCase())
  );
}

/**
 * ONE write-content policy, consumed by every write entry point (the HTTP
 * routes, the MCP `remember` tool and the CLI `remember` command) so they
 * cannot disagree about what may be stored.
 *
 * @returns a human-readable rejection reason, or `null` when acceptable.
 */
export function writeContentViolation(record: {
  action?: string;
  embedding_text?: unknown;
}): string | null {
  // Tombstones are deletion markers: legitimately no content.
  if (record?.action === "tombstone") return null;
  if (isBlankContent(record?.embedding_text)) return BLANK_CONTENT_MESSAGE;
  if (isPlaceholderContent(record?.embedding_text)) {
    return (
      `embedding_text is the placeholder ${JSON.stringify(String(record.embedding_text).trim())}, ` +
      "not real content"
    );
  }
  return null;
}

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
export function safeValidateMemory(data: unknown): {
  success: boolean;
  data?: MemoryType;
  error?: string;
} {
  const result = MemorySchema.safeParse(data);
  if (!result.success) {
    return {
      success: false,
      error: (result.error as any).issues.map((i: any) => i.message).join("; "),
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
  /** RETR-011: optional validity-window start (ISO-8601) — absent = valid
   *  from the moment of writing */
  valid_from?: string;
  /** RETR-011: optional validity-window end (ISO-8601) — absent = valid
   *  indefinitely */
  valid_until?: string;
}): MemoryType {
  return {
    id: crypto.randomUUID(),
    key: params.key,
    domain: params.domain,
    timestamp: new Date().toISOString(),
    ...(params.valid_from !== undefined
      ? { valid_from: params.valid_from }
      : {}),
    ...(params.valid_until !== undefined
      ? { valid_until: params.valid_until }
      : {}),
    author: params.author,
    action: params.action ?? "add",
    embedding_text: params.embedding_text,
    attributes: params.attributes ?? {},
  };
}
