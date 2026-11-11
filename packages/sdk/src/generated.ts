// AUTO-GENERATED FILE — do not edit. Regenerate with `pnpm sdk:gen`.
//
// Source: the namespace OpenAPI 3.1 document (packages/sdk/spec/duckbrain.openapi.json),
// captured from generateOpenApi() for the fixture namespace
// "sdk_fixture" (src/sdk/fixture.ts). Every path, parameter and
// shape below is derived from that document; `pnpm sdk:check` and
// src/sdk/drift.test.ts fail when the two disagree.
import { DuckBrainClientBase, type ClientOptions } from "./runtime.js";

// ---------------------------------------------------------------------------
// Document schemas
// ---------------------------------------------------------------------------

export interface MemoryResponse {
  id: string;
  key: string;
  domain: "person" | "event" | "concept" | "message" | "config" | "raw_note";
  content: string;
  attributes: Record<string, unknown>;
  timestamp: string;
  valid_from?: string;
  valid_until?: string;
  author: string;
  isTombstone: boolean;
  action: "add" | "update" | "tombstone";
  score?: number;
  snippet?: string;
  highlightedSnippet?: string;
  namespace?: string;
  namespace_autocreated?: true;
}

export interface MemoryRequest {
  key: string;
  domain: "person" | "event" | "concept" | "message" | "config" | "raw_note";
  content: string;
  attributes?: Record<string, unknown>;
  valid_from?: string;
  valid_until?: string;
  validFrom?: string;
  validUntil?: string;
  namespace?: string;
}

export interface MemoryListResponse {
  items: Array<MemoryResponse>;
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
  count: number;
  memories: Array<MemoryResponse>;
}

export interface ApiError {
  error: string;
  code?: string;
  fields?: { [key: string]: string };
}

/** At least one of content/attributes is required; the server answers 400 VALIDATION_ERROR otherwise. */
export interface MemoryUpdateRequest {
  content?: string;
  attributes?: Record<string, unknown>;
}

export interface TableDeclaration {
  name: string;
  format: "jsonl-objects" | "jsonl-positional";
  columns: Array<{ name: string; type: "varchar" | "integer" | "bigint" | "double" | "boolean" | "timestamp" | "json" }>;
  primary: string | null;
  glob: string;
  declaredKeyColumns?: Array<string>;
  schemaVersion?: number;
  source?: "schema.json" | "legacy";
}

