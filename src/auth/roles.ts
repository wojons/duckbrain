export type Role = "admin" | "writer" | "analyst" | "uploader";
export type TableGrant = "read" | "write" | "rw";
export type ResourceAction =
  | "tables.read"
  | "tables.write"
  | "files.read"
  | "files.upload"
  | "sql.read"
  | "sql.write";
export type SqlDirection = "read" | "write";

export interface PrincipalSqlPolicy {
  read?: boolean;
  write?: boolean;
  maxRows?: number;
  maxMemoryBytes?: number;
  timeoutMs?: number;
}

export interface GrantPrincipal {
  name: string;
  authenticated: boolean;
  namespaces?: string[];
  roles?: Role[];
  tableGrants?: Record<string, TableGrant>;
  sql?: PrincipalSqlPolicy;
}

export type DenialReason =
  | "role"
  | "table_grant"
  | "namespace_scope"
  | "expired"
  | "sql_flag"
  | "sql_cap";

export type GrantDecision =
  { allowed: true } | { allowed: false; reason: DenialReason; message: string };

export const ROLE_GRANTS: Readonly<Record<Role, readonly ResourceAction[]>> = {
  admin: [
    "tables.read",
    "tables.write",
    "files.read",
    "files.upload",
    "sql.read",
    "sql.write",
  ],
  writer: ["tables.read", "tables.write", "sql.read", "sql.write"],
  analyst: ["tables.read", "files.read", "sql.read", "sql.write"],
  uploader: ["tables.read", "files.read", "files.upload"],
};

export const SQL_DEFAULTS = Object.freeze({
  timeoutMs: 10_000,
  maxRows: 10_000,
  maxMemoryBytes: 256 * 1024 * 1024,
});

export interface ResolvedSqlPolicy {
  read: boolean;
  write: boolean;
  timeoutMs: number;
  maxRows: number;
  maxMemoryBytes: number;
}

export type RawSqlAuthorization =
  | { allowed: true; policy: ResolvedSqlPolicy }
  | { allowed: false; reason: DenialReason; message: string };

function effectiveRoles(principal: GrantPrincipal): readonly Role[] {
  // A missing roles field is the pre-SUPA-4 token shape. It remains
  // admin-equivalent for backward compatibility; an explicit [] grants none.
  return principal.roles === undefined ? ["admin"] : principal.roles;
}

function namespaceDecision(
  principal: GrantPrincipal | undefined,
  namespace: string,
): GrantDecision | undefined {
  // No principal means auth=none local mode. Authentication middleware rejects
  // anonymous requests before grant evaluation in authenticated modes.
  if (!principal || principal.namespaces === undefined) return undefined;
  if (principal.namespaces.includes(namespace)) return undefined;
  return {
    allowed: false,
    reason: "namespace_scope",
    message: `Forbidden: principal '${principal.name}' has no grant for namespace '${namespace}'`,
  };
}

function roleHas(principal: GrantPrincipal, action: ResourceAction): boolean {
  return effectiveRoles(principal).some((role) =>
    ROLE_GRANTS[role].includes(action),
  );
}

export function hasAnyRole(
  principal: GrantPrincipal,
  roles: readonly Role[],
): boolean {
  const actual = effectiveRoles(principal);
  return roles.some((role) => actual.includes(role));
}

export function authorizeResource(
  principal: GrantPrincipal | undefined,
  namespace: string,
  action: ResourceAction,
): GrantDecision {
  if (!principal) return { allowed: true };
  const scoped = namespaceDecision(principal, namespace);
  if (scoped && !scoped.allowed) return scoped;
  if (roleHas(principal, action)) return { allowed: true };
  return {
    allowed: false,
    reason: "role",
    message: `Forbidden: principal '${principal.name}' lacks grant '${action}'`,
  };
}

export function authorizeTableAccess(
  principal: GrantPrincipal | undefined,
  namespace: string,
  table: string,
  operation: "read" | "write",
): GrantDecision {
  if (!principal) return { allowed: true };
  const scoped = namespaceDecision(principal, namespace);
  if (scoped && !scoped.allowed) return scoped;

  const roles = effectiveRoles(principal);
  if (roles.includes("admin")) return { allowed: true };
  const action: ResourceAction = `tables.${operation}`;
  if (!roleHas(principal, action)) {
    return {
      allowed: false,
      reason: "role",
      message: `Forbidden: principal '${principal.name}' lacks grant '${action}'`,
    };
  }

  if (principal.tableGrants !== undefined) {
    const grant = principal.tableGrants[table];
    const allowed = grant === "rw" || grant === operation;
    if (!allowed) {
      return {
        allowed: false,
        reason: "table_grant",
        message: `Forbidden: principal '${principal.name}' has no ${operation} grant for table '${table}'`,
      };
    }
  }
  return { allowed: true };
}

