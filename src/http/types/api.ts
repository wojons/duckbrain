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
  /** Author email from git */
  author: string;
  /** Whether this is a tombstone (deleted) */
  isTombstone: boolean;
  /** Action type (add, edit, tombstone) */
  action: string;
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
  type: 'folder' | 'memory';
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
export type SseEventType = 'memory.created' | 'memory.updated' | 'memory.deleted' | 'namespace.changed';

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
