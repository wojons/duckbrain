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
 *   2. else the AWS SDK v3 default provider chain — the SAME chain
 *      src/s3/client.ts uses — resolves credentials (~/.aws env/shared
 *      config, a profile named by env AWS_PROFILE or the `s3.profile`
 *      config value, SSO, process, …) and the returned key id / secret /
 *      session token are SET on the httpfs session for the duration of the
 *      query. The chain runs whether or not a profile is NAMED: naming one
 *      is a narrowing hint, never a precondition (S3-QUERY-CREDENTIALS-001);
 *   3. if the chain genuinely resolves nothing, the query fails HERE with an
 *      explicit message naming every source it consulted (profiles included,
 *      never values) instead of letting httpfs answer with its opaque
 *      "Authentication Failure — No credentials are provided" 403.
 *
 * Step 2 exists because DuckDB httpfs reads standard AWS_* env vars and does
 * NOT understand the ~/.aws profile chain that boto3 / git-remote-s3 / the
 * AWS SDK honor — so before this, `s3 query` failed on any profile-based
 * install (bunker staging, 2026-09-17) while `s3 status`/`s3 sync` worked.
 * Requiring a NAMED profile was the second half of that bug: on a host whose
 * credentials live in the [default] profile the documented fallback never
 * ran, so the headline read-without-restoring feature 403'd while the SDK
 * paths authenticated (S3-QUERY-CREDENTIALS-001).
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { Database } from "duckdb";
import type { S3Config } from "./config";
import { buildClient } from "./client";
import {
  DEFAULT_MAX_WILDCARD_OBJECTS,
  S3ManyObjectsError,
  formatReadPlanWarning,
  planWildcardReads,
  type ObjectLister,
  type WildcardReadPlan,
} from "./read-plan";

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

/**
 * Where the credentials came from — diagnostics only, never the values.
 *
 * `chain` = the SDK default chain resolved them without a NAMED profile
 * (typically the [default] profile in ~/.aws/credentials);
 * `profile` = they were resolved by the chain for a named profile.
 */
export type CredentialSource = "env" | "profile" | "chain";

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
  /**
   * S3-READ-AMPLIFICATION-001: object lister used by the wildcard read plan.
   * Defaults to one paginated LIST through the SDK chain; tests inject a stub
   * so the refusal is provable with no AWS call.
   */
  listObjects?: ObjectLister;
  /** Objects a wildcard read may cover without --allow-many-objects. */
  maxObjects?: number;
  /** `--allow-many-objects`: pay for the full scan instead of refusing. */
  allowManyObjects?: boolean;
  /** Per-object cost assumption for the estimate (measured default). */
  perObjectSeconds?: number;
  /** Where the plan warning goes; defaults to stderr. */
  onPlanWarning?: (message: string) => void;
  /**
   * SQL execution seam. Defaults to the real DuckDB httpfs session; tests
   * inject a stub so ordering ("plan first, bytes second") is provable.
   */
  execute?: (sql: string) => Promise<Record<string, unknown>[]>;
}

/**
 * Host (no scheme) for DuckDB's s3_endpoint setting.
 *
 * The SCHEME is deliberately dropped here (DuckDB wants a bare host) but is
 * NOT discarded: S3-QUERY-SCHEME-001 — httpfs defaults s3_use_ssl=true and
 * ignores the endpoint URL's scheme (unlike the AWS SDK push path, which
 * honours it), so an http:// endpoint was queried over TLS and failed with
 * "SSL connection failed". endpointUseSsl carries the scheme out instead.
 */
function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

/**
 * Whether httpfs must use TLS for this endpoint (S3-QUERY-SCHEME-001).
 *
 * Only an explicit `http:` protocol is plaintext; everything else — https,
 * schemeless host strings, unparseable endpoints — keeps httpfs' own default
 * (s3_use_ssl=true), so behaviour is unchanged wherever the scheme carries
 * no information.
 */
