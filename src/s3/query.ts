/**
 * SQL over S3 via DuckDB's httpfs extension.
 *
 * THE HEADLINE FEATURE: query namespace data straight from the bucket without
 * restoring — e.g. `SELECT ... FROM read_json_auto('s3://bucket/prefix/ns/event/2026-08/current.jsonl')`
 * or read_parquet over squashed partitions.
 *
 * ⚠️ Runs on its OWN DuckDB connection (in-memory Database) — NEVER the
 * singleton connection used by the MCP tools, which strips extensions
 * (the VSS crash bug). INSTALL httpfs requires network on first use.
 *
 * Credentials (DB-GAP-048) — resolved ONCE per query, in this precedence:
 *   1. direct env: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, or the
 *      DUCKBRAIN_S3_* overrides — injected verbatim, no SDK call at all;
 *   2. else, when a profile is named (env AWS_PROFILE, or the `s3.profile`
 *      config value), the AWS SDK v3 default provider chain resolves that
 *      profile (~/.aws/credentials, SSO, process, …) — the SAME chain
 *      src/s3/client.ts uses — and the returned key id / secret / session
 *      token are SET on the httpfs session for the duration of the query;
 *   3. else nothing is injected and httpfs raises its own
 *      "Authentication Failure — no credentials are provided".
 *
 * Step 2 exists because DuckDB httpfs reads standard AWS_* env vars and does
 * NOT understand the ~/.aws profile chain that boto3 / git-remote-s3 / the
 * AWS SDK honor — so before this, `s3 query` failed on any profile-based
 * install (bunker staging, 2026-09-17) while `s3 status`/`s3 sync` worked.
 */

import { Database } from "duckdb";
import type { S3Config } from "./config";
import { buildClient } from "./client";

export interface S3QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  count: number;
}

/** Credential shape httpfs accepts (a subset of the SDK's identity type). */
export interface QueryCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** Where the credentials came from — diagnostics only, never the values. */
export type CredentialSource = "env" | "profile";

export interface ResolvedQueryCredentials extends QueryCredentials {
  source: CredentialSource;
}

/** A credential provider: the AWS SDK default chain as produced by buildClient. */
export type CredentialProvider = () => Promise<QueryCredentials>;

export interface S3QueryDeps {
  /**
   * Override the profile credential provider. Defaults to the AWS SDK v3
   * default provider chain (`buildClient(cfg).config.credentials`) — the
   * same chain `s3 sync`/`s3 status` use. Tests inject a stub here so the
   * profile path is provable with no AWS calls and no network.
   */
  credentialProvider?: CredentialProvider;
}

/** Host (no scheme) for DuckDB's s3_endpoint setting. */
function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

/** Quote a value for a DuckDB SET ... = '...' literal (escape embedded quotes). */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Direct env credentials — the pre-existing precedence, unchanged. */
function envCredentials(): QueryCredentials | undefined {
  const key =
    process.env.AWS_ACCESS_KEY_ID ?? process.env.DUCKBRAIN_S3_ACCESS_KEY_ID;
  const secret =
    process.env.AWS_SECRET_ACCESS_KEY ??
    process.env.DUCKBRAIN_S3_SECRET_ACCESS_KEY;
  if (key && secret) return { accessKeyId: key, secretAccessKey: secret };
  return undefined;
}

/** The profile to resolve, if any is named (env wins over config). */
export function configuredProfile(cfg: S3Config): string | undefined {
  const fromEnv = process.env.AWS_PROFILE?.trim();
  if (fromEnv) return fromEnv;
  const fromCfg = cfg.profile?.trim();
  return fromCfg ? fromCfg : undefined;
}

/**
 * Resolve the credentials to inject into the httpfs session.
 *
 * Returns undefined when nothing is configured — deliberately: httpfs must
 * then raise its own authentication error, exactly as before. A profile that
 * IS named but cannot be resolved throws, naming the profile, rather than
 * degrading into a misleading "no credentials are provided".
 */
export async function resolveQueryCredentials(
  cfg: S3Config,
  provider?: CredentialProvider,
): Promise<ResolvedQueryCredentials | undefined> {
  const direct = envCredentials();
  if (direct) return { ...direct, source: "env" };

  const profile = configuredProfile(cfg);
  if (!profile) return undefined;

  const resolve = provider ?? defaultCredentialProvider(cfg);
  let creds: QueryCredentials | undefined;
  try {
    creds = await resolve();
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `s3 query: could not resolve credentials for AWS profile "${profile}" ` +
        `(set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, or fix ~/.aws/credentials): ${cause}`,
    );
  }
  if (!creds?.accessKeyId || !creds?.secretAccessKey) {
    throw new Error(
      `s3 query: AWS profile "${profile}" resolved without a usable access key`,
    );
  }
  return {
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
    source: "profile",
  };
}

/** Default provider: the SDK chain of a client built with this config. */
function defaultCredentialProvider(cfg: S3Config): CredentialProvider {
  return async () => {
    const client = buildClient(cfg);
    try {
      const creds = await client.config.credentials();
      return {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
      };
    } finally {
      client.destroy();
    }
  };
}

/**
 * Run a SQL statement with httpfs loaded, against s3:// paths under the
 * configured bucket/prefix. Returns all rows as objects.
 */
export async function runS3Query(
  cfg: S3Config,
  sql: string,
  deps: S3QueryDeps = {},
): Promise<S3QueryResult> {
  const credentials = await resolveQueryCredentials(
    cfg,
    deps.credentialProvider,
  );

  const db = new Database(":memory:");
  try {
    // INSTALL is idempotent-ish; swallow "already installed" errors.
    try {
      db.exec("INSTALL httpfs;");
    } catch {
      // already installed or offline — LOAD will surface real problems
    }
    db.exec("LOAD httpfs;");

    if (cfg.endpoint) {
      db.exec(`SET s3_endpoint='${endpointHost(cfg.endpoint)}';`);
    }
    db.exec(`SET s3_region='${cfg.region}';`);
    if (cfg.forcePathStyle) {
      db.exec("SET s3_url_style='path';");
    }
    // httpfs reads AWS_* env automatically; SET explicitly when present.
    if (credentials) {
      db.exec(`SET s3_access_key_id=${sqlLiteral(credentials.accessKeyId)};`);
      db.exec(
        `SET s3_secret_access_key=${sqlLiteral(credentials.secretAccessKey)};`,
      );
      if (credentials.sessionToken) {
        db.exec(
          `SET s3_session_token=${sqlLiteral(credentials.sessionToken)};`,
        );
      }
    }

    const rows = await new Promise<Record<string, unknown>[]>(
      (resolve, reject) => {
        db.all(sql, (err, result) => {
          if (err) {
            reject(err);
            return;
          }
          const typed = (result ?? []) as Record<string, unknown>[];
          resolve(typed);
        });
      },
    );

    const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];
    return { columns, rows, count: rows.length };
  } finally {
    db.close();
  }
}
