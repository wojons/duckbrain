import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import {
  authMiddleware,
  createAuthBackend,
  getPrincipal,
  requireRawSqlGrant,
  requireRole,
  requireTableGrant,
  type AuthBackend,
  type AuthConfig,
} from "./middleware";
import { hashApiKey } from "./storeSchema";

function req(headers: Request["headers"] = {}): Request {
  return { path: "/resource", headers, query: {}, params: {} } as Request;
}

function res() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { response: { status, json } as unknown as Response, status, json };
}

async function drive(config: AuthConfig, request: Request) {
  const output = res();
  const next = vi.fn() as unknown as NextFunction;
  await authMiddleware(config)(request, output.response, next);
  return { ...output, next };
}

describe("SUPA-4 AuthBackend interface", () => {
  it("none, basic, and apikey satisfy type + Promise authenticate contract", async () => {
    const hash = await bcrypt.hash("password", 4);
    const configs: AuthConfig[] = [
      { type: "none" },
      { type: "basic", users: [{ username: "alice", passwordHash: hash }] },
      {
        type: "apikey",
        apiKeys: [
          { keyHash: hashApiKey("secret"), name: "agent", roles: ["writer"] },
        ],
      },
    ];

    const backends: AuthBackend[] = configs.map(createAuthBackend);
    expect(backends.map((backend) => backend.type)).toEqual([
      "none",
      "basic",
      "apikey",
    ]);
    await expect(backends[0].authenticate(req())).resolves.toBeNull();
    await expect(
      backends[1].authenticate(
        req({
          authorization: `Basic ${Buffer.from("alice:password").toString("base64")}`,
        }),
      ),
    ).resolves.toMatchObject({ name: "alice", tokenType: "basic" });
    await expect(
      backends[2].authenticate(req({ "x-api-key": "secret" })),
    ).resolves.toMatchObject({ name: "agent", tokenType: "apikey" });
  });

  it("apikey digest lookup uses constant-time equality and never accepts Bearer", async () => {
    const equal = vi.spyOn(crypto, "timingSafeEqual");
    const backend = createAuthBackend({
      type: "apikey",
      apiKeys: [
        { keyHash: hashApiKey("secret"), name: "agent", roles: ["writer"] },
      ],
    });
    await backend.authenticate(req({ "x-api-key": "secret" }));
    expect(equal).toHaveBeenCalled();
    await expect(
      backend.authenticate(req({ authorization: "Bearer secret" })),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("basic analyst reads a table but write is denied and audited", async () => {
    const passwordHash = await bcrypt.hash("password", 4);
    const auditDenial = vi.fn();
    const request = req({
      authorization: `Basic ${Buffer.from("analyst:password").toString("base64")}`,
    });
    request.query = { namespace: "alpha" };
    const auth = await drive(
      {
        type: "basic",
        users: [
          {
            username: "analyst",
            passwordHash,
            roles: ["analyst"],
            namespaces: ["alpha"],
          },
        ],
        auditDenial,
      },
      request,
    );
    expect(auth.next).toHaveBeenCalled();

    const readNext = vi.fn();
    requireTableGrant(
      () => "alpha",
      () => "memories",
      "read",
    )(request, res().response, readNext);
    expect(readNext).toHaveBeenCalled();

    const denied = res();
    requireTableGrant(
      () => "alpha",
      () => "memories",
      "write",
    )(request, denied.response, vi.fn());
    expect(denied.status).toHaveBeenCalledWith(403);
    expect(auditDenial).toHaveBeenCalledWith(
      expect.objectContaining({
        ns: "alpha",
        table: "memories",
        reason: "role",
      }),
    );
  });

  it("requireRole applies role unions and audits a non-matching principal", async () => {
    const auditDenial = vi.fn();
    const request = req({ "x-api-key": "multi-role-key" });
    request.query = { namespace: "alpha" };
    const auth = await drive(
      {
        type: "apikey",
        apiKeys: [
          {
            key: "multi-role-key",
            name: "multi-role",
            roles: ["writer", "uploader"],
          },
        ],
        auditDenial,
      },
      request,
    );
    expect(auth.next).toHaveBeenCalled();

    const allowed = vi.fn();
    requireRole("analyst", "uploader")(request, res().response, allowed);
    expect(allowed).toHaveBeenCalledTimes(1);

    const denied = res();
    requireRole("analyst")(request, denied.response, vi.fn());
    expect(denied.status).toHaveBeenCalledWith(403);
    expect(auditDenial).toHaveBeenCalledWith(
      expect.objectContaining({
        ns: "alpha",
        principal: "multi-role",
        reason: "role",
      }),
    );
  });

  it("raw SQL write flag denial returns 403 and audits sql_flag", async () => {
    const auditDenial = vi.fn();
    const request = req({ "x-api-key": "analyst-key" });
    request.query = { namespace: "alpha" };
    const auth = await drive(
      {
        type: "apikey",
        apiKeys: [
          {
            key: "analyst-key",
            name: "analyst",
            roles: ["analyst"],
            sql: { read: true },
          },
        ],
        auditDenial,
      },
      request,
    );
    expect(auth.next).toHaveBeenCalled();
    const denied = res();
    requireRawSqlGrant(() => "alpha", "write")(
      request,
      denied.response,
      vi.fn(),
    );
    expect(denied.status).toHaveBeenCalledWith(403);
    expect(auditDenial).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "sql_flag", op: "sql.write" }),
    );
  });

  it("auth=none attaches no principal and grant middleware remains byte-pass-through", async () => {
    const request = req();
    const auth = await drive({ type: "none" }, request);
    expect(auth.next).toHaveBeenCalledTimes(1);
    expect(getPrincipal(request)).toBeUndefined();

    const next = vi.fn();
    const output = res();
    requireTableGrant(
      () => "alpha",
      () => "memories",
      "write",
    )(request, output.response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(output.status).not.toHaveBeenCalled();
  });

  it("valid and invalid middleware responses preserve shipped observable behavior", async () => {
    const missing = await drive({ type: "apikey", apiKeys: [] }, req());
    expect(missing.status).toHaveBeenCalledWith(401);
    expect(missing.json).toHaveBeenCalledWith({
      error: "Unauthorized: API key required",
    });

    const validRequest = req({ "x-api-key": "legacy" });
    const valid = await drive(
      { type: "apikey", apiKeys: [{ key: "legacy", name: "legacy" }] },
      validRequest,
    );
    expect(valid.next).toHaveBeenCalledTimes(1);
    expect(getPrincipal(validRequest)).toMatchObject({
      name: "legacy",
      authenticated: true,
    });
  });
});
