/**
 * SURFACE-PARITY-001 — the single source of truth for DuckBrain's capability
 * surface.
 *
 * Three surfaces ship independently and by hand:
 *   - CLI   `bin/duckbrain.ts` (the command switch) + `src/cli/*` handlers
 *   - HTTP  `src/cli/http.ts` mounts and the `src/http/routes/*` routers
 *   - MCP   `src/mcp/server.ts` registrations and `src/mcp/tools/*` defs
 *
 * Nothing compared them, so a verb could exist on one surface and silently be
 * missing from the other two — which is exactly what had happened (tables
 * declare was CLI-only, squash had no HTTP route, s3 was CLI-only, keyword
 * search had no MCP tool). Each gap was found by reading code, not by a failing
 * test.
 *
 * This file is that comparison's left-hand side: every capability, and every
 * surface it is exposed on. The right-hand side is read from the code itself by
 * `src/surface/inventory.ts`, and `src/surface/parity.ts` diffs the two in both
 * directions (a route with no row fails; a row with no route fails).
 *
 * Convention (from the SURFACE-PARITY-001 row):
 *   - a surface key PRESENT means the capability is implemented there;
 *   - a surface key ABSENT means PENDING (no decision yet) — the diff does not
 *     fail on it, the generated doc renders it as `pending`;
 *   - `na` carries the reason a surface will never have it. Anything absent
 *     must be either pending or explained; "we forgot" is not a state.
 *
 * Adding a route, a tool or a top-level CLI verb without a row here turns the
 * suite red: `src/surface/parity.test.ts`.
 */

export type SurfaceName = "cli" | "http" | "mcp";

/**
 * A CLI binding. `verb` is a top-level verb of the `switch (command)` in
 * bin/duckbrain.ts (machine-checked). `sub`/`dispatcher` describe a sub-verb
 * that a handler dispatches inside its own switch: when `dispatcher` is set the
 * parity test reads that switch's `case` labels, so deleting one fails the same
 * way a deleted route does.
 */
export interface CliBinding {
  verb: string;
  sub?: string;
  dispatcher?: { file: string; fn: string };
}

export interface Capability {
  /** Stable id: `<area>.<verb>`, never a surface name. */
  id: string;
  summary: string;
  cli?: CliBinding;
  /** HTTP routes as `METHOD /path`, path-template form as Express mounts it. */
  http?: readonly string[];
  /** MCP tool names as registered on the server. */
  mcp?: readonly string[];
  /** Deliberate absences, with the reason. */
  na?: Partial<Record<SurfaceName, string>>;
}

/**
 * Routes that exist only in some build shapes: `src/cli/http.ts` mounts either
 * the SPA catch-all (`GET /*splat`) when `packages/ui/dist/index.html` is on
 * disk, or the "UI not built" hint (`GET /`) when it is not — never both. The
 * parity test pins the no-dist shape and additionally exercises the built
 * shape, so whichever one is absent is an allowed-but-unobserved route rather
 * than a mismatch.
 */
export const OPTIONAL_HTTP_ROUTES: Readonly<Record<string, string>> = Object.freeze({
  "GET /*splat": "mounted only when packages/ui/dist/index.html exists (SPA catch-all)",
  "GET /": "mounted only when packages/ui/dist/index.html is ABSENT (the 'UI not built' JSON hint)",
});

const S3_DISPATCHER = { file: "src/s3/cli.ts", fn: "s3Command" } as const;

