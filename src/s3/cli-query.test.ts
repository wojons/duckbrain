/**
 * Regression tests for `duckbrain s3 query` row printing (S3Q-FIX-001):
 * - node-duckdb returns BigInt for aggregate values (e.g. count(*)) and
 *   native JSON.stringify throws "Do not know how to serialize a BigInt".
 * - formatS3Row routes rows through the codebase's safeJsonStringify helper
 *   (src/utils/serialize.ts): BigInt → Number when safe-integer, String
 *   otherwise, and normal rows serialize exactly as JSON.stringify would.
 *
 * These are pure unit tests — no CLI spawn, no S3, no network.
 *
 * DB-GAP-048 adds credential-resolution coverage for `duckbrain s3 query`:
 * (a) direct env keys still win (regression), (b) with env keys absent and a
 * profile named, the profile provider's credentials reach the query path,
 * (c) with no env keys and no profile, nothing is injected — httpfs raises
 * its own "Authentication Failure" error, unchanged.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Database } from "duckdb";
import { formatS3Row } from "./cli";
import {
  resolveQueryCredentials,
  runS3Query,
  configuredProfile,
  type QueryCredentials,
} from "./query";
import { DEFAULT_S3_CONFIG, type S3Config } from "./config";

describe("formatS3Row (S3Q-FIX-001)", () => {
  it("serializes a row containing a safe-integer BigInt (count(*)) without throwing", () => {
    const out = formatS3Row({ count: 3n });
    expect(out).toContain("3");
  });

  it("serializes a huge BigInt beyond MAX_SAFE_INTEGER as a string", () => {
    const out = formatS3Row({ count: BigInt("9007199254740993") });
    expect(out).toContain("9007199254740993");
  });

  it("keeps the exact JSON shape for normal (non-BigInt) rows", () => {
    const row = { ns: "default", kind: "memory", value: 42, ok: true };
    expect(formatS3Row(row)).toBe(JSON.stringify(row));
  });
});

/**
 * DB-GAP-048 — `duckbrain s3 query` must honor a profile, not just direct
 * AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.
 *
 * Method: the real query path runs against a real in-memory DuckDB, with
 * `Database.prototype.exec` spied so every statement issued to the httpfs
 * session is recorded. The credential INJECTION is therefore asserted on the
 * actual SQL (not on an internal helper), and the profile provider is a stub
 * — no AWS call, no network: the only SQL executed is local (SET ...; a
 * failing bind for the error path).
 */
