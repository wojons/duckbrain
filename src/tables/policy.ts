/**
 * RLS-001 — declared ROW-LEVEL policy for a table.
 *
 * The grant model (DB-SUPA-4) answers "may this principal touch this table?".
 * It has no answer for "which ROWS of that table?" — so a multi-tenant app
 * with two tenants' rows in one table had to split namespaces or filter in
 * application code it also had to write. This module is the second question:
 * a policy is DECLARED next to the columns (in the same DB-SUPA-6
 * `schema.json` table definition, never a parallel format) and evaluated
 * AFTER the grant check on every data verb.
 *
 * Declaration shape (inside a `schema.json` table, or a legacy
 * `.table.json` declaration):
 *
 *   "policy": {
 *     "read":  { "column": "owner", "equals": ".id" },
 *     "write": { "column": "owner", "equals": ".id" }
 *   }
 *
 * `column` must be a declared column of the same table. `equals` is either a
 * literal string (a row everybody may read, e.g. `"public"`) or a PRINCIPAL
 * REFERENCE: a leading `.` names a field of the authenticated principal —
 * `.id` and `.name` both resolve to the principal's name (the token name in
 * apikey mode, the username in basic mode). Any other `.field` is refused at
 * declaration time, never silently ignored.
 *
 * Evaluation rules, all fail-closed:
 *   - No rule, or no authenticated principal (auth=none local mode — the same
 *     seam the grant model treats as unrestricted) → the row is allowed.
 *   - Rule present, principal present, row missing the policy column (absent,
 *     null or empty) → DENIED. A row that cannot prove an owner is not
 *     everybody's row.
 *   - Row value is compared as its canonical string form, so `id: 7` and
 *     `id: "7"` are the same owner.
 *
 * Denials carry the reason token `row_policy`, which is DISTINCT from
 * `table_grant`: an operator reading the audit can tell "you may not touch
 * this table" from "you may touch this table, but not this row".
 */

import type { AuthPrincipal } from "../auth/middleware.js";
import type { RowPolicyRule, TablePolicy } from "../serialization/schemaJson.js";

export type { RowPolicyRule, TablePolicy };

/** The audit reason token a row-policy denial carries. */
export const ROW_POLICY_REASON = "row_policy" as const;

/** The principal fields a `.field` reference may name. */
export const POLICY_PRINCIPAL_FIELDS = ["id", "name"] as const;

export type PolicyOperation = "read" | "write";

export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: typeof ROW_POLICY_REASON; message: string };

/** A rule resolved for one principal: the column and the value it must hold. */
export interface ResolvedRowPolicy {
  column: string;
  value: string;
}

/**
 * A row-policy denial row. It is the SAME shape the grant middlewares audit
 * (`DenialAuditEvent` in src/auth/middleware.ts) with the `row_policy` reason,
 * so one sink (and one reader) serves every denial class.
 */
export interface PolicyAuditEvent {
  ts: string;
  ns: string;
  table: string;
  op: string;
  principal: string | null;
  reason: typeof ROW_POLICY_REASON;
  outcome: "denied";
}

/** What a caller supplies; the sink fills `ts` and `outcome`. */
export type PolicyAuditInput = Omit<PolicyAuditEvent, "ts" | "outcome">;

/** Optional sink so a denial lands in the namespace audit (HTTP/MCP pass theirs). */
export type PolicyAuditSink = (event: PolicyAuditEvent) => void | Promise<void>;

export class RowPolicyDeclarationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RowPolicyDeclarationError";
  }
}

function declarationError(message: string): never {
  throw new RowPolicyDeclarationError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRule(
  raw: unknown,
  where: string,
  columns: readonly string[],
): RowPolicyRule {
  if (!isPlainObject(raw)) {
    declarationError(`${where} must be an object { column, equals }`);
  }
  const keys = Object.keys(raw);
  for (const key of keys) {
    if (key !== "column" && key !== "equals") {
      declarationError(
        `${where} carries unknown field '${key}' (expected only column and equals)`,
      );
    }
  }
  const column = raw.column;
  if (typeof column !== "string" || column.length === 0) {
    declarationError(`${where}.column must be a non-empty string`);
  }
  if (!columns.includes(column)) {
    declarationError(
      `${where}.column '${column}' is not a declared column of this table (declares: ${columns.join(", ")})`,
    );
  }
  const equals = raw.equals;
  if (typeof equals !== "string" || equals.length === 0) {
    declarationError(
      `${where}.equals must be a non-empty string (a literal, or a principal reference like ".id")`,
    );
  }
  if (equals.startsWith(".")) {
    const field = equals.slice(1);
    if (!(POLICY_PRINCIPAL_FIELDS as readonly string[]).includes(field)) {
      declarationError(
        `${where}.equals '${equals}' names an unknown principal field; expected one of ${POLICY_PRINCIPAL_FIELDS.map((f) => `.${f}`).join(", ")}`,
      );
    }
  }
  return { column, equals };
}

/**
 * Validate a `policy` declaration. Returns `undefined` when no policy was
 * declared; throws RowPolicyDeclarationError (a caller maps it to 400/409) on
 * anything malformed — a policy that cannot be evaluated must never load as
 * "no policy".
 */
export function parseTablePolicy(
  raw: unknown,
  context: { table: string; columns: readonly string[] },
): TablePolicy | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    declarationError(
      `policy for table '${context.table}' must be an object { read?, write? }`,
    );
  }
  for (const key of Object.keys(raw)) {
    if (key !== "read" && key !== "write") {
      declarationError(
        `policy for table '${context.table}' carries unknown field '${key}' (expected only read and write)`,
      );
    }
  }
  const policy: TablePolicy = {};
  if (raw.read !== undefined) {
    policy.read = parseRule(raw.read, `policy.read`, context.columns);
  }
  if (raw.write !== undefined) {
    policy.write = parseRule(raw.write, `policy.write`, context.columns);
  }
  if (policy.read === undefined && policy.write === undefined) {
    declarationError(
      `policy for table '${context.table}' declares neither read nor write`,
    );
  }
  return policy;
}

