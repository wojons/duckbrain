/**
 * Author aggregation shared by the HTTP route and its fork-light worker.
 *
 * Git is tried first for each namespace. DuckDB is consulted only when that
 * namespace has no git authors, preserving the route's existing semantics.
 */

import fs from "node:fs";
import path from "node:path";
import { Database } from "duckdb";
import { closeDuckDB, getDuckDBConnection } from "../../duckdb/connection";
import { runGitAsync } from "../../git/exec";

/** Finite per-git bound for one namespace's author scan. */
export const GIT_LOG_TIMEOUT_MS = 5000;
/** Bounded output for one git author scan. */
const GIT_LOG_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
/** Maximum number of namespace author scans allowed to run concurrently. */
export const AUTHOR_SCAN_CONCURRENCY = 32;
/** Child-process scan cap, keeping concurrent git processes below the route bound. */
export const AUTHOR_CHILD_SCAN_CONCURRENCY = Math.min(
  10,
  Math.max(
    1,
    Number.parseInt(process.env.AUTHOR_CHILD_SCAN_CONCURRENCY ?? "8", 10) || 8,
  ),
);

export type AuthorNamespace = { path: string };
export type AuthorLookup = (namespacePath: string) => Promise<string[]>;

export interface AuthorAggregationOptions {
  concurrency?: number;
  getGitAuthors?: AuthorLookup;
  getDbAuthors?: AuthorLookup;
}

type GitScan = { authors: string[]; status: string };
type DbScan = {
  authors: string[];
  manifest: string;
  partitions: string;
  duckdbError: string;
};

/**
 * Aggregate authors with a bounded worker pool.
 *
 * A failed git scan is not the same as an empty successful scan: the detailed
 * result is retained for the stderr diagnostic, while both paths still use
 * the existing namespace-local DuckDB fallback.
 */
export async function collectAuthorsForNamespaces(
  namespaces: AuthorNamespace[],
  options: AuthorAggregationOptions = {},
): Promise<string[]> {
  const getGitAuthors = options.getGitAuthors;
  const getDbAuthors = options.getDbAuthors;
  const requestedConcurrency = options.concurrency ?? AUTHOR_SCAN_CONCURRENCY;
  const workerCount = Math.min(
    namespaces.length,
    Math.max(1, Math.floor(requestedConcurrency)),
  );
  const allAuthors = new Set<string>();
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      if (index >= namespaces.length) return;

      const namespace = namespaces[index];
      const git = getGitAuthors
        ? await lookupInjected(getGitAuthors, namespace.path)
        : await getAuthorsFromGitDetailed(namespace.path);
      const db = git.authors.length > 0
        ? { authors: [], manifest: "not-needed", partitions: "not-needed", duckdbError: "none" }
        : getDbAuthors
          ? await lookupInjectedDb(getDbAuthors, namespace.path)
          : await getAuthorsFromDbDetailed(namespace.path);
      const authors = git.authors.length > 0 ? git.authors : db.authors;

      if (authors.length === 0) {
        console.error(
          `[author-scan] namespace=${namespace.path} git=${git.status} ` +
            `manifest=${db.manifest} partitions=${db.partitions} ` +
            `duckdb_error=${db.duckdbError}`,
        );
      }
      for (const author of authors) allAuthors.add(author);
    }
  };

  if (workerCount > 0) {
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }
  return [...allAuthors].sort();
}

async function lookupInjected(lookup: AuthorLookup, namespacePath: string): Promise<GitScan> {
  try {
    return { authors: await lookup(namespacePath), status: "injected" };
  } catch (error) {
    return { authors: [], status: `non-zero:${errorText(error)}` };
  }
}

async function lookupInjectedDb(lookup: AuthorLookup, namespacePath: string): Promise<DbScan> {
  try {
    return {
      authors: await lookup(namespacePath),
      manifest: "injected",
      partitions: "injected",
      duckdbError: "none",
    };
  } catch (error) {
    return {
      authors: [],
      manifest: "injected",
      partitions: "injected",
      duckdbError: errorText(error),
    };
  }
}