export interface TableDeclarationRequest {
  columns: Array<{ name: string; type: string }>;
  primary?: string;
  format?: "jsonl-objects" | "jsonl-positional";
  policy?: Record<string, unknown>;
  legacy?: boolean;
  force?: boolean;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Server-Sent Events feed for a namespace */
export interface StreamEventsArgs {
  path: {
    namespace: string;
  };
}

/** List memories */
export interface ListMemoriesArgs {
  query?: {
    prefix?: string;
    domain?: "person" | "event" | "concept" | "message" | "config" | "raw_note";
    author?: string;
    q?: string;
    contains?: string;
    allNamespaces?: boolean;
    after?: string;
    before?: string;
    between?: string;
    as_of?: string;
    historical?: boolean;
    limit?: number;
    offset?: number;
    /** Attribute filter; replace <name> with the attribute name. */
    "attr.<name>"?: string;
    /** Namespace to query or write. If omitted, the existing active/default namespace resolution applies. */
    namespace?: string;
  };
}

/** Create a memory */
export interface CreateMemoryArgs {
  query?: {
    /** Namespace to query or write. If omitted, the existing active/default namespace resolution applies. */
    namespace?: string;
  };
  body: { key: string; domain: "person" | "event" | "concept" | "message" | "config" | "raw_note"; content: string; attributes?: Record<string, unknown>; valid_from?: string; valid_until?: string; validFrom?: string; validUntil?: string; namespace?: string };
}

/** Get the latest memory by key */
export interface GetMemoryByKeyArgs {
  path: {
    key: string;
  };
  query?: {
    /** Namespace to query or write. If omitted, the existing active/default namespace resolution applies. */
    namespace?: string;
  };
}

/** Get one memory by id */
export interface GetMemoryArgs {
  path: {
    id: string;
  };
  query?: {
    /** Namespace to query or write. If omitted, the existing active/default namespace resolution applies. */
    namespace?: string;
  };
}

/** Update a memory (new version; the previous version stays in the ledger) */
export interface UpdateMemoryArgs {
  path: {
    id: string;
  };
  query?: {
    /** Namespace to query or write. If omitted, the existing active/default namespace resolution applies. */
    namespace?: string;
  };
  body: MemoryUpdateRequest;
}

/** Delete a memory (writes a tombstone; nothing is erased) */
export interface DeleteMemoryArgs {
  path: {
    id: string;
  };
  query?: {
    /** Namespace to query or write. If omitted, the existing active/default namespace resolution applies. */
    namespace?: string;
  };
}

/** List the tables DECLARED in this namespace */
export interface ListTablesArgs {
}

/** Apply an ordered list of table mutations as ONE unit (all-or-nothing) */
export interface RunTableTransactionArgs {
  body: { actions: Array<{ op: "insert" | "update" | "upsert" | "delete"; table: string; row?: Record<string, unknown>; patch?: Record<string, unknown>; pk?: string }> };
}

/** Select rows from 'lane_scores' */
export interface ListLaneScoresArgs {
  query?: {
    /** Filter by lane. PostgREST conventions: eq|ne|neq|gt|gte|lt|lte|like|ilike|in|is|isdistinct|fts|plfts, any of them negated with the not. prefix (e.g. ?lane=eq.5, ?lane=not.is.null, ?lane=fts.alpha,beta). The full 25-operator coverage table is in docs/api/http-api.md. */
    lane?: string;
    /** Filter by score. PostgREST conventions: eq|ne|neq|gt|gte|lt|lte|like|ilike|in|is|isdistinct|fts|plfts, any of them negated with the not. prefix (e.g. ?score=eq.5, ?score=not.is.null, ?score=fts.alpha,beta). The full 25-operator coverage table is in docs/api/http-api.md. */
    score?: string;
    /** Filter by tags. PostgREST conventions: eq|ne|neq|gt|gte|lt|lte|like|ilike|in|is|isdistinct|fts|plfts, any of them negated with the not. prefix (e.g. ?tags=eq.5, ?tags=not.is.null, ?tags=fts.alpha,beta). The full 25-operator coverage table is in docs/api/http-api.md. */
    tags?: string;
    /** Projection: comma-separated declared columns; `*` selects all columns and `relation(*)` embeds a declared relation. */
    select?: string;
    /** Ordering: comma-separated col.asc / col.desc list (e.g. order=qty.desc,name.asc). */
    order?: string;
    /** Row limit (default 100, hard cap 1000 — larger values clamp). */
    limit?: number;
    /** Row offset for paging. */
    offset?: number;
    /** `count=exact` adds the X-Total-Count response header (same as Prefer: count=exact). */
    count?: "exact";
  };
}

/** Insert row(s) into 'lane_scores' */
export interface InsertLaneScoresArgs {
  body: { lane: string; score: number; tags: Record<string, unknown> } | Array<{ lane: string; score: number; tags: Record<string, unknown> }>;
}

/** Update rows of 'lane_scores' by primary key */
export interface UpdateLaneScoresArgs {
  query?: {
    /** Required. Primary key equality filter: pk=eq.<value> on '(none)'. */
    pk: string;
  };
  body: { lane: string; score: number; tags: Record<string, unknown> };
}

/** Delete rows of 'lane_scores' by primary key */
export interface DeleteLaneScoresArgs {
  query?: {
    /** Required. Primary key equality filter: pk=eq.<value> on '(none)'. */
    pk: string;
  };
}

/** Select rows from 'notes' */
export interface ListNotesArgs {
  query?: {
    /** Filter by id. PostgREST conventions: eq|ne|neq|gt|gte|lt|lte|like|ilike|in|is|isdistinct|fts|plfts, any of them negated with the not. prefix (e.g. ?id=eq.5, ?id=not.is.null, ?id=fts.alpha,beta). The full 25-operator coverage table is in docs/api/http-api.md. */
    id?: string;
    /** Filter by title. PostgREST conventions: eq|ne|neq|gt|gte|lt|lte|like|ilike|in|is|isdistinct|fts|plfts, any of them negated with the not. prefix (e.g. ?title=eq.5, ?title=not.is.null, ?title=fts.alpha,beta). The full 25-operator coverage table is in docs/api/http-api.md. */
    title?: string;
    /** Filter by score. PostgREST conventions: eq|ne|neq|gt|gte|lt|lte|like|ilike|in|is|isdistinct|fts|plfts, any of them negated with the not. prefix (e.g. ?score=eq.5, ?score=not.is.null, ?score=fts.alpha,beta). The full 25-operator coverage table is in docs/api/http-api.md. */
    score?: string;
    /** Filter by created. PostgREST conventions: eq|ne|neq|gt|gte|lt|lte|like|ilike|in|is|isdistinct|fts|plfts, any of them negated with the not. prefix (e.g. ?created=eq.5, ?created=not.is.null, ?created=fts.alpha,beta). The full 25-operator coverage table is in docs/api/http-api.md. */
    created?: string;
    /** Projection: comma-separated declared columns; `*` selects all columns and `relation(*)` embeds a declared relation. */
    select?: string;
    /** Ordering: comma-separated col.asc / col.desc list (e.g. order=qty.desc,name.asc). */
    order?: string;
    /** Row limit (default 100, hard cap 1000 — larger values clamp). */
    limit?: number;
    /** Row offset for paging. */
    offset?: number;
    /** `count=exact` adds the X-Total-Count response header (same as Prefer: count=exact). */
    count?: "exact";
  };
}

/** Insert row(s) into 'notes' */
export interface InsertNotesArgs {
  body: { id: string; title: string; score: number; created: string } | Array<{ id: string; title: string; score: number; created: string }>;
}

/** Update rows of 'notes' by primary key */
export interface UpdateNotesArgs {
  query?: {
    /** Required. Primary key equality filter: pk=eq.<value> on 'id'. */
    pk: string;
  };
  body: { id: string; title: string; score: number; created: string };
}

/** Delete rows of 'notes' by primary key */
export interface DeleteNotesArgs {
  query?: {
    /** Required. Primary key equality filter: pk=eq.<value> on 'id'. */
    pk: string;
  };
}

/** Insert or replace one row of 'notes' by primary key */
export interface UpsertNotesArgs {
  path: {
    pk: string;
  };
  body: { id: string; title: string; score: number; created: string };
}

/** Create or replace a table declaration */
export interface DeclareTableArgs {
  path: {
    table: string;
  };
  body: TableDeclarationRequest;
}

/**
 * operationId → transport + argument + response types. The only thing the
 * client trusts; a document change that is not regenerated shows up here.
 */
export type Specs = {
  streamEvents: {
    method: "get";
    path: "/api/events/{namespace}";
    args: StreamEventsArgs;
    response: AsyncGenerator<Record<string, unknown>>;
  };
  listMemories: {
    method: "get";
    path: "/api/memories";
    args: ListMemoriesArgs;
    response: MemoryListResponse;
  };
  createMemory: {
    method: "post";
    path: "/api/memories";
    args: CreateMemoryArgs;
    response: MemoryResponse;
  };
  getMemoryByKey: {
    method: "get";
    path: "/api/memories/key/{key}";
    args: GetMemoryByKeyArgs;
    response: MemoryResponse;
  };
  getMemory: {
    method: "get";
    path: "/api/memories/{id}";
    args: GetMemoryArgs;
    response: MemoryResponse;
  };
  updateMemory: {
    method: "put";
    path: "/api/memories/{id}";
    args: UpdateMemoryArgs;
    response: MemoryResponse;
  };
  deleteMemory: {
    method: "delete";
    path: "/api/memories/{id}";
    args: DeleteMemoryArgs;
    response: void;
  };
  list_tables: {
    method: "get";
    path: "/api/ns/sdk_fixture/tables";
    args: ListTablesArgs;
    response: { namespace: string; tables: Array<TableDeclaration> };
  };
  run_table_transaction: {
    method: "post";
    path: "/api/ns/sdk_fixture/tables/_transaction";
    args: RunTableTransactionArgs;
    response: void;
  };
  list_lane_scores: {
    method: "get";
    path: "/api/ns/sdk_fixture/tables/lane_scores";
    args: ListLaneScoresArgs;
    response: Array<{ lane: string; score: number; tags: Record<string, unknown> }>;
  };
  insert_lane_scores: {
    method: "post";
    path: "/api/ns/sdk_fixture/tables/lane_scores";
    args: InsertLaneScoresArgs;
    response: { inserted?: number };
  };
  update_lane_scores: {
    method: "patch";
    path: "/api/ns/sdk_fixture/tables/lane_scores";
    args: UpdateLaneScoresArgs;
    response: void;
  };
  delete_lane_scores: {
    method: "delete";
    path: "/api/ns/sdk_fixture/tables/lane_scores";
    args: DeleteLaneScoresArgs;
    response: void;
  };
  list_notes: {
    method: "get";
    path: "/api/ns/sdk_fixture/tables/notes";
    args: ListNotesArgs;
    response: Array<{ id: string; title: string; score: number; created: string }>;
  };
  insert_notes: {
    method: "post";
    path: "/api/ns/sdk_fixture/tables/notes";
    args: InsertNotesArgs;
    response: { inserted?: number };
  };
  update_notes: {
    method: "patch";
    path: "/api/ns/sdk_fixture/tables/notes";
    args: UpdateNotesArgs;
    response: void;
  };
  delete_notes: {
    method: "delete";
    path: "/api/ns/sdk_fixture/tables/notes";
    args: DeleteNotesArgs;
    response: void;
  };
  upsert_notes: {
    method: "put";
    path: "/api/ns/sdk_fixture/tables/notes/{pk}";
    args: UpsertNotesArgs;
    response: void;
  };
  declare_table: {
    method: "post";
    path: "/api/ns/sdk_fixture/tables/{table}/declare";
    args: DeclareTableArgs;
    response: void;
  };
}

/**
 * The namespace these paths were captured for. `NamespaceClient` rewrites
 * this prefix onto the `namespace` option, so one generated client serves
 * every namespace (the document itself is per-namespace by design).
 */
export const DOCUMENT_NAMESPACE = "sdk_fixture";

/** Runtime metadata for every operation (method + path template). */
export const operations = {
  streamEvents: { method: "get", path: "/api/events/{namespace}" },
  listMemories: { method: "get", path: "/api/memories" },
  createMemory: { method: "post", path: "/api/memories" },
  getMemoryByKey: { method: "get", path: "/api/memories/key/{key}" },
  getMemory: { method: "get", path: "/api/memories/{id}" },
  updateMemory: { method: "put", path: "/api/memories/{id}" },
  deleteMemory: { method: "delete", path: "/api/memories/{id}" },
  list_tables: { method: "get", path: "/api/ns/sdk_fixture/tables" },
  run_table_transaction: { method: "post", path: "/api/ns/sdk_fixture/tables/_transaction" },
  list_lane_scores: { method: "get", path: "/api/ns/sdk_fixture/tables/lane_scores" },
  insert_lane_scores: { method: "post", path: "/api/ns/sdk_fixture/tables/lane_scores" },
  update_lane_scores: { method: "patch", path: "/api/ns/sdk_fixture/tables/lane_scores" },
  delete_lane_scores: { method: "delete", path: "/api/ns/sdk_fixture/tables/lane_scores" },
  list_notes: { method: "get", path: "/api/ns/sdk_fixture/tables/notes" },
  insert_notes: { method: "post", path: "/api/ns/sdk_fixture/tables/notes" },
  update_notes: { method: "patch", path: "/api/ns/sdk_fixture/tables/notes" },
  delete_notes: { method: "delete", path: "/api/ns/sdk_fixture/tables/notes" },
  upsert_notes: { method: "put", path: "/api/ns/sdk_fixture/tables/notes/{pk}" },
  declare_table: { method: "post", path: "/api/ns/sdk_fixture/tables/{table}/declare" },
} as const;

/**
 * Typed client for one DuckBrain namespace document.
 *
 * Errors are never re-worded: a refusal surfaces as DuckBrainApiError with
 * the server's `error` string, `code` and `fields` verbatim (table_grant,
 * VALIDATION_ERROR, policy …), so a caller sees WHY, not just 400.
 */
export class NamespaceClient extends DuckBrainClientBase<Specs> {
  protected readonly ops = operations;