export function endpointUseSsl(endpoint: string): boolean {
  try {
    return new URL(endpoint).protocol !== "http:";
  } catch {
    return true;
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
 * The shared credentials file the SDK chain reads, for diagnostics only.
 * Honors AWS_SHARED_CREDENTIALS_FILE exactly as the SDK does.
 */
function credentialsFileDisplay(): string {
  const override = process.env.AWS_SHARED_CREDENTIALS_FILE?.trim();
  return override ? override : "~/.aws/credentials";
}

/**
 * Profile NAMES present in the shared credentials file — never any value.
 *
 * Used only to make the no-credentials error honest ("looked at [default],
 * [hetzner]"). Any read failure yields [] — diagnostics must never turn a
 * missing file into a different error.
 */
export function knownProfileNames(
  file: string = process.env.AWS_SHARED_CREDENTIALS_FILE?.trim() ||
    join(homedir(), ".aws", "credentials"),
): string[] {
  try {
    const text = readFileSync(file, "utf8");
    return Array.from(text.matchAll(/^\s*\[([^\]]+)\]\s*$/gm), (m) =>
      m[1]!.trim(),
    );
  } catch {
    return [];
  }
}

/**
 * The honest failure when the chain resolves nothing: say so, name every
 * source consulted (profiles by NAME only), and never fall through to
 * httpfs' opaque 403 (S3-QUERY-CREDENTIALS-001).
 */
function noCredentialsError(cfg: S3Config, cause?: string): Error {
  const named = configuredProfile(cfg);
  const file = credentialsFileDisplay();
  const known = knownProfileNames();
  const profileSource = named
    ? `AWS profile "${named}" (${known.includes(named) ? `present in ${file}` : `NOT present in ${file}`})`
    : `the [default] profile in ${file}`;
  const looked = named
    ? profileSource
    : `AWS_PROFILE (unset) and s3.profile (unset), then ${profileSource}`;
  const present = known.length > 0 ? ` — profiles found there: ${known.join(", ")}` : "";
  return new Error(
    `s3 query: no AWS credentials resolved by the SDK default chain; checked ` +
      `env AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY (and DUCKBRAIN_S3_* overrides), ` +
      `${looked}${present}. Set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, name a ` +
      `profile with AWS_PROFILE, or add a [default] profile to ${file}.` +
      (cause ? ` Chain error: ${cause}` : ""),
  );
}

/**
 * Resolve the credentials to inject into the httpfs session.
 *
 * Throws (never returns undefined) when nothing resolves: httpfs must not be
 * reached with no identity, because its own failure is an opaque HTTP 403
 * that names no source. `provider` is the injectable seam over the SDK chain.
 */
export async function resolveQueryCredentials(
  cfg: S3Config,
  provider?: CredentialProvider,
): Promise<ResolvedQueryCredentials> {
  const direct = envCredentials();
  if (direct) return { ...direct, source: "env" };

  const profile = configuredProfile(cfg);
  const resolve = provider ?? defaultCredentialProvider(cfg);
  let creds: QueryCredentials | undefined;
  let chainError: string | undefined;
  try {
    creds = await resolve();
  } catch (err) {
    chainError = err instanceof Error ? err.message : String(err);
    if (!profile) throw noCredentialsError(cfg, chainError);
    throw new Error(
      `s3 query: could not resolve credentials for AWS profile "${profile}" ` +
        `(set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, or fix ~/.aws/credentials): ${chainError}`,
    );
  }
  if (!creds?.accessKeyId || !creds?.secretAccessKey) {
    if (!profile) throw noCredentialsError(cfg, chainError);
    throw new Error(
      `s3 query: AWS profile "${profile}" resolved without a usable access key`,
    );
  }
  return {
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
    source: profile ? "profile" : "chain",
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

/** The real read: one in-memory DuckDB with httpfs and the resolved identity. */
async function executeWithHttpfs(
  cfg: S3Config,
  credentials: QueryCredentials,
  sql: string,
): Promise<Record<string, unknown>[]> {
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
      // S3-QUERY-SCHEME-001: httpfs defaults s3_use_ssl=true and ignores the
      // endpoint's scheme — carry it out explicitly so http:// endpoints are
      // queried in plaintext, matching the SDK push path to the same endpoint.
      db.exec(`SET s3_use_ssl='${endpointUseSsl(cfg.endpoint)}';`);
    }
    db.exec(`SET s3_region='${cfg.region}';`);
    if (cfg.forcePathStyle) {
      db.exec("SET s3_url_style='path';");
    }
    // httpfs reads AWS_* env automatically, but the resolved chain identity is
    // always SET explicitly — resolveQueryCredentials() guarantees one exists.
    db.exec(`SET s3_access_key_id=${sqlLiteral(credentials.accessKeyId)};`);
    db.exec(
      `SET s3_secret_access_key=${sqlLiteral(credentials.secretAccessKey)};`,
    );
    if (credentials.sessionToken) {
      db.exec(`SET s3_session_token=${sqlLiteral(credentials.sessionToken)};`);
    }

    return await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      db.all(sql, (err, result) => {
        if (err) {
          reject(err);
          return;
        }
        resolve((result ?? []) as Record<string, unknown>[]);
      });
    });
  } finally {
    db.close();
  }
}

