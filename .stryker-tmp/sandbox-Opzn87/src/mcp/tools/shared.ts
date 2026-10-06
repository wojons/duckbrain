/**
 * Shared utility functions for MCP tools
 */
// @ts-nocheck


import path from "path";
import {
  getConfig,
  resolveDuckbrainRoot,
  resolveNamespacesPath,
} from "../../config/index";
import {
  getMcpRequestDenialAuditor,
  getMcpRequestPrincipal,
} from "../../cli/http";
import { namespaceScopeDenial } from "../../auth/roles";
import type {
  AuthPrincipal,
  DenialAuditEvent,
  DenialAuditor,
} from "../../auth/middleware";

/**
 * Resolve a namespace name from a namespace argument.
 *
 * Falls back to config's defaultNamespace when no namespace is provided, and
 * 'default' when the config has none set. The config defaultNamespace is the
 * ACTIVE namespace — switch_namespace persists it into duckbrain.config.json,
 * so it is sticky across processes (DOGFOOD-017).
 *
 * GAP-062: read from the config file that OWNS this duckbrain instance
 * (`resolveDuckbrainRoot()`), never from whatever `duckbrain.config.json`
 * happens to sit next to the caller's cwd — otherwise a CLI invoked from an
 * unrelated checkout picks up a foreign defaultNamespace.
 */
export function resolveNamespaceName(namespace?: string): string {
  const config = getConfig(resolveDuckbrainRoot());
  return namespace || config.defaultNamespace || "default";
}

/**
 * Resolve a namespace name to its filesystem path
 *
 * Uses the config-based namespacesPath from duckbrain.config.json, resolved
 * against the duckbrain root — the directory holding that config file
 * (`resolveNamespacesPath()`, GAP-062). The returned path is ALWAYS absolute,
 * so a write from an unrelated cwd can never create `<cwd>/namespaces/<ns>`.
 * Falls back to 'default' if no namespace is provided.
 */
export function resolveNamespacePath(namespace?: string): string {
  const ns = resolveNamespaceName(namespace);
  return path.join(resolveNamespacesPath(), ns);
}

/**
 * DB-GAP-031 (MCP parity): machine-readable refusal returned by an MCP tool
 * handler when the caller's token has no grant for the namespace the call
 * would touch.
 *
 * `reason` is the SAME token the REST path audits for this denial
 * (`namespace_scope`, `src/auth/middleware.ts`), and `code` follows the
 * SCREAMING_SNAKE convention of the other machine-readable tool failures
 * (BLANK_CONTENT, NAMESPACE_NOT_FOUND, DURABILITY_UNSUPPORTED). The payload
 * also carries `success: false` + `error`, so `wrapHandler` surfaces it as
 * `isError: true` with the reason visible to the agent.
 */
export interface NamespaceScopeViolation {
  success: false;
  reason: "namespace_scope";
  code: "NAMESPACE_SCOPE";
  error: string;
}

/**
 * Injectable per-call seams for an MCP tool handler.
 *
 * `principal` is the SUPA-4 principal seam; `auditDenial` is the SUPA-4
 * audit-every-denial seam. Both are injection points for tests/embedders —
 * MCP-over-HTTP leaves the context empty and the handler falls back to the
 * request-scoped slots the /mcp route fills from the authenticated request.
 */
export interface McpToolContext {
  /** Authenticated principal (SUPA-4 / DOGFOOD-025 seam). */
  principal?: AuthPrincipal;
  /** Request-scoped denial auditor — the sink REST audits through. */
  auditDenial?: DenialAuditor;
}

/**
 * Resolve the authenticated principal for an MCP tool call.
 *
 * `context.principal` is the injectable seam (SUPA-4 tests / embedders);
 * MCP-over-HTTP falls back to the DOGFOOD-025 module-scope slot, which the
 * /mcp route sets from the request that the auth middleware authenticated.
 * Both are undefined in stdio / auth=none local mode, where no grant check
 * must run.
 */
export function resolveToolPrincipal(
  context?: McpToolContext,
): AuthPrincipal | undefined {
  return context?.principal ?? getMcpRequestPrincipal();
}

/**
 * Resolve the denial auditor of the in-flight MCP request, if any.
 *
 * The /mcp route fills the request-scoped slot from the Express request the
 * auth middleware instrumented, so an MCP refusal reaches the SAME sink
 * (`createDenialAuditor`, src/serialization/audit.ts) a REST 403 uses.
 * Undefined in stdio / auth=none local mode and in embedders that never
 * installed an auditor — auditing is best-effort, never a precondition.
 */
