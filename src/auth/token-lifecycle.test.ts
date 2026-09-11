import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import { createAuthBackend, type AuthConfig } from "./middleware";
import { AuthStoreSchema, FileAuthStore, hashApiKey } from "./storeSchema";

function requestWithKey(key: string): Request {
  return { headers: { "x-api-key": key } } as unknown as Request;
}

function writeStore(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  const next = new Date(Date.now() + 1_000);
  fs.utimesSync(file, next, next);
}

describe("SUPA-4 token lifecycle", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-supa4-auth-"));
    file = path.join(dir, "auth.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("expired key fails with TOKEN_EXPIRED; future key passes; equality is expired", async () => {
    const token = "a".repeat(32);
    const now = new Date("2026-09-10T12:00:00.000Z");
    const entry = (expiresAt: string) => ({
      keyHash: hashApiKey(token),
      name: "expiring",
      roles: ["writer"],
      expiresAt,
    });

    for (const expiresAt of [
      "2026-09-10T11:59:59.999Z",
      "2026-09-10T12:00:00.000Z",
    ]) {
      const backend = createAuthBackend({
        type: "apikey",
        apiKeys: [entry(expiresAt)],
        now: () => now,
      } as AuthConfig);
      await expect(
        backend.authenticate(requestWithKey(token)),
      ).rejects.toMatchObject({
        status: 401,
        code: "TOKEN_EXPIRED",
        reason: "expired",
      });
    }

    const backend = createAuthBackend({
      type: "apikey",
      apiKeys: [entry("2026-09-10T12:00:00.001Z")],
      now: () => now,
    } as AuthConfig);
    await expect(
      backend.authenticate(requestWithKey(token)),
    ).resolves.toMatchObject({
      name: "expiring",
      tokenType: "apikey",
    });
  });

  it("removing an entry revokes it on the next mtime-gated request", async () => {
    const token = "b".repeat(32);
    writeStore(file, {
      apiKeys: [
        { keyHash: hashApiKey(token), name: "revocable", roles: ["writer"] },
      ],
    });
    const store = new FileAuthStore(file);
    const backend = createAuthBackend({ type: "apikey", store });
    await expect(
      backend.authenticate(requestWithKey(token)),
    ).resolves.toMatchObject({
      name: "revocable",
    });

    writeStore(file, { apiKeys: [] });
    await expect(
      backend.authenticate(requestWithKey(token)),
    ).rejects.toMatchObject({
      status: 401,
      message: "Unauthorized: Invalid API key",
    });
  });

  it("digest lookup authenticates without storing plaintext", async () => {
    const token = "c".repeat(32);
    writeStore(file, {
      apiKeys: [
        { keyHash: hashApiKey(token), name: "hashed", roles: ["analyst"] },
      ],
    });
    const raw = fs.readFileSync(file, "utf-8");
    expect(raw).not.toContain(token);
    expect(raw).toMatch(/\$sha256\$[0-9a-f]{64}/);

    const backend = createAuthBackend({
      type: "apikey",
      store: new FileAuthStore(file),
    });
    await expect(
      backend.authenticate(requestWithKey(token)),
    ).resolves.toMatchObject({
      name: "hashed",
      roles: ["analyst"],
    });
  });

  it("legacy plaintext key migrates atomically after successful auth", async () => {
    const token = "legacy-secret-that-must-disappear";
    writeStore(file, {
      apiKeys: [
        { key: token, name: "legacy-agent", namespaces: ["alpha"] },
        { key: "another-legacy-secret", name: "legacy-peer" },
      ],
    });
    const log = vi.fn();
    const store = new FileAuthStore(file, { log });
    const backend = createAuthBackend({ type: "apikey", store });

    await expect(
      backend.authenticate(requestWithKey(token)),
    ).resolves.toMatchObject({
      name: "legacy-agent",
      namespaces: ["alpha"],
    });
    const migrated = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(migrated.apiKeys.every((entry: object) => !("key" in entry))).toBe(
      true,
    );
    expect(migrated.apiKeys[0].keyHash).toBe(hashApiKey(token));
    const migratedRaw = fs.readFileSync(file, "utf-8");
    expect(migratedRaw).not.toContain(token);
    expect(migratedRaw).not.toContain("another-legacy-secret");
    expect(AuthStoreSchema.parse(migrated)).toBeDefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("legacy-agent"));
  });

  it("legacy no-role token stays admin-equivalent and logs deprecation by name", async () => {
    const token = "d".repeat(32);
    writeStore(file, {
      apiKeys: [{ keyHash: hashApiKey(token), name: "old-agent" }],
    });
    const log = vi.fn();
    const backend = createAuthBackend({
      type: "apikey",
      store: new FileAuthStore(file, { log }),
    });
    const principal = await backend.authenticate(requestWithKey(token));
    expect(principal?.roles).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("old-agent"));
    expect(log.mock.calls.flat().join(" ")).not.toContain(token);
  });

  it.each([
    [
      {
        apiKeys: [{ keyHash: hashApiKey("x"), name: "bad", roles: ["owner"] }],
      },
    ],
    [
      {
        apiKeys: [
          {
            keyHash: hashApiKey("x"),
            name: "bad",
            roles: ["writer"],
            expiresAt: "tomorrow",
          },
        ],
      },
    ],
    [
      {
        apiKeys: [
          {
            keyHash: hashApiKey("x"),
            name: "bad",
            roles: ["writer"],
            tableGrants: { memories: "owner" },
          },
        ],
      },
    ],
  ])(
    "invalid role, expiry, or table grant fails startup validation",
    (value) => {
      writeStore(file, value);
      expect(() => new FileAuthStore(file)).toThrow(/Invalid auth store/);
    },
  );

  it("reload failure retains the last good snapshot and never fails open", async () => {
    const token = "e".repeat(32);
    writeStore(file, {
      apiKeys: [
        { keyHash: hashApiKey(token), name: "stable", roles: ["writer"] },
      ],
    });
    const log = vi.fn();
    const store = new FileAuthStore(file, { log });
    const backend = createAuthBackend({ type: "apikey", store });

    writeStore(file, { apiKeys: [{ name: "mid-write" }] });
    await expect(
      backend.authenticate(requestWithKey(token)),
    ).resolves.toMatchObject({
      name: "stable",
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("reload failed"));
  });
});