  constructor(options: ClientOptions) {
    super(options, DOCUMENT_NAMESPACE);
  }

  /** Server-Sent Events feed for a namespace */
  streamEvents(args?: Specs["streamEvents"]["args"]): AsyncGenerator<Record<string, unknown>> {
    return this.stream("streamEvents", args);
  }

  /** List memories */
  listMemories(args?: Specs["listMemories"]["args"]): Promise<Specs["listMemories"]["response"]> {
    return this.call("listMemories", args);
  }

  /** Create a memory */
  createMemory(args?: Specs["createMemory"]["args"]): Promise<Specs["createMemory"]["response"]> {
    return this.call("createMemory", args);
  }

  /** Get the latest memory by key */
  getMemoryByKey(args?: Specs["getMemoryByKey"]["args"]): Promise<Specs["getMemoryByKey"]["response"]> {
    return this.call("getMemoryByKey", args);
  }

  /** Get one memory by id */
  getMemory(args?: Specs["getMemory"]["args"]): Promise<Specs["getMemory"]["response"]> {
    return this.call("getMemory", args);
  }

  /** Update a memory (new version; the previous version stays in the ledger) */
  updateMemory(args?: Specs["updateMemory"]["args"]): Promise<Specs["updateMemory"]["response"]> {
    return this.call("updateMemory", args);
  }