/** Resolve the value a rule requires for this principal, or null (deny). */
export function principalPolicyValue(
  rule: RowPolicyRule,
  principal: AuthPrincipal | undefined,
): string | null {
  if (!rule.equals.startsWith(".")) return rule.equals;
  if (!principal) return null;
  const field = rule.equals.slice(1);
  // `.id` and `.name` both name the principal's identity: apikey mode calls it
  // a token name, basic mode a username, and there is no second identity.
  const value = field === "id" || field === "name" ? principal.name : undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The rule resolved for one principal, or null when the policy does not apply
 * (no rule declared, or no authenticated principal — auth=none local mode).
 * `deny` is the fail-closed case: a rule exists and the principal cannot be
 * identified, so no row may be admitted.
 */
export function resolveRowPolicy(
  policy: TablePolicy | undefined,
  operation: PolicyOperation,
  principal: AuthPrincipal | undefined,
): { kind: "open" } | { kind: "filter"; filter: ResolvedRowPolicy } | { kind: "deny"; message: string } {
  const rule = policy?.[operation];
  if (!rule) return { kind: "open" };
  if (!principal) return { kind: "open" };
  const value = principalPolicyValue(rule, principal);
  if (value === null) {
    return {
      kind: "deny",
      message: `Forbidden: row policy on '${rule.column}' cannot be resolved for principal '${principal.name}'`,
    };
  }
  return { kind: "filter", filter: { column: rule.column, value } };
}

function rowCell(row: unknown, column: string): { present: boolean; value: string } {
  if (!isPlainObject(row)) return { present: false, value: "" };
  if (!Object.prototype.hasOwnProperty.call(row, column)) {
    return { present: false, value: "" };
  }
  const raw = row[column];
  if (raw === undefined || raw === null) return { present: false, value: "" };
  const value = String(raw);
  return { present: value.length > 0, value };
}

/**
 * Grade ONE row against a declared policy rule. Used by the write paths (where
 * the row is in hand) and by the change feed (where the row image comes from
 * the commit). The SELECT path pushes the same rule into SQL instead
 * (`resolveRowPolicy` → buildSelectPlan), so paging and X-Total-Count count
 * only what the principal may see.
 */
export function rowPolicyDecision(
  policy: TablePolicy | undefined,
  operation: PolicyOperation,
  row: unknown,
  principal: AuthPrincipal | undefined,
): PolicyDecision {
  const resolved = resolveRowPolicy(policy, operation, principal);
  if (resolved.kind === "open") return { allowed: true };
  if (resolved.kind === "deny") {
    return { allowed: false, reason: ROW_POLICY_REASON, message: resolved.message };
  }
  const { column, value } = resolved.filter;
  const cell = rowCell(row, column);
  if (!cell.present) {
    return {
      allowed: false,
      reason: ROW_POLICY_REASON,
      message: `Forbidden: row has no '${column}' value, so the row policy cannot admit it`,
    };
  }
  if (cell.value !== value) {
    return {
      allowed: false,
      reason: ROW_POLICY_REASON,
      message: `Forbidden: row '${column}' value '${cell.value}' is outside principal '${
        principal?.name ?? "anonymous"
      }' row policy '${value}'`,
    };
  }
  return { allowed: true };
}

/** Best-effort denial audit: never changes the response, never throws. */
export async function auditPolicyDenial(
  sink: PolicyAuditSink | undefined,
  event: PolicyAuditInput,
): Promise<void> {
  if (!sink) return;
  try {
    await Promise.resolve(
      sink({ ...event, ts: new Date().toISOString(), outcome: "denied" }),
    );
  } catch {
    // Auditing is best-effort, exactly like the grant-denial path.
  }
}
