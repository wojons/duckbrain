/**
 * Authentication and authorization middleware.
 *
 * The shipped none/basic/apikey modes are implemented behind AuthBackend.
 * Health remains pre-auth; auth=none remains local pass-through.
 */

import crypto from "crypto";
import bcrypt from "bcryptjs";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  AuthStoreSchema,
  hashApiKey,
  type ApiKeyEntry,
  type AuthStoreSource,
  type UserEntry,
} from "./storeSchema";
import {
  authorizeRawSql,
  authorizeTableAccess,
  hasAnyRole,
  type DenialReason,
  type PrincipalSqlPolicy,
  type Role,
  type TableGrant,
} from "./roles";

export type { ApiKeyEntry, Role, TableGrant, UserEntry };

export interface DenialAuditEvent {
  ts: string;
  ns?: string;
  table?: string;
  op: string;
  principal?: string | null;
  outcome: "denied";
  reason: DenialReason;
}

export type DenialAuditor = (event: DenialAuditEvent) => void | Promise<void>;

export interface AuthConfig {
  type: "none" | "basic" | "apikey";
  users?: UserEntry[];
  apiKeys?: ApiKeyEntry[];
  /** Live, validated file store. Inline users/apiKeys remain test/embed seams. */
  store?: AuthStoreSource;
  /** Injectable server clock for expiry boundary tests. */
  now?: () => Date;
  /** Non-blocking audit sink attached to the request for grant middleware. */
  auditDenial?: DenialAuditor;
}

export interface AuthPrincipal {
  name: string;
  authenticated: boolean;
  namespaces?: string[];
  roles?: Role[];
  tableGrants?: Record<string, TableGrant>;
  tokenType?: "basic" | "apikey";
  expiresAt?: string;
  sql?: PrincipalSqlPolicy;
  /** Kept for HTTP Basic consumers that used the pre-SUPA-4 request shape. */
  username?: string;
}

export interface AuthBackend {
  readonly type: "none" | "basic" | "apikey";
  authenticate(req: Request): Promise<AuthPrincipal | null>;
}

export class AuthFailure extends Error {
  readonly status = 401;

  constructor(
    message: string,
    readonly reason: DenialReason = "role",
    readonly code?: string,
    readonly principal?: string,
  ) {
    super(message);
    this.name = "AuthFailure";
  }
}

const REQUEST_AUDITOR = Symbol("duckbrain.denialAuditor");

type AuditedRequest = Request & {
  [REQUEST_AUDITOR]?: DenialAuditor;
};

function inlineStore(config: AuthConfig): AuthStoreSource {
  const snapshot = AuthStoreSchema.parse({
    users: config.users ?? [],
    apiKeys: config.apiKeys ?? [],
  });
  return { getSnapshot: () => snapshot };
}

function principalFields(
  entry: Pick<ApiKeyEntry | UserEntry, "roles" | "namespaces" | "expiresAt"> &
    Partial<Pick<ApiKeyEntry, "tableGrants" | "sql">>,
): Partial<AuthPrincipal> {
  return {
    ...(entry.namespaces !== undefined ? { namespaces: entry.namespaces } : {}),
    ...(entry.roles !== undefined ? { roles: entry.roles } : {}),
    ...(entry.expiresAt !== undefined ? { expiresAt: entry.expiresAt } : {}),
    ...(entry.tableGrants !== undefined
      ? { tableGrants: entry.tableGrants }
      : {}),
    ...(entry.sql !== undefined ? { sql: entry.sql } : {}),
  };
}

function assertNotExpired(
  entry: { name?: string; username?: string; expiresAt?: string },
  now: () => Date,
): void {
  if (entry.expiresAt === undefined) return;
  if (Date.parse(entry.expiresAt) > now().getTime()) return;
  const name = entry.name ?? entry.username;
  throw new AuthFailure(
    "Unauthorized: Token expired",
    "expired",
    "TOKEN_EXPIRED",
    name,
  );
}

