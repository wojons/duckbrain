/**
 * HTTP API Type Definitions
 *
 * Request/response type definitions for the HTTP API layer.
 * Mirrors MCP tool inputs/outputs for consistent interfaces.
 */

/**
 * Memory response type - represents a memory in API responses
 */
export interface MemoryResponse {
  /** Unique identifier */
  id: string;
  /** Hierarchical key path (e.g., /projects/mcp/schema) */
  key: string;
  /** Domain categorization */
  domain: string;
  /** Memory content (embedding text) */
  content: string;
  /** Flexible attributes */
  attributes: Record<string, unknown>;
  /** ISO timestamp */
  timestamp: string;
  /** RETR-011: optional validity-window start (ISO-8601) — present when the
   *  memory was written with one */
  valid_from?: string;
  /** RETR-011: optional validity-window end (ISO-8601) — present when the
   *  memory was written with one */
  valid_until?: string;
  /** Author email from git */
  author: string;
  /** Whether this is a tombstone (deleted) */
  isTombstone: boolean;
  /** Action type (add, edit, tombstone) */
  action: string;
  /**
   * Cosine similarity to the query vector — present only on semantic ?q=
   * responses (DOGFOOD-011); keyword ?contains= responses carry the BM25
   * score instead (RETR-001)
   */
  score?: number;
  /**
   * Snippet around the first matched token — present only on keyword
   * ?contains= responses (RETR-001)
   */
  snippet?: string;
  /**
   * RETR-008: snippet with the matched term(s) wrapped in `<mark>…</mark>`
   * — present on keyword ?contains= responses alongside the raw snippet
   */
  highlightedSnippet?: string;
  /**
   * Source namespace — present on keyword ?contains= hits (RETR-007): the
   * searched namespace for single-namespace requests, each hit's own
   * namespace for ?allNamespaces=true unions
   */
  namespace?: string;
}

/**
 * Key node in hierarchical tree structure
 */
export interface KeyNode {
  /** Unique identifier (full key path) */
  id: string;
  /** Display name (last segment of key) */
  name: string;
  /** Full key path */
  path: string;
  /** Node type: folder (has children) or leaf (memory) */
  type: "folder" | "memory";
  /** Child nodes (for folders) */
  children?: KeyNode[];
  /** Whether folder is expanded in UI */
  isExpanded?: boolean;
  /** Number of memories under this path */
  memoryCount?: number;
}

/**
 * Namespace response type
 */
export interface NamespaceResponse {
  /** Namespace name */
  name: string;
  /** Full path to namespace */
  path: string;
  /** Whether this is the default namespace */
  isDefault: boolean;
  /** Approximate memory count (may be expensive to calculate) */
  memoryCount?: number;
  /** Last modified timestamp */
  lastModified?: string;
  /**
   * REG-GONE-001: present ONLY on rows whose namespace directory is missing
   * on disk (registry row survives an out-of-band `rm -rf`). Healthy rows
   * omit the flag entirely.
   */
  directoryMissing?: boolean;
  /**
   * DB-GAP-057: present ONLY on union rows that exist as directories under
   * the namespaces root but have NO mapping in the config registry (the
   * be129bc split-brain produced exactly this shape). Rows backed by a
   * registry mapping omit the flag entirely.
   */
  onDiskOnly?: boolean;
}

/**
 * Request to create a new memory
 */
export interface CreateMemoryRequest {
  /** Hierarchical key path */
  key: string;
  /** Domain categorization */
  domain: string;
  /** Memory content text */
  content: string;
  /** Optional attributes */
  attributes?: Record<string, unknown>;
  /** RETR-011: optional validity-window start (ISO-8601 datetime, e.g.
   *  2026-08-19T00:00:00.000Z) — absent = valid from the moment of
   *  writing; a future value keeps the memory out of the current recall
   *  view until that instant */
  valid_from?: string;
  /** RETR-011: optional validity-window end (ISO-8601 datetime) — absent =
   *  valid indefinitely; a past value excludes the memory from the current
   *  recall view (visible with ?historical=true) */
  valid_until?: string;
  /** Optional target namespace — fallback when the ?namespace= query param is absent */
  namespace?: string;
}

/**
 * Request to update an existing memory
 */
export interface UpdateMemoryRequest {
  /** New content (optional - can update just attributes) */
  content?: string;
  /** New attributes (merged with existing if content not provided) */
  attributes?: Record<string, unknown>;
}