  /** Delete a memory (writes a tombstone; nothing is erased) */
  deleteMemory(args?: Specs["deleteMemory"]["args"]): Promise<Specs["deleteMemory"]["response"]> {
    return this.call("deleteMemory", args);
  }

  /** List the tables DECLARED in this namespace */
  list_tables(args?: Specs["list_tables"]["args"]): Promise<Specs["list_tables"]["response"]> {
    return this.call("list_tables", args);
  }

  /** Apply an ordered list of table mutations as ONE unit (all-or-nothing) */
  run_table_transaction(args?: Specs["run_table_transaction"]["args"]): Promise<Specs["run_table_transaction"]["response"]> {
    return this.call("run_table_transaction", args);
  }

  /** Select rows from 'lane_scores' */
  list_lane_scores(args?: Specs["list_lane_scores"]["args"]): Promise<Specs["list_lane_scores"]["response"]> {
    return this.call("list_lane_scores", args);
  }

  /** Insert row(s) into 'lane_scores' */
  insert_lane_scores(args?: Specs["insert_lane_scores"]["args"]): Promise<Specs["insert_lane_scores"]["response"]> {
    return this.call("insert_lane_scores", args);
  }

  /** Update rows of 'lane_scores' by primary key */
  update_lane_scores(args?: Specs["update_lane_scores"]["args"]): Promise<Specs["update_lane_scores"]["response"]> {
    return this.call("update_lane_scores", args);
  }

