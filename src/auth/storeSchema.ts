import crypto from "crypto";
import fs from "fs";
import path from "path";
import { z } from "zod";
import { type Role } from "./roles";

const RoleSchema = z.enum(["admin", "writer", "analyst", "uploader"]);
const TableGrantSchema = z.enum(["read", "write", "rw"]);
const ExpiresAtSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value)), "invalid expiresAt");
const SqlPolicySchema = z
  .strictObject({
    read: z.boolean().optional(),
    write: z.boolean().optional(),
    maxRows: z.number().int().positive().optional(),
    maxMemoryBytes: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .optional();
const PrincipalFields = {
  roles: z.array(RoleSchema).optional(),
  namespaces: z.array(z.string().min(1)).optional(),
  expiresAt: ExpiresAtSchema.optional(),
};
const ApiKeyMetadata = {
  name: z.string().min(1),
  ...PrincipalFields,
  tableGrants: z
    .record(z.string().regex(/^[a-z0-9_./-]+$/), TableGrantSchema)
    .optional(),
  sql: SqlPolicySchema,
};

export const HashedApiKeyEntrySchema = z.strictObject({
  keyHash: z.string().regex(/^\$sha256\$[0-9a-f]{64}$/),
  ...ApiKeyMetadata,
});

export const LegacyApiKeyEntrySchema = z.strictObject({
  key: z
    .string()
    .min(1)
    .refine((value) => !value.startsWith("$sha256$"), {
      message: "hashed API keys must use keyHash",
    }),
  ...ApiKeyMetadata,
});

export const ApiKeyEntrySchema = z.union([
  HashedApiKeyEntrySchema,
  LegacyApiKeyEntrySchema,
]);

export const UserEntrySchema = z.strictObject({
  username: z.string().min(1),
  passwordHash: z.string().min(1),
  ...PrincipalFields,
});

export const AuthStoreSchema = z.strictObject({
  users: z.array(UserEntrySchema).default([]),
  apiKeys: z.array(ApiKeyEntrySchema).default([]),
});

export type HashedApiKeyEntry = z.infer<typeof HashedApiKeyEntrySchema>;
export type LegacyApiKeyEntry = z.infer<typeof LegacyApiKeyEntrySchema>;
export type ApiKeyEntry = z.infer<typeof ApiKeyEntrySchema>;
export type UserEntry = z.infer<typeof UserEntrySchema>;
export type AuthStore = z.infer<typeof AuthStoreSchema>;
export type { Role };

export interface AuthStoreSource {
  getSnapshot(): AuthStore | Promise<AuthStore>;
  migrateLegacyApiKey?(name: string, plaintext: string): void | Promise<void>;
}

export function hashApiKey(key: string): string {
  return `$sha256$${crypto.createHash("sha256").update(key, "utf-8").digest("hex")}`;
}

function formatValidation(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => `${issue.path.join(".") || "store"}: ${issue.message}`)
      .join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

function readValidated(file: string): AuthStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return AuthStoreSchema.parse(parsed);
  } catch (error) {
    throw new Error(`Invalid auth store ${file}: ${formatValidation(error)}`);
  }
}

function fingerprint(file: string): string {
  const stat = fs.statSync(file, { bigint: true });
  return `${stat.mtimeNs}:${stat.size}:${stat.ino}`;
}

function atomicWrite(file: string, store: AuthStore): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(store, null, 2) + "\n", "utf-8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
    const dirFd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temp);
    } catch {
      // The rename consumed the temp file on success.
    }
  }
}

export interface FileAuthStoreOptions {
  log?: (message: string) => void;
}

/**
 * Validated, mtime-gated auth store. Startup failures throw; reload failures
 * retain the last good snapshot and are logged once per observed file version.
 */
export class FileAuthStore implements AuthStoreSource {
  readonly file: string;
  private readonly log: (message: string) => void;
  private snapshot: AuthStore;
  private observedFingerprint: string;
  private readonly deprecated = new Set<string>();

  constructor(file: string, options: FileAuthStoreOptions = {}) {
    this.file = path.resolve(file);
    this.log = options.log ?? ((message) => console.error(message));
    this.snapshot = readValidated(this.file);
    this.observedFingerprint = fingerprint(this.file);
    this.logLegacyTokens(this.snapshot);
  }

  getSnapshot(): AuthStore {
    let current: string;
    try {
      current = fingerprint(this.file);
    } catch (error) {
      this.log(
        `[duckbrain] auth store reload failed; retaining last good snapshot: ${formatValidation(error)}`,
      );
      return this.snapshot;
    }
    if (current === this.observedFingerprint) return this.snapshot;

    // Record the observed version even when validation fails. This prevents a
    // malformed mid-write file from being reparsed on every request; a later
    // correction changes mtime/fingerprint and gets one fresh attempt.
    this.observedFingerprint = current;
    try {
      const next = readValidated(this.file);
      this.snapshot = next;
      this.logLegacyTokens(next);
    } catch (error) {
      this.log(
        `[duckbrain] auth store reload failed; retaining last good snapshot: ${formatValidation(error)}`,
      );
    }
    return this.snapshot;
  }

  migrateLegacyApiKey(name: string, plaintext: string): void {
    const current = this.getSnapshot();
    const matched = current.apiKeys.some(
      (entry) =>
        "key" in entry && entry.name === name && entry.key === plaintext,
    );
    if (!matched) return;
    const migratedNames: string[] = [];
    const next: AuthStore = {
      users: current.users.map((user) => ({ ...user })),
      apiKeys: current.apiKeys.map((entry) => {
        if (!("key" in entry)) return { ...entry };
        const { key, ...metadata } = entry;
        migratedNames.push(entry.name);
        return { ...metadata, keyHash: hashApiKey(key) };
      }),
    };
    const validated = AuthStoreSchema.parse(next);
    atomicWrite(this.file, validated);
    this.snapshot = validated;
    this.observedFingerprint = fingerprint(this.file);
    this.log(
      `[duckbrain] Migrated legacy plaintext API keys to sha256 digests: ${migratedNames.join(", ")}`,
    );
  }

  private logLegacyTokens(store: AuthStore): void {
    for (const entry of store.apiKeys) {
      if (entry.roles !== undefined || entry.tableGrants !== undefined)
        continue;
      if (this.deprecated.has(entry.name)) continue;
      this.deprecated.add(entry.name);
      this.log(
        `[duckbrain] Deprecated legacy API token '${entry.name}' has no roles/tableGrants; treating it as admin-equivalent within namespace scope`,
      );
    }
  }
}
