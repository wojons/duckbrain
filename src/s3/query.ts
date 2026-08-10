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
 * Credentials: read from env AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (also
 * honors the S3_* DuckDB settings if keys are provided via env DUCKBRAIN_S3_*).
 */

import { Database } from "duckdb";
import type { S3Config } from "./config";

export interface S3QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  count: number;
}

/** Host (no scheme) for DuckDB's s3_endpoint setting. */
function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

/**
 * Run a SQL statement with httpfs loaded, against s3:// paths under the
 * configured bucket/prefix. Returns all rows as objects.
 */
export async function runS3Query(
  cfg: S3Config,
  sql: string,
): Promise<S3QueryResult> {
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
    const key =
      process.env.AWS_ACCESS_KEY_ID ?? process.env.DUCKBRAIN_S3_ACCESS_KEY_ID;
    const secret =
      process.env.AWS_SECRET_ACCESS_KEY ??
      process.env.DUCKBRAIN_S3_SECRET_ACCESS_KEY;
    if (key && secret) {
      db.exec(`SET s3_access_key_id='${key}';`);
      db.exec(`SET s3_secret_access_key='${secret}';`);
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