function digestEquals(presented: string, expectedHash: string): boolean {
  const presentedDigest = Buffer.from(hashApiKey(presented).slice(8), "hex");
  const expectedDigest = Buffer.from(expectedHash.slice(8), "hex");
  return (
    presentedDigest.length === expectedDigest.length &&
    crypto.timingSafeEqual(presentedDigest, expectedDigest)
  );
}

class NoneAuthBackend implements AuthBackend {
  readonly type = "none" as const;

  async authenticate(_req: Request): Promise<null> {
    return null;
  }
}

class BasicAuthBackend implements AuthBackend {
  readonly type = "basic" as const;

  constructor(
    private readonly store: AuthStoreSource,
    private readonly now: () => Date,
  ) {}

  async authenticate(req: Request): Promise<AuthPrincipal> {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Basic ")) {
      throw new AuthFailure("Unauthorized: Basic auth required");
    }
    try {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString(
        "utf-8",
      );
      const colonIndex = decoded.indexOf(":");
      if (colonIndex === -1) {
        throw new AuthFailure("Unauthorized: Invalid credentials format");
      }
      const username = decoded.slice(0, colonIndex);
      const password = decoded.slice(colonIndex + 1);
      const snapshot = await this.store.getSnapshot();
      const user = snapshot.users.find(
        (candidate) => candidate.username === username,
      );
      if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
        throw new AuthFailure("Unauthorized: Invalid credentials");
      }
      assertNotExpired(user, this.now);
      return {
        username,
        name: username,
        authenticated: true,
        tokenType: "basic",
        ...principalFields(user),
      };
    } catch (error) {
      if (error instanceof AuthFailure) throw error;
      throw new AuthFailure("Unauthorized: Invalid credentials");
    }
  }
}

class ApiKeyAuthBackend implements AuthBackend {
  readonly type = "apikey" as const;

  constructor(
    private readonly store: AuthStoreSource,
    private readonly now: () => Date,
  ) {}

  async authenticate(req: Request): Promise<AuthPrincipal> {
    const presented = req.headers["x-api-key"];
    const apiKey = Array.isArray(presented) ? presented[0] : presented;
    if (!apiKey) throw new AuthFailure("Unauthorized: API key required");

    const snapshot = await this.store.getSnapshot();
    let matched: ApiKeyEntry | undefined;
    for (const entry of snapshot.apiKeys) {
      const expected =
        "keyHash" in entry ? entry.keyHash : hashApiKey(entry.key);
      if (digestEquals(apiKey, expected)) {
        matched = entry;
        break;
      }
    }
    if (!matched) throw new AuthFailure("Unauthorized: Invalid API key");
    assertNotExpired(matched, this.now);

    if ("key" in matched && this.store.migrateLegacyApiKey) {
      await this.store.migrateLegacyApiKey(matched.name, apiKey);
    }
    return {
      name: matched.name,
      authenticated: true,
      tokenType: "apikey",
      ...principalFields(matched),
    };
  }
}

export function createAuthBackend(config: AuthConfig): AuthBackend {
  const store = config.store ?? inlineStore(config);
  const now = config.now ?? (() => new Date());
  switch (config.type) {
    case "none":
      return new NoneAuthBackend();
    case "basic":
      return new BasicAuthBackend(store, now);
    case "apikey":
      return new ApiKeyAuthBackend(store, now);
  }
}

export function getPrincipal(req: Request): AuthPrincipal | undefined {
  return (req as Request & { user?: AuthPrincipal }).user;
}

export function principalAuthorEmail(principal: AuthPrincipal): string {
  const name = principal.name.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(name)) return name;
  return `${name.replace(/\s+/g, "-")}@duckbrain.local`;
}

function inferredNamespace(req: Request): string | undefined {
  const query = req.query?.namespace;
  if (typeof query === "string" && query) return query;
  const body = req.body as { namespace?: unknown } | undefined;
  if (typeof body?.namespace === "string" && body.namespace)
    return body.namespace;
  const param = req.params?.namespace ?? req.params?.name;
  if (typeof param === "string" && param) return param;
  return undefined;
}

