/**
 * Authentication Middleware
 *
 * Provides configurable authentication for the HTTP server.
 * Supports three modes: none, basic (HTTP Basic Auth with bcrypt),
 * and apikey (X-API-Key header).
 *
 * Health endpoint (/health) always bypasses authentication.
 */

import bcrypt from "bcryptjs";
import { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * API key entry for apikey auth
 */
export interface ApiKeyEntry {
  /** The secret key sent in the X-API-Key header */
  key: string;
  /** Human-readable token name — also the identity stamped on writes */
  name: string;
  /** Namespace grants (DB-GAP-031): when present, the token may only
   *  access these namespaces (403 otherwise). Absent = unrestricted
   *  (backward compatible — existing tokens keep full access). */
  namespaces?: string[];
}

/**
 * Authentication configuration
 */
export interface AuthConfig {
  /** Auth type: 'none' = no auth, 'basic' = HTTP Basic, 'apikey' = API key header */
  type: "none" | "basic" | "apikey";
  /** Users for basic auth (passwords stored as bcrypt hashes) */
  users?: Array<{ username: string; passwordHash: string }>;
  /** API keys for apikey auth */
  apiKeys?: ApiKeyEntry[];
}

/**
 * Authenticated principal attached to req.user by authMiddleware.
 *
 * Present on every request that passed basic/apikey authentication.
 * In auth=none mode no principal is attached (local single-user mode).
 */
export interface AuthPrincipal {
  /** Identity used for author stamping (token name / basic username) */
  name: string;
  /** Always true on an authenticated principal */
  authenticated: boolean;
  /** Namespace grants — undefined = unrestricted (all namespaces) */
  namespaces?: string[];
}

/**
 * Read the authenticated principal off a request.
 *
 * @param req - Express request
 * @returns The principal, or undefined when the request is unauthenticated
 *  (auth=none mode, /health bypass)
 */
export function getPrincipal(req: Request): AuthPrincipal | undefined {
  return (req as any).user as AuthPrincipal | undefined;
}

/**
 * Map an authenticated principal to the author identity stamped on writes.
 *
 * The memory schema requires an email-shaped author (z.string().email()).
 * Token names are frequently not emails (e.g. "agent-alpha"), so non-email
 * names map deterministically to <name>@duckbrain.local — per-agent
 * provenance is preserved (each token yields its own author) while the
 * schema contract holds for every token, including pre-existing ones.
 * Email-shaped names pass through unchanged.
 *
 * @param principal - Authenticated principal
 * @returns Email-shaped author identity derived from the principal name
 */
export function principalAuthorEmail(principal: AuthPrincipal): string {
  const name = principal.name.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(name)) {
    return name;
  }
  // Fold whitespace so arbitrary token names still validate as emails.
  return `${name.replace(/\s+/g, "-")}@duckbrain.local`;
}

/**
 * Create authentication middleware based on config
 *
 * @param config - Authentication configuration
 * @returns Express middleware
 */
export function authMiddleware(config: AuthConfig): RequestHandler {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    // Always allow health endpoint — pre-auth health check
    if (req.path === "/health") {
      return next();
    }

    // No auth required
    if (config.type === "none") {
      return next();
    }

    // HTTP Basic Auth
    if (config.type === "basic") {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Basic ")) {
        res.status(401).json({ error: "Unauthorized: Basic auth required" });
        return;
      }

      try {
        const encoded = authHeader.slice(6); // Remove "Basic "
        const decoded = Buffer.from(encoded, "base64").toString("utf-8");
        const colonIndex = decoded.indexOf(":");
        if (colonIndex === -1) {
          res
            .status(401)
            .json({ error: "Unauthorized: Invalid credentials format" });
          return;
        }

        const username = decoded.slice(0, colonIndex);
        const password = decoded.slice(colonIndex + 1);

        const user = config.users?.find((u) => u.username === username);
        if (!user) {
          res.status(401).json({ error: "Unauthorized: Invalid credentials" });
          return;
        }

        // Verify bcrypt hash
        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) {
          res.status(401).json({ error: "Unauthorized: Invalid credentials" });
          return;
        }

        // Attach user info to request for downstream use.
        // name + authenticated mirror the apikey principal shape so author
        // stamping and grant checks treat both modes uniformly (DB-GAP-031).
        (req as any).user = {
          username,
          name: username,
          authenticated: true,
        };
        return next();
      } catch {
        res.status(401).json({ error: "Unauthorized: Invalid credentials" });
        return;
      }
    }

    // API Key Auth
    if (config.type === "apikey") {
      const apiKey = req.headers["x-api-key"] as string | undefined;
      if (!apiKey) {
        res.status(401).json({ error: "Unauthorized: API key required" });
        return;
      }

      const keyEntry = config.apiKeys?.find((k) => k.key === apiKey);
      if (!keyEntry) {
        res.status(401).json({ error: "Unauthorized: Invalid API key" });
        return;
      }

      // Attach key info to request — name is the author-stamping identity,
      // namespaces carries the token's grants (undefined = unrestricted).
      (req as any).user = {
        name: keyEntry.name,
        authenticated: true,
        ...(keyEntry.namespaces !== undefined
          ? { namespaces: keyEntry.namespaces }
          : {}),
      };
      return next();
    }

    // Unknown auth type — deny by default
    res.status(500).json({ error: "Unknown auth type" });
  };
}

/**
 * Require authentication — use after authMiddleware to ensure user is set
 * Useful for protecting specific routes
 */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!(req as any).user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  next();
}

/**
 * Namespace grant enforcement (DB-GAP-031)
 *
 * Mount on namespace-scoped routers AFTER authMiddleware. Resolves the
 * target namespace via getNamespace(req) and rejects with 403 when the
 * authenticated principal holds an explicit namespaces grant list that does
 * not include it.
 *
 * Passes through untouched when:
 *  - there is no principal (auth=none local single-user mode, /health), or
 *  - the principal has no namespaces list (unrestricted token — backward
 *    compatible with pre-grant tokens).
 *
 * @param getNamespace - Resolves the namespace a request targets (query
 *  param, body field, etc.) — must mirror the route's own resolution.
 * @returns Express middleware
 */
export function requireNamespaceGrant(
  getNamespace: (req: Request) => string,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const principal = getPrincipal(req);
    if (!principal || principal.namespaces === undefined) {
      return next();
    }
    const ns = getNamespace(req);
    if (!principal.namespaces.includes(ns)) {
      res.status(403).json({
        error: `Forbidden: token '${principal.name}' has no grant for namespace '${ns}'`,
      });
      return;
    }
    next();
  };
}