export function resolveToolDenialAuditor(
  context?: McpToolContext,
): DenialAuditor | undefined {
  return context?.auditDenial ?? getMcpRequestDenialAuditor();
}

/**
 * SUPA-4 audit-every-denial: append a denial row for a namespace-scope
 * refusal taken on the MCP path.
 *
 * Mirrors the row `requireNamespaceGrant` writes on the REST path
 * (`op: "namespace.access"`, `reason: "namespace_scope"`, the token name as
 * `principal`) so both transports produce the same audit evidence. A
 * cross-namespace (`allNamespaces`) refusal names no single target, exactly
 * like the REST route's, and is reported without an `ns` so the sink sends it
 * to the bounded server-level denials file.
 *
 * Best-effort by contract: a throwing or rejecting auditor is swallowed and
 * can never change the refusal payload the caller receives.
 */
export function auditNamespaceScopeDenial(
  context: McpToolContext | undefined,
  namespace: string | undefined,
  principal: AuthPrincipal | undefined,
): void {
  const auditor = resolveToolDenialAuditor(context);
  if (!auditor) return;
  const event: DenialAuditEvent = {
    ts: new Date().toISOString(),
    ...(namespace === undefined ? {} : { ns: namespace }),
    op: "namespace.access",
    principal: principal?.name ?? null,
    outcome: "denied",
    reason: "namespace_scope",
  };
  try {
    void Promise.resolve(auditor(event)).catch(() => undefined);
  } catch {
    // Auditing is best-effort and never changes a denial response.
  }
}

/**
 * Enforce the token's namespace grant on the MCP path AND audit the refusal.
 *
 * Same contract as `namespaceScopeViolation` (returns the machine-readable
 * refusal, or `undefined` when the call is allowed), plus the SUPA-4 audit
 * row every refusal owes. Tool handlers call this instead of
 * `namespaceScopeViolation` so no MCP refusal can be silent.
 */
export function enforceNamespaceScope(
  context: McpToolContext | undefined,
  namespace: string,
  options: { allNamespaces?: boolean } = {},
): NamespaceScopeViolation | undefined {
  const principal = resolveToolPrincipal(context);
  const violation = namespaceScopeViolation(principal, namespace, options);
  if (!violation) return undefined;
  auditNamespaceScopeDenial(
    context,
    options.allNamespaces ? undefined : namespace,
    principal,
  );
  return violation;
}

/**
 * Enforce the token's namespace grant on the MCP path.
 *
 * The REST routers mount `requireNamespaceGrant` (src/auth/middleware.ts) so
 * the check runs before the route body; the /mcp transport has no per-tool
 * route to mount it on, and the target namespace appears ONLY in the tool
 * arguments. Tool handlers therefore call this helper with the namespace
 * they are about to touch — the RESOLVED one, not the raw argument — and
 * return the violation payload verbatim when it fires.
 *
 * Returns `undefined` when the call is allowed (no principal — auth=none
 * local mode; unrestricted token — `namespaces` absent; or the namespace is
 * inside the grant).
 *
 * `options.allNamespaces` covers the RETR-007 cross-namespace search: a
 * scoped token can never cover "every namespace", so only an unrestricted
 * token may use it — the same rule the REST route applies to
 * `?allNamespaces=true`.
 */
export function namespaceScopeViolation(
  principal: AuthPrincipal | undefined,
  namespace: string,
  options: { allNamespaces?: boolean } = {},
): NamespaceScopeViolation | undefined {
  // No principal (auth=none local mode) or an unrestricted token: the grant
  // does not restrict anything, so nothing to refuse.
  if (!principal || principal.namespaces === undefined) return undefined;

  if (options.allNamespaces) {
    return {
      success: false,
      reason: "namespace_scope",
      code: "NAMESPACE_SCOPE",
      error: `Forbidden: token '${principal.name}' has no grant for cross-namespace search — allNamespaces=true requires an unrestricted token`,
    };
  }

  const denial = namespaceScopeDenial(principal, namespace);
  if (!denial) return undefined;
  return {
    success: false,
    reason: "namespace_scope",
    code: "NAMESPACE_SCOPE",
    error: denial.message,
  };
}