describe("s3 query credentials (DB-GAP-048)", () => {
  const ENV_KEYS = [
    "AWS_PROFILE",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "DUCKBRAIN_S3_ACCESS_KEY_ID",
    "DUCKBRAIN_S3_SECRET_ACCESS_KEY",
  ] as const;

  const ENV_KEY = "test-env-access-key";
  const ENV_SECRET = "test-env-secret-key";
  const PROFILE_KEY = "test-profile-access-key";
  const PROFILE_SECRET = "test-profile-secret-key";
  const PROFILE_TOKEN = "test-profile-session-token";

  let envSnapshot: Record<string, string | undefined>;
  let execCalls: string[];

  const cfg: S3Config = {
    ...DEFAULT_S3_CONFIG,
    enabled: true,
    endpoint: "https://s3.example.com",
    region: "us-east-1",
    bucket: "test-bucket",
    prefix: "duckbrain",
    forcePathStyle: true,
  };

  /** Statements that actually delivered credentials to the httpfs session. */
  function credentialSetCalls(): string[] {
    return execCalls.filter((sql) =>
      /SET s3_(access_key_id|secret_access_key|session_token)\s*=/.test(sql),
    );
  }

  beforeEach(() => {
    envSnapshot = Object.fromEntries(
      ENV_KEYS.map((k) => [k, process.env[k]]),
    ) as Record<string, string | undefined>;
    for (const k of ENV_KEYS) delete process.env[k];
    execCalls = [];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = envSnapshot[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
  });

  it("(a) direct env keys win: the profile provider is never consulted", async () => {
    process.env.AWS_ACCESS_KEY_ID = ENV_KEY;
    process.env.AWS_SECRET_ACCESS_KEY = ENV_SECRET;
    // A profile is ALSO named — precedence, not absence, is what we assert.
    process.env.AWS_PROFILE = "test-profile";
    const provider = vi.fn(async (): Promise<QueryCredentials> => {
      throw new Error("provider must not be called when env keys are present");
    });
    vi.spyOn(Database.prototype, "exec").mockImplementation(((sql: string) => {
      execCalls.push(sql);
    }) as never);

    await runS3Query(cfg, "SELECT 1", { credentialProvider: provider });

    expect(provider).not.toHaveBeenCalled();
    const injected = credentialSetCalls().join("\n");
    expect(injected).toContain(`s3_access_key_id='${ENV_KEY}'`);
    expect(injected).toContain(`s3_secret_access_key='${ENV_SECRET}'`);
    expect(injected).not.toContain(PROFILE_KEY);
  });

  it("(b) env keys absent + profile named: the profile credentials reach the query path", async () => {
    process.env.AWS_PROFILE = "test-profile";
    const provider = vi.fn(async (): Promise<QueryCredentials> => ({
      accessKeyId: PROFILE_KEY,
      secretAccessKey: PROFILE_SECRET,
      sessionToken: PROFILE_TOKEN,
    }));
    vi.spyOn(Database.prototype, "exec").mockImplementation(((sql: string) => {
      execCalls.push(sql);
    }) as never);

    const resolved = await resolveQueryCredentials(cfg, provider);
    expect(resolved).toEqual({
      accessKeyId: PROFILE_KEY,
      secretAccessKey: PROFILE_SECRET,
      sessionToken: PROFILE_TOKEN,
      source: "profile",
    });
    expect(provider).toHaveBeenCalledTimes(1);

    await runS3Query(cfg, "SELECT 1", { credentialProvider: provider });
    expect(provider).toHaveBeenCalledTimes(2); // once per query, no caching
    const injected = credentialSetCalls().join("\n");
    expect(injected).toContain(`s3_access_key_id='${PROFILE_KEY}'`);
    expect(injected).toContain(`s3_secret_access_key='${PROFILE_SECRET}'`);
    expect(injected).toContain(`s3_session_token='${PROFILE_TOKEN}'`);
  });

  it("(b2) the config profile is used when AWS_PROFILE is unset, and env wins when set", async () => {
    const cfgProfile: S3Config = { ...cfg, profile: "config-profile" };
    expect(configuredProfile(cfgProfile)).toBe("config-profile");
    process.env.AWS_PROFILE = "env-profile";
    expect(configuredProfile(cfgProfile)).toBe("env-profile");
  });

  it("(c) no env keys and no profile: nothing is injected and the failure still surfaces", async () => {
    // No AWS_PROFILE, no cfg.profile, no direct keys.
    console.log(""); // keep console spies from other files from hiding output
    const provider = vi.fn(async (): Promise<QueryCredentials> => {
      throw new Error(
        "provider must not be called without a configured profile",
      );
    });
    const resolved = await resolveQueryCredentials(cfg, provider);
    expect(resolved).toBeUndefined();
    expect(provider).not.toHaveBeenCalled();
    expect(configuredProfile(cfg)).toBeUndefined();

    // The httpfs query path issues NO credential SET, so DuckDB raises its own
    // "Authentication Failure — no credentials are provided" (verified live in
    // the DB-GAP-048 report); and a query failure still rejects, unchanged.
    await expect(
      runS3Query(cfg, "SELECT * FROM dbgap048_no_such_table", {
        credentialProvider: provider,
      }),
    ).rejects.toThrow(/dbgap048_no_such_table/);
    expect(credentialSetCalls()).toEqual([]);
  });

  it("(d) a named profile that cannot be resolved fails loudly, naming the profile", async () => {
    process.env.AWS_PROFILE = "broken-profile";
    const provider = vi.fn(async (): Promise<QueryCredentials> => {
      throw new Error("Could not load credentials from any providers");
    });

    await expect(resolveQueryCredentials(cfg, provider)).rejects.toThrow(
      /AWS profile "broken-profile"/,
    );
    await expect(resolveQueryCredentials(cfg, provider)).rejects.toThrow(
      /Could not load credentials from any providers/,
    );
  });
});