function auditWithoutBlocking(
  req: Request,
  event: Omit<DenialAuditEvent, "ts" | "outcome">,
): void {
  const auditor = (req as AuditedRequest)[REQUEST_AUDITOR];
  if (!auditor) return;
  const complete: DenialAuditEvent = {
    ts: new Date().toISOString(),
    outcome: "denied",
    ...event,
  };
  try {
    void Promise.resolve(auditor(complete)).catch(() => undefined);
  } catch {
    // Auditing is best-effort and never changes a denial response.
  }
}

export function auditRequestDenial(
  req: Request,
  event: Omit<DenialAuditEvent, "ts" | "outcome">,
): void {
  auditWithoutBlocking(req, event);
}

export function authMiddleware(config: AuthConfig): RequestHandler {
  const backend = createAuthBackend(config);
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    (req as AuditedRequest)[REQUEST_AUDITOR] = config.auditDenial;
    if (req.path === "/health") return next();
    if (backend.type === "none") return next();

    try {
      const principal = await backend.authenticate(req);
      if (principal)
        (req as Request & { user?: AuthPrincipal }).user = principal;
      next();
    } catch (error) {
      const failure =
        error instanceof AuthFailure
          ? error
          : new AuthFailure("Unauthorized: Invalid credentials");
      auditWithoutBlocking(req, {
        op: "authenticate",
        principal: failure.principal ?? null,
        reason: failure.reason,
      });
      res.status(failure.status).json({
        error: failure.message,
        ...(failure.code ? { code: failure.code } : {}),
      });
    }
  };
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!getPrincipal(req)) {
    auditWithoutBlocking(req, {
      ns: inferredNamespace(req),
      op: "authenticate",
      principal: null,
      reason: "role",
    });
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  next();
}

export function requireRole(...roles: Role[]): RequestHandler {
  return (req, res, next) => {
    const principal = getPrincipal(req);
    if (!principal || hasAnyRole(principal, roles)) return next();
    auditWithoutBlocking(req, {
      ns: inferredNamespace(req),
      op: `require_role:${roles.join(",")}`,
      principal: principal.name,
      reason: "role",
    });
    res.status(403).json({
      error: `Forbidden: principal '${principal.name}' lacks required role`,
      code: "FORBIDDEN",
    });
  };
}

export function requireTableGrant(
  getNamespace: (req: Request) => string,
  getTable: (req: Request) => string,
  operation: "read" | "write",
): RequestHandler {
  return (req, res, next) => {
    const principal = getPrincipal(req);
    if (!principal) return next();
    const namespace = getNamespace(req);
    const table = getTable(req);
    const decision = authorizeTableAccess(
      principal,
      namespace,
      table,
      operation,
    );
    if (decision.allowed) return next();
    auditWithoutBlocking(req, {
      ns: namespace,
      table,
      op: `tables.${operation}`,
      principal: principal.name,
      reason: decision.reason,
    });
    res.status(403).json({ error: decision.message, code: "FORBIDDEN" });
  };
}

export function requireRawSqlGrant(
  getNamespace: (req: Request) => string,
  direction: "read" | "write",
): RequestHandler {
  return (req, res, next) => {
    const principal = getPrincipal(req);
    if (!principal) return next();
    const namespace = getNamespace(req);
    const decision = authorizeRawSql(principal, namespace, direction);
    if (decision.allowed) {
      res.locals.sqlPolicy = decision.policy;
      return next();
    }
    auditWithoutBlocking(req, {
      ns: namespace,
      table: "query",
      op: `sql.${direction}`,
      principal: principal.name,
      reason: decision.reason,
    });
    res.status(403).json({ error: decision.message, code: "FORBIDDEN" });
  };
}

export function requireNamespaceGrant(
  getNamespace: (req: Request) => string,
): RequestHandler {
  return (req, res, next) => {
    const principal = getPrincipal(req);
    if (!principal || principal.namespaces === undefined) return next();
    const ns = getNamespace(req);
    if (!principal.namespaces.includes(ns)) {
      auditWithoutBlocking(req, {
        ns,
        op: "namespace.access",
        principal: principal.name,
        reason: "namespace_scope",
      });
      res.status(403).json({
        error: `Forbidden: token '${principal.name}' has no grant for namespace '${ns}'`,
      });
      return;
    }
    next();
  };
}
