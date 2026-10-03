/**
 * S3-QUERY-SCHEME-001 regression tests: `duckbrain s3 query` must honour the
 * configured endpoint's SCHEME.
 *
 * DuckDB's httpfs defaults s3_use_ssl=true and ignores the endpoint URL's
 * scheme, while the AWS SDK push path (src/s3/client.ts) honours it — so an
 * http:// endpoint (MinIO-style staging) was queried over TLS and failed
 * read-back with "SSL connection failed" while push to the same endpoint
 * worked.
 *
 * Method (same shape as cli-endpoint-dogfood030.test.ts and the DB-GAP-048
 * describe in cli-query.test.ts): the real query path runs against a real
 * in-memory DuckDB with `Database.prototype.exec` spied, so every statement
 * issued to the httpfs session is recorded and asserted on the actual SQL —
 * no AWS call, no network (INSTALL/LOAD are mocked no-ops; the only real SQL
 * executed is SELECT 1). AWS env vars are snapshotted in beforeEach and
 * restored in afterEach so no leakage survives into other test files.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Database } from "duckdb";
import { endpointUseSsl, runS3Query } from "./query";
import { DEFAULT_S3_CONFIG, type S3Config } from "./config";

describe("endpointUseSsl (S3-QUERY-SCHEME-001)", () => {
  it("returns false for an explicit http:// endpoint", () => {
    expect(endpointUseSsl("http://minio.internal:9000")).toBe(false);
  });

  it("returns true for an https:// endpoint", () => {
    expect(endpointUseSsl("https://s3.provider.com")).toBe(true);
  });

  it("defaults to true when the endpoint has no usable scheme", () => {
    // Schemeless host: parsed as an opaque "minio.internal:" scheme, not http.
    expect(endpointUseSsl("minio.internal:9000")).toBe(true);
    // Unparseable: URL constructor throws → httpfs' own default (true).
    expect(endpointUseSsl("not a url")).toBe(true);
  });
});

describe("runS3Query applies the endpoint scheme (S3-QUERY-SCHEME-001)", () => {
  const ENV_KEYS = [
    "AWS_PROFILE",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "DUCKBRAIN_S3_ACCESS_KEY_ID",
    "DUCKBRAIN_S3_SECRET_ACCESS_KEY",
  ] as const;

  let envSnapshot: Record<string, string | undefined>;
  let execCalls: string[];

  /** Statements that configured the httpfs S3 session. */
  function appliedSettings(): string {
    return execCalls.filter((sql) => sql.startsWith("SET s3_")).join("\n");
  }

  function cfgWithEndpoint(endpoint: string): S3Config {
    return {
      ...DEFAULT_S3_CONFIG,
      enabled: true,
      endpoint,
      region: "us-east-1",
      bucket: "test-bucket",
      prefix: "duckbrain",
      forcePathStyle: true,
    };
  }

  beforeEach(() => {
    envSnapshot = Object.fromEntries(
      ENV_KEYS.map((k) => [k, process.env[k]]),
    ) as Record<string, string | undefined>;
    for (const k of ENV_KEYS) delete process.env[k];
    execCalls = [];
    vi.spyOn(Database.prototype, "exec").mockImplementation(((sql: string) => {
      execCalls.push(sql);
    }) as never);
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = envSnapshot[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
  });

  it("an http:// endpoint sets s3_use_ssl='false' beside s3_endpoint", async () => {
    await runS3Query(cfgWithEndpoint("http://minio.internal:9000"), "SELECT 1", {
      credentialProvider: vi.fn(async () => {
        throw new Error("provider must not be called for these tests");
      }),
    });

    const applied = appliedSettings();
    expect(applied).toContain("SET s3_endpoint='minio.internal:9000';");
    expect(applied).toContain("SET s3_use_ssl='false';");
  });

  it("an https:// endpoint sets s3_use_ssl='true'", async () => {
    await runS3Query(cfgWithEndpoint("https://s3.provider.com"), "SELECT 1", {
      credentialProvider: vi.fn(async () => {
        throw new Error("provider must not be called for these tests");
      }),
    });

    const applied = appliedSettings();
    expect(applied).toContain("SET s3_endpoint='s3.provider.com';");
    expect(applied).toContain("SET s3_use_ssl='true';");
  });

  it("no endpoint configured: neither setting is touched (httpfs default stands)", async () => {
    const cfg: S3Config = { ...DEFAULT_S3_CONFIG, enabled: true };
    await runS3Query(cfg, "SELECT 1", {
      credentialProvider: vi.fn(async () => {
        throw new Error("provider must not be called for these tests");
      }),
    });

    const applied = appliedSettings();
    expect(applied).not.toContain("s3_endpoint");
    expect(applied).not.toContain("s3_use_ssl");
    // Sanity: the session was still configured (region reaches the wire).
    expect(applied).toContain("SET s3_region=");
  });
});