export function resolveSqlPolicy(principal: GrantPrincipal): ResolvedSqlPolicy {
  const roles = effectiveRoles(principal);
  const defaultRead = roles.some(
    (role) => role === "admin" || role === "analyst",
  );
  return {
    read: principal.sql?.read ?? defaultRead,
    write: principal.sql?.write ?? false,
    timeoutMs: principal.sql?.timeoutMs ?? SQL_DEFAULTS.timeoutMs,
    maxRows: principal.sql?.maxRows ?? SQL_DEFAULTS.maxRows,
    maxMemoryBytes:
      principal.sql?.maxMemoryBytes ?? SQL_DEFAULTS.maxMemoryBytes,
  };
}

export function authorizeRawSql(
  principal: GrantPrincipal | undefined,
  namespace: string,
  direction: SqlDirection,
): RawSqlAuthorization {
  if (!principal) {
    return {
      allowed: true,
      policy: { ...SQL_DEFAULTS, read: true, write: true },
    };
  }
  const scoped = namespaceDecision(principal, namespace);
  if (scoped && !scoped.allowed) return scoped;
  const action: ResourceAction = `sql.${direction}`;
  if (!roleHas(principal, action)) {
    return {
      allowed: false,
      reason: "role",
      message: `Forbidden: principal '${principal.name}' lacks grant '${action}'`,
    };
  }
  const policy = resolveSqlPolicy(principal);
  if (!policy[direction]) {
    return {
      allowed: false,
      reason: "sql_flag",
      message: `Forbidden: principal '${principal.name}' has not enabled '${action}'`,
    };
  }
  return { allowed: true, policy };
}

export class SqlCapError extends Error {
  readonly code: "SQL_ROW_CAP" | "SQL_TIMEOUT" | "SQL_MEMORY_CAP";

  constructor(
    code: "SQL_ROW_CAP" | "SQL_TIMEOUT" | "SQL_MEMORY_CAP",
    message: string,
  ) {
    super(message);
    this.name = "SqlCapError";
    this.code = code;
  }
}

type MaybePromise = void | Promise<void>;
type CapAudit = (code: SqlCapError["code"]) => MaybePromise;

async function* asAsync<T>(rows: Iterable<T> | AsyncIterable<T>) {
  for await (const row of rows) yield row;
}

export async function* streamWithSqlRowCap<T>(
  rows: Iterable<T> | AsyncIterable<T>,
  maxRows: number,
  onCap?: CapAudit,
): AsyncGenerator<T> {
  let count = 0;
  for await (const row of asAsync(rows)) {
    if (count >= maxRows) {
      try {
        void Promise.resolve(onCap?.("SQL_ROW_CAP")).catch(() => undefined);
      } catch {
        // Audit is best-effort and cannot suppress the cap failure.
      }
      throw new SqlCapError(
        "SQL_ROW_CAP",
        `SQL result exceeded the configured row cap of ${maxRows}`,
      );
    }
    count += 1;
    yield row;
  }
}

export async function withSqlTimeout<T>(
  execute: () => Promise<T>,
  timeoutMs: number,
  onCap?: CapAudit,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        void Promise.resolve(onCap?.("SQL_TIMEOUT")).catch(() => undefined);
      } catch {
        // Audit is best-effort and cannot suppress the timeout.
      }
      reject(
        new SqlCapError(
          "SQL_TIMEOUT",
          `SQL statement exceeded the configured timeout of ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([execute(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function sqlMemoryLimitStatement(maxMemoryBytes: number): string {
  if (!Number.isSafeInteger(maxMemoryBytes) || maxMemoryBytes <= 0) {
    throw new SqlCapError("SQL_MEMORY_CAP", "SQL memory cap must be positive");
  }
  return `SET memory_limit='${maxMemoryBytes}B'`;
}