  /** Delete rows of 'lane_scores' by primary key */
  delete_lane_scores(args?: Specs["delete_lane_scores"]["args"]): Promise<Specs["delete_lane_scores"]["response"]> {
    return this.call("delete_lane_scores", args);
  }

  /** Select rows from 'notes' */
  list_notes(args?: Specs["list_notes"]["args"]): Promise<Specs["list_notes"]["response"]> {
    return this.call("list_notes", args);
  }

  /** Insert row(s) into 'notes' */
  insert_notes(args?: Specs["insert_notes"]["args"]): Promise<Specs["insert_notes"]["response"]> {
    return this.call("insert_notes", args);
  }

  /** Update rows of 'notes' by primary key */
  update_notes(args?: Specs["update_notes"]["args"]): Promise<Specs["update_notes"]["response"]> {
    return this.call("update_notes", args);
  }

  /** Delete rows of 'notes' by primary key */
  delete_notes(args?: Specs["delete_notes"]["args"]): Promise<Specs["delete_notes"]["response"]> {
    return this.call("delete_notes", args);
  }

  /** Insert or replace one row of 'notes' by primary key */
  upsert_notes(args?: Specs["upsert_notes"]["args"]): Promise<Specs["upsert_notes"]["response"]> {
    return this.call("upsert_notes", args);
  }

  /** Create or replace a table declaration */
  declare_table(args?: Specs["declare_table"]["args"]): Promise<Specs["declare_table"]["response"]> {
    return this.call("declare_table", args);
  }

}
