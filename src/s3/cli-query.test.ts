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
 * profile named, the profile provider's credentials reach the query path.
 *
 * S3-QUERY-CREDENTIALS-001 changes (c): with no env keys and NO named profile
 * the SDK default chain STILL runs (that is what authenticates `s3 status` and
 * `s3 sync` on a [default]-profile host), and when it resolves nothing the
 * query fails with an explicit message naming the sources/profiles it looked
 * at — never an opaque httpfs 403. The regression that would catch a relapse
 * to "profile must be named" is case (c) itself: the provider must be called
 * and its credentials must reach the httpfs session.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_CONFIG_FILE",
    "DUCKBRAIN_S3_ACCESS_KEY_ID",
    "DUCKBRAIN_S3_SECRET_ACCESS_KEY",
  ] as const;

  const ENV_KEY = "test-env-access-key";
  const ENV_SECRET = "test-env-secret-key";
  const PROFILE_KEY = "test-profile-access-key";
  const CHAIN_KEY = "test-chain-access-key";
  const CHAIN_SECRET = "test-chain-secret-key";
  /** A secret that must never appear in an error message, only in a fixture file. */
  const FIXTURE_SECRET = "fixture-secret-must-not-leak";
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

  it("(c) S3-QUERY-CREDENTIALS-001: no env keys and NO named profile — the SDK chain still resolves and its credentials reach httpfs", async () => {
    // THE REGRESSION: before the fix the provider was consulted only when
    // AWS_PROFILE / s3.profile NAMED a profile, so a host whose keys live in
    // the [default] profile injected nothing and httpfs answered 403 while
    // `s3 status` / `s3 sync` authenticated fine on the same host.
    expect(configuredProfile(cfg)).toBeUndefined();
    const provider = vi.fn(async (): Promise<QueryCredentials> => ({
      accessKeyId: CHAIN_KEY,
      secretAccessKey: CHAIN_SECRET,
    }));
    vi.spyOn(Database.prototype, "exec").mockImplementation(((sql: string) => {
      execCalls.push(sql);
    }) as never);

    const resolved = await resolveQueryCredentials(cfg, provider);
    expect(resolved).toEqual({
      accessKeyId: CHAIN_KEY,
      secretAccessKey: CHAIN_SECRET,
      source: "chain",
    });
    expect(provider).toHaveBeenCalledTimes(1);

    await runS3Query(cfg, "SELECT 1", { credentialProvider: provider });
    const injected = credentialSetCalls().join("\n");
    expect(injected).toContain(`s3_access_key_id='${CHAIN_KEY}'`);
    expect(injected).toContain(`s3_secret_access_key='${CHAIN_SECRET}'`);
  });

  it("(e) chain resolves nothing: an explicit error names the sources and the profiles it looked at, and leaks no secret", async () => {
    // A credentials file with two profile NAMES only — the error may quote the
    // names, never a value from the file.
    const dir = mkdtempSync(join(tmpdir(), "s3q-creds-"));
    const credsFile = join(dir, "credentials");
    writeFileSync(
      credsFile,
      `[default]\naws_access_key_id = ${FIXTURE_SECRET}\n` +
        `[hetzner]\naws_access_key_id = ${FIXTURE_SECRET}\n` +
        `[broken-profile]\naws_access_key_id = ${FIXTURE_SECRET}\n`,
    );
    process.env.AWS_SHARED_CREDENTIALS_FILE = credsFile;
    const provider = vi.fn(async (): Promise<QueryCredentials> => {
      throw new Error("Could not load credentials from any providers");
    });
    vi.spyOn(Database.prototype, "exec").mockImplementation(((sql: string) => {
      execCalls.push(sql);
    }) as never);

    const message = await resolveQueryCredentials(cfg, provider).then(
      () => "RESOLVED — expected a failure",
      (err: Error) => err.message,
    );
    // Says the CHAIN resolved nothing (not httpfs' generic 403) …
    expect(message).toMatch(/no AWS credentials resolved by the SDK default chain/);
    // … names the sources it consulted and the profiles present, by name …
    expect(message).toContain("AWS_PROFILE (unset)");
    expect(message).toContain("[default] profile");
    expect(message).toContain("hetzner");
    expect(message).toContain("Could not load credentials from any providers");
    // … and carries no key material.
    expect(message).not.toContain(FIXTURE_SECRET);

    // runS3Query fails BEFORE any httpfs statement runs: no half-configured
    // session, no opaque 403 from the HTTP layer.
    await expect(
      runS3Query(cfg, "SELECT 1", { credentialProvider: provider }),
    ).rejects.toThrow(/no AWS credentials resolved/);
    expect(execCalls).toEqual([]);
  });

  it("(f) chain resolves without a usable key: same explicit error, not a silent unauthenticated query", async () => {
    const provider = vi.fn(
      async (): Promise<QueryCredentials> =>
        ({ accessKeyId: "", secretAccessKey: "" }) as QueryCredentials,
    );
    await expect(resolveQueryCredentials(cfg, provider)).rejects.toThrow(
      /no AWS credentials resolved by the SDK default chain/,
    );
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