/**
 * S3-READ-AMPLIFICATION-001 — ask the cheap question before the expensive one.
 *
 * A wildcard statement is planned from ONE LIST of its prefix: how many objects
 * it matches, their total/typical size, the largest object, and the wall-clock
 * estimate at the measured per-object cost. Above the budget it refuses by
 * default (naming the count, the estimate and the compaction that fixes the
 * layout) instead of starting a scan that cannot finish; `--allow-many-objects`
 * pays for it deliberately. Statements without a wildcard issue no LIST at all.
 */
export async function preflightWildcardRead(
  cfg: S3Config,
  sql: string,
  deps: S3QueryDeps = {},
): Promise<WildcardReadPlan[]> {
  const maxObjects = deps.maxObjects ?? DEFAULT_MAX_WILDCARD_OBJECTS;
  const warn = deps.onPlanWarning ?? ((m: string) => process.stderr.write(`${m}\n`));
  const plans = await planWildcardReads(sql, cfg, {
    ...(deps.listObjects ? { listObjects: deps.listObjects } : {}),
    maxObjects,
    ...(deps.perObjectSeconds ? { perObjectSeconds: deps.perObjectSeconds } : {}),
  });

  const built: WildcardReadPlan[] = [];
  for (const entry of plans) {
    if (!entry.plan) {
      // A plan that cannot be built must never become a new way to fail: say
      // so and let the read report its own error.
      warn(
        `s3 query: could not build a read plan for ${entry.path} (${entry.error ?? "unknown error"}); ` +
          `running the statement unscanned.`,
      );
      continue;
    }
    if (entry.plan.overBudget && deps.allowManyObjects !== true) {
      throw new S3ManyObjectsError(formatReadPlanWarning(entry.plan), entry.plan);
    }
    // Over budget only when the caller paid for it: a routine read of a few
    // objects must stay silent, or the warning becomes noise nobody reads.
    if (entry.plan.overBudget) warn(formatReadPlanWarning(entry.plan));
    built.push(entry.plan);
  }
  return built;
}

/**
 * Run a SQL statement with httpfs loaded, against s3:// paths under the
 * configured bucket/prefix. Returns all rows as objects.
 *
 * S3-READ-AMPLIFICATION-001: the wildcard read plan runs FIRST — before the
 * credential resolution that would hand bytes to httpfs — so an unbudgeted
 * 10,000-object scan is refused instead of hanging for an hour.
 */
export async function runS3Query(
  cfg: S3Config,
  sql: string,
  deps: S3QueryDeps = {},
): Promise<S3QueryResult> {
  await preflightWildcardRead(cfg, sql, deps);

  const credentials = await resolveQueryCredentials(
    cfg,
    deps.credentialProvider,
  );

  const rows = deps.execute
    ? await deps.execute(sql)
    : await executeWithHttpfs(cfg, credentials, sql);

  const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];
  return { columns, rows, count: rows.length };
}