/**
 * Query parameters for memory listing
 */
export interface QueryParams {
  /** Key prefix filter (e.g., /projects/) */
  prefix?: string;
  /** Maximum results to return */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Domain filter */
  domain?: string;
  /** Author filter */
  author?: string;
  /** Semantic search query */
  query?: string;
  /** Keyword filter (full-text search over content/key/attributes) */
  contains?: string;
  /** RETR-007: cross-namespace search — with contains=, union keyword hits
   *  over every manifest namespace (each hit carries a namespace facet).
   *  Mutually exclusive with namespace. */
  allNamespaces?: boolean;
  /** RETR-003: only rows at or after this ISO-8601 instant (timestamp or
   *  chat-archive key date facet) */
  after?: string;
  /** RETR-003: only rows at or before this ISO-8601 instant (timestamp or
   *  chat-archive key date facet) */
  before?: string;
  /** RETR-003: ISO-8601 range as START,END — shorthand for after+before */
  between?: string;
  /** RETR-004: git ref or ISO-8601 date — read the namespace state as it
   *  existed at that point in history (date resolves to the nearest commit
   *  at-or-before it) */
  as_of?: string;
  /** RETR-011: view selector — false (default) = current (validity-filtered:
   *  expired valid_until / future valid_from excluded); true = historical
   *  (all rows, expired facts included) */
  historical?: boolean;
  /** Namespace to query */
  namespace?: string;
}

/**
 * Paginated response wrapper
 */
export interface PaginatedResponse<T> {
  /** Result items */
  items: T[];
  /** Total count (may be approximate) */
  total: number;
  /** Current offset */
  offset: number;
  /** Current limit */
  limit: number;
  /** Whether more results available */
  hasMore: boolean;
  /** Next offset (null if no more) */
  nextOffset: number | null;
}

/**
 * API error response
 */
export interface ApiError {
  /** Error message */
  error: string;
  /** Optional error code for client handling */
  code?: string;
  /** HTTP status code */
  status: number;
}

/**
 * SSE event types
 */
export type SseEventType =
  "memory.created" | "memory.updated" | "memory.deleted" | "namespace.changed";

/**
 * SSE event data structure
 */
export interface SseEvent {
  /** Event type */
  type: SseEventType;
  /** Event payload */
  data: unknown;
  /** Event timestamp */
  timestamp: string;
}

/**
 * Memory list response
 */
export interface MemoryListResponse extends PaginatedResponse<MemoryResponse> {
  /** Key path prefixes with counts (for tree view) */
  prefixes?: Record<string, number>;
  /**
   * API-CONTRACT-001: additive alias for `total`, always present and always
   * equal to it. `count` is the spelling most clients reach for first; it was
   * simply absent, so such a client silently read `undefined`/0 and reported
   * "no memories" while the server had returned a full page — a silent-empty
   * rather than a loud error. Both spellings now resolve to the same value.
   */
  count: number;
  /**
   * API-CONTRACT-001: additive alias for `items`, always present and always
   * the same array as `items` (same reference — not a second page).
   */
  memories: MemoryResponse[];
}

/**
 * Key tree response
 */
export interface KeyTreeResponse {
  /** Hierarchical key tree */
  tree: KeyNode[];
  /** Total keys at root level */
  total: number;
}

/**
 * Namespace list response
 */
export interface NamespaceListResponse {
  /** Available namespaces */
  namespaces: NamespaceResponse[];
  /** Currently active namespace */
  currentNamespace: string;
  /**
   * DB-GAP-057: registry-vs-disk drift census, present ONLY when the two
   * sources disagree in either direction (a directory with no mapping, or a
   * mapping whose directory is gone). Omitted when clean.
   */
  drift?: {
    /** Directories under the namespaces root with no config mapping. */
    onDiskOnly: number;
    /** Config mappings whose namespace directory is missing on disk. */
    directoryMissing: number;
  };
}

/**
 * Create namespace request
 */
export interface CreateNamespaceRequest {
  /** Namespace name (alphanumeric, lowercase) */
  name: string;
  /** Set as default namespace */
  setDefault?: boolean;
}

/**
 * Switch namespace request
 */
export interface SwitchNamespaceRequest {
  /** Namespace name to switch to */
  name: string;
}