export const CAPABILITIES: readonly Capability[] = [
  // ── memory records ───────────────────────────────────────────────────────
  {
    id: "memory.remember",
    summary: "Store a memory (key + content) with durability accounting",
    cli: { verb: "remember" },
    http: ["POST /api/memories"],
    mcp: ["remember"],
  },
  {
    id: "memory.recall",
    summary: "Read memories by id, by key prefix, or by filter",
    cli: { verb: "recall" },
    http: [
      "GET /api/memories",
      "GET /api/memories/:id",
      "GET /api/memories/key/*key",
    ],
    mcp: ["recall"],
  },
  {
    id: "memory.update",
    summary: "Patch an existing memory in place",
    http: ["PUT /api/memories/:id"],
  },
  {
    id: "memory.forget",
    summary: "Delete a memory (tombstone + SSE replay integrity)",
    cli: { verb: "forget" },
    http: ["DELETE /api/memories/:id"],
    mcp: ["forget"],
  },
  {
    id: "memory.keys",
    summary: "List the memory key tree / flat keys",
    cli: { verb: "list-keys" },
    http: ["GET /api/keys", "GET /api/keys/flat"],
    mcp: ["list_keys"],
  },
  {
    id: "memory.search",
    summary: "Keyword full-text search over a namespace",
    cli: { verb: "search" },
    http: ["GET /api/search"],
    mcp: ["search"],
  },
  {
    id: "memory.search_index",
    summary: "Maintain the offline keyword-search index (rebuild|status|hooks)",
    cli: { verb: "search-index" },
  },
  {
    id: "memory.tree",
    summary: "Hierarchical memory tree for the Web UI",
    http: ["GET /api/tree"],
  },
  {
    id: "memory.timeline",
    summary: "Chronological memory feed for the Web UI",
    http: ["GET /api/timeline"],
  },
  {
    id: "memory.demote",
    summary: "Move one complete L1 entry out to hermes-memory: `memory demote` (dry-run default)",
    cli: { verb: "memory" },
  },
  {
    id: "memory.squash",
    summary: "Compact old partitions / close a namespace segment",
    cli: { verb: "squash" },
    http: ["POST /api/compaction/squash"],
    mcp: ["squash"],
  },
  {
    id: "memory.compaction_stats",
    summary: "Report compaction statistics for a namespace",
    http: ["GET /api/compaction/stats"],
    mcp: ["get_compaction_stats"],
  },
  {
    id: "memory.consolidate",
    summary: "Cross-namespace daily consolidation digest",
    cli: { verb: "consolidate" },
    http: ["POST /api/ops/consolidate"],
  },
  {
    id: "memory.reads",
    summary: "Read ledger (which keys were actually recalled)",
    http: ["GET /api/reads"],
  },
  {
    id: "memory.receipts",
    summary: "Per-skill/per-session retrieval receipts",
    http: [
      "GET /api/receipts",
      "GET /api/receipts/skill/:skillRef",
      "GET /api/receipts/session/:sessionRef",
      "POST /api/receipts",
    ],
  },

  // ── namespaces ───────────────────────────────────────────────────────────
  {
    id: "namespace.list",
    summary: "List registered namespaces (incl. the UI's directory listing)",
    cli: { verb: "namespaces" },
    http: ["GET /api/namespaces", "GET /namespaces"],
    mcp: ["list_namespaces"],
  },
  {
    id: "namespace.create",
    summary: "Create/register a namespace (`namespaces create`)",
    cli: { verb: "namespaces" },
    http: ["POST /api/namespaces"],
    mcp: ["create_namespace"],
  },
  {
    id: "namespace.switch",
    summary: "Switch the active namespace for the caller",
    cli: { verb: "namespace" },
    http: ["POST /api/namespaces/switch"],
    mcp: ["switch_namespace"],
  },
  {
    id: "namespace.delete",
    summary: "Delete a namespace (`namespaces delete`, destructive, requires confirm)",
    cli: { verb: "namespaces" },
    http: ["DELETE /api/namespaces/:name"],
    mcp: ["delete_namespace"],
  },
  {
    id: "namespace.events",
    summary: "Namespace activity feed",
    http: ["GET /api/events/:namespace"],
  },
  {
    id: "namespace.stats",
    summary: "Per-namespace event/storage statistics",
    http: ["GET /api/events/:namespace/stats"],
  },
  {
    id: "namespace.broadcast",
    summary: "Broadcast an event into a namespace feed",
    http: ["POST /api/events/:namespace/broadcast"],
  },
  {
    id: "namespace.changes",
    summary: "SSE change feed with replay",
    http: ["GET /api/ns/:ns/changes"],
    na: {
      mcp: "SSE is a stream: an MCP tool call returns one response, so there is no place to deliver the feed",
    },
  },
  {
    id: "namespace.openapi",
    summary: "Generated OpenAPI document per namespace",
    http: ["GET /api/ns/:ns/openapi.json"],
  },
  {
    id: "namespace.prune",
    summary: "Prune stale namespace segments (`namespaces prune`, dry-run default)",
    cli: { verb: "namespaces" },
    http: ["POST /api/ops/namespaces/prune"],
  },

  // ── declared tables (SUPA wave) ──────────────────────────────────────────
  {
    id: "table.list",
    summary: "List declared tables and their schemas",
    cli: { verb: "tables" },
    http: ["GET /api/ns/:ns/tables"],
    mcp: ["table_list"],
  },
  {
    id: "table.read",
    summary: "Read rows from a declared table",
    http: ["GET /api/ns/:ns/tables/:table"],
    mcp: ["table_select"],
  },
  {
    id: "table.insert",
    summary: "Insert rows into a declared table",
    http: ["POST /api/ns/:ns/tables/:table"],
    mcp: ["table_insert"],
  },
  {
    id: "table.update",
    summary: "Update rows by primary key (PATCH and PUT/:pk forms)",
    http: [
      "PATCH /api/ns/:ns/tables/:table",
      "PUT /api/ns/:ns/tables/:table/:pk",
    ],
    mcp: ["table_update"],
  },
  {
    id: "table.delete",
    summary: "Delete rows from a declared table",
    http: ["DELETE /api/ns/:ns/tables/:table"],
    mcp: ["table_delete"],
  },
  {
    id: "table.declare",
    summary: "Declare a table (`tables declare`: schema + adoption of matching files)",
    cli: { verb: "tables" },
    http: ["POST /api/ns/:ns/tables/:table/declare"],
    mcp: ["tables_declare"],
  },
  {
    id: "table.transaction",
    summary: "Atomic multi-statement transaction envelope",
    http: ["POST /api/ns/:ns/tables/_transaction"],
  },

  // ── query ────────────────────────────────────────────────────────────────
  {
    id: "query.sql",
    summary: "Read-only SQL over a namespace (template or ad-hoc SELECT)",
    cli: { verb: "query" },
    mcp: ["query"],
  },

  // ── s3 durability plane ──────────────────────────────────────────────────
  {
    id: "s3.status",
    summary: "Object-store sync status (last push, object count, drift)",
    cli: { verb: "s3", sub: "status", dispatcher: S3_DISPATCHER },
    http: ["GET /api/ops/s3/status"],
  },
  {
    id: "s3.sync",
    summary: "Trigger an S3 push/pull for a namespace",
    cli: { verb: "s3", sub: "sync", dispatcher: S3_DISPATCHER },
  },
  {
    id: "s3.query",
    summary: "SQL over the object store's manifest/segments",
    cli: { verb: "s3", sub: "query", dispatcher: S3_DISPATCHER },
  },
  {
    id: "s3.config",
    summary: "Show the resolved S3 configuration",
    cli: { verb: "s3", sub: "config", dispatcher: S3_DISPATCHER },
  },
  {
    id: "s3.clear",
    summary: "Clear remote objects for a namespace (destructive, confirm)",
    cli: { verb: "s3", sub: "clear", dispatcher: S3_DISPATCHER },
  },
  {
    id: "s3.ghosts",
    summary: "List/remove ghost objects left by compaction",
    cli: { verb: "s3", sub: "ghosts", dispatcher: S3_DISPATCHER },
  },

  // ── observability / ops plane ────────────────────────────────────────────
  {
    id: "ops.health",
    summary: "Liveness/readiness probe",
    http: ["GET /health"],
  },
  {
    id: "ops.metrics",
    summary: "Prometheus exposition",
    http: ["GET /metrics"],
  },
  {
    id: "ops.stats",
    summary: "System statistics",
    http: ["GET /stats"],
  },
  {
    id: "ops.users",
    summary: "Distinct authors seen in the store",
    http: ["GET /users"],
  },
  {
    id: "ops.activity",
    summary: "Recent activity feed",
    http: ["GET /activity"],
  },
  {
    id: "ops.ui",
    summary: "Web UI shell (falls back to a JSON hint when packages/ui/dist is absent)",
    http: ["GET /", "GET /*splat"],
  },
  {
    id: "metrics.recall",
    summary: "Roll up MCP-side recall metrics and zero-day alerts",
    cli: { verb: "recall-metrics" },
  },

  // ── server lifecycle ────────────────────────────────────────────────────
  {
    id: "server.status",
    summary: "Report server/connection status",
    cli: { verb: "status" },
    mcp: ["server_status"],
  },
  {
    id: "server.http_start",
    summary: "Start the HTTP transport",
    cli: { verb: "http" },
    na: {
      http: "bootstrap op: the HTTP transport cannot be started from inside the running HTTP transport",
    },
    mcp: ["server_http_start"],
  },
  {
    id: "server.stdio",
    summary: "Start the stdio transport for a local MCP client",
    cli: { verb: "stdio" },
    na: {
      http: "local process seam: a stdio server is owned by the client that spawns it",
      mcp: "a stdio server cannot start itself as a tool",
    },
  },
  {
    id: "server.service",
    summary: "Install/manage the systemd unit",
    cli: { verb: "service" },
    na: {
      http: "host-level operation: systemd unit management needs the host's init, not an API call",
      mcp: "host-level operation: not exposed to agents by design",
    },
  },
  {
    id: "server.remote_cli",
    summary: "Execute a CLI command on a remote daemon over its socket",
    http: ["POST /cli"],
    na: {
      cli: "the CLI is the client of this endpoint, not one of its verbs",
    },
  },
  {
    id: "mcp.transport",
    summary: "MCP Streamable-HTTP transport endpoint",
    http: ["POST /mcp", "GET /mcp"],
    na: {
      cli: "MCP is a protocol surface: it has no CLI verb",
      mcp: "the MCP surface does not expose its own transport as a tool",
    },
  },

  // ── profiles (MCP request scoping) ──────────────────────────────────────
  {
    id: "profiles.list",
    summary: "List memory profiles",
    mcp: ["list_profiles"],
    na: {
      cli: "profile selection scopes an MCP request; there is no CLI session to scope",
      http: "profiles are carried on the MCP connection (profiles header), not on REST calls",
    },
  },
  {
    id: "profiles.create",
    summary: "Create a memory profile",
    mcp: ["create_profile"],
    na: {
      cli: "profile selection scopes an MCP request; there is no CLI session to scope",
      http: "profiles are carried on the MCP connection (profiles header), not on REST calls",
    },
  },
  {
    id: "profiles.update",
    summary: "Update a memory profile",
    mcp: ["update_profile"],
    na: {
      cli: "profile selection scopes an MCP request; there is no CLI session to scope",
      http: "profiles are carried on the MCP connection (profiles header), not on REST calls",
    },
  },
  {
    id: "profiles.select",
    summary: "Select the active profile set for a session",
    mcp: ["select_profiles"],
    na: {
      cli: "profile selection scopes an MCP request; there is no CLI session to scope",
      http: "profiles are carried on the MCP connection (profiles header), not on REST calls",
    },
  },

  // ── local operator tooling (CLI-only by nature) ─────────────────────────
  {
    id: "config",
    summary: "Show/set daemon configuration",
    cli: { verb: "config" },
  },
  {
    id: "auth.token",
    summary: "Mint an API token",
    cli: { verb: "token" },
  },
  {
    id: "git.identity",
    summary: "Repair git author/committer identity on stored records",
    cli: { verb: "git" },
  },
  {
    id: "remote.pull",
    summary: "Pull the storage repo from its remote",
    cli: { verb: "pull" },
  },
  {
    id: "remote.push",
    summary: "Push the storage repo to its remote",
    cli: { verb: "push" },
  },
  {
    id: "remote.configure",
    summary: "Configure the storage repo remote",
    cli: { verb: "remote" },
  },
  {
    id: "servers.manage",
    summary: "Manage saved server connections",
    cli: { verb: "servers" },
  },
  {
    id: "ssh.connect",
    summary: "Open an SSH tunnel to a remote daemon",
    cli: { verb: "ssh-connect" },
    na: {
      http: "transport bootstrap: an SSH tunnel is how the HTTP surface is reached, not something it serves",
      mcp: "transport bootstrap: not exposed to agents by design",
    },
  },
  {
    id: "ssh.test",
    summary: "Test SSH tunnel reachability",
    cli: { verb: "ssh-test" },
    na: {
      http: "transport bootstrap: an SSH tunnel is how the HTTP surface is reached, not something it serves",
      mcp: "transport bootstrap: not exposed to agents by design",
    },
  },
  {
    id: "embeddings.manage",
    summary: "Manage the embedding cache (rebuild|status|providers)",
    cli: { verb: "embeddings" },
  },
  {
    id: "session.distill",
    summary: "Distill nightly state.db sessions into decisions/findings",
    cli: { verb: "distill-sessions" },
  },
];

/** Every surface key the matrix claims, in `METHOD /path` / tool / verb form. */
export function claimedKeys(cap: Capability, surface: SurfaceName): string[] {
  if (surface === "http") return [...(cap.http ?? [])];
  if (surface === "mcp") return [...(cap.mcp ?? [])];
  return cap.cli ? [cap.cli.verb] : [];
}

/** Route keys that may legitimately be absent from the observed app. */
export function optionalHttpRoutesFor(cap: Capability): string[] {
  return (cap.http ?? []).filter((route) => OPTIONAL_HTTP_ROUTES[route] !== undefined);
}