function errorText(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const value = error as { code?: unknown; message?: unknown; killed?: unknown };
  const message = typeof value.message === "string" ? value.message : String(error);
  if (value.killed || /timed? ?out|timeout/i.test(message)) return "timeout";
  if (value.code === "ENOENT") return "enoent";
  return message.replace(/\s+/g, " ").slice(0, 300);
}

/** Extract unique authors from a namespace git repository. */
async function getAuthorsFromGitDetailed(repoPath: string): Promise<GitScan> {
  try {
    const output = (
      await runGitAsync(["log", "--all", "--format=%aN"], repoPath, {
        timeoutMs: GIT_LOG_TIMEOUT_MS,
        maxBufferBytes: GIT_LOG_MAX_BUFFER_BYTES,
      })
    ).trim();
    if (!output) return { authors: [], status: "empty-success" };
    return {
      authors: [...new Set(output.split("\n").map((author) => author.trim()).filter(Boolean))],
      status: "success",
    };
  } catch (error) {
    return { authors: [], status: errorText(error) === "timeout" ? "timeout" : errorText(error) === "enoent" ? "enoent" : `non-zero:${errorText(error)}` };
  }
}

/** Extract unique authors from DuckDB memory entries for one namespace. */
async function getAuthorsFromDbDetailed(namespacePath: string): Promise<DbScan> {
  let db: Database | undefined;
  let manifest = "present";
  let partitions = "present";
  let duckdbError = "none";
  try {
    db = getDuckDBConnection("per-query", ":memory:");
    const manifestPath = path.join(namespacePath, "manifest.json");
    if (!fs.existsSync(manifestPath)) return { authors: [], manifest: "missing", partitions: "not-read", duckdbError };

    let parsed: { partitions?: string[] };
    try {
      parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (error) {
      return { authors: [], manifest: `invalid:${errorText(error)}`, partitions: "not-read", duckdbError };
    }

    const partitionPaths = (parsed.partitions ?? [])
      .map((partition) => path.join(namespacePath, partition))
      .filter((partition) => fs.existsSync(partition));
    if (partitionPaths.length === 0) return { authors: [], manifest, partitions: "missing", duckdbError };

    const jsonlFiles: string[] = [];
    for (const partitionPath of partitionPaths) {
      try {
        jsonlFiles.push(
          ...fs.readdirSync(partitionPath)
            .filter((file) => file.endsWith(".jsonl"))
            .map((file) => path.join(partitionPath, file).replace(/\\/g, "/")),
        );
      } catch (error) {
        partitions = `read-error:${errorText(error)}`;
      }
    }
    if (jsonlFiles.length === 0) return { authors: [], manifest, partitions: "empty", duckdbError };

    // One file per query avoids the heterogeneous attributes inference and
    // native failures seen when 19-22 partitions are mounted as one relation.
    const authors = new Set<string>();
    for (const file of jsonlFiles) {
      const sql = `SELECT DISTINCT author FROM read_json(['${sqlString(file)}'], format='newline_delimited', ignore_errors=true, columns={author:'VARCHAR'}) WHERE author IS NOT NULL ORDER BY author`;
      try {
        const rows = await allRows(db, sql);
        for (const row of rows) if (typeof row.author === "string" && row.author) authors.add(row.author);
      } catch (error) {
        duckdbError = errorText(error);
      }
    }
    return { authors: [...authors].sort(), manifest, partitions, duckdbError };
  } catch (error) {
    duckdbError = errorText(error);
    return { authors: [], manifest, partitions, duckdbError };
  } finally {
    if (db) {
      try { await closeDuckDB(db); } catch { /* best-effort cleanup */ }
    }
  }
}

function sqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function allRows(db: Database, sql: string): Promise<Array<{ author?: unknown }>> {
  return new Promise((resolve, reject) => {
    db.all(sql, (error: Error | null, result: Array<{ author?: unknown }> | undefined) => {
      if (error) reject(error);
      else if (!Array.isArray(result)) reject(new Error("DuckDB returned an invalid author result"));
      else resolve(result);
    });
  });
}
