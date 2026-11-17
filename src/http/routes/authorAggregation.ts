/**
 * Author aggregation shared by the HTTP route and its fork-light worker.
 *
 * Git is tried first for each namespace. Memory records are consulted only when
 * git is verifiably EMPTY (an empty scan, a namespace without a repository, or
 * a namespace path that does not exist). A git scan that FAILS operationally
 * (timeout, I/O error, non-zero exit) is not the same input as an empty one:
 * that namespace contributes nothing for the request instead of silently
 * swapping its source to memory records, so the served set cannot drift
 * between identical consecutive requests under load.
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
 * Statuses that prove git was actually consulted and has nothing to contribute:
 * a scanned repository with no authors ("empty-success"), a directory that is
 * not a git repository ("no-repo"), and a namespace path or git binary that does
 * not exist ("enoent"). Only these may fall back to memory records.
 *
 * Every other status — "timeout", "non-zero:<message>" — is an operational
 * failure, and an unknown status is treated the same way (fail closed: no
 * source swap) so a future status cannot silently reintroduce the drift.
 */
const VERIFIED_ABSENT_GIT_STATUSES: ReadonlySet<string> = new Set([
  "empty-success",
  "no-repo",
  "enoent",
]);

/** True when an empty git result is a verified absence rather than a failure. */
export function gitStatusAllowsMemoryFallback(status: string): boolean {
  return VERIFIED_ABSENT_GIT_STATUSES.has(status);
}

/**
 * Aggregate authors with a bounded worker pool.
 *
 * A failed git scan is not the same as an empty successful scan: the detailed
 * status decides whether the namespace's memory records are consulted at all.
 * Failures keep the namespace out of the served set for this request; they never
 * swap the source, which is what made the served set load-dependent.
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
      const gitFailed = !gitStatusAllowsMemoryFallback(git.status) && git.status !== "success";
      const db = git.authors.length > 0 || gitFailed
        ? { authors: [], manifest: "not-needed", partitions: "not-needed", duckdbError: "none" }
        : getDbAuthors
          ? await lookupInjectedDb(getDbAuthors, namespace.path)
          : await getAuthorsFromDbDetailed(namespace.path);
      const authors = git.authors.length > 0 ? git.authors : db.authors;

      if (gitFailed) {
        console.error(
          `[author-scan] namespace=${namespace.path} git=${git.status} ` +
            `result=no-fallback-on-failure`,
        );
      } else if (authors.length === 0) {
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
    const authors = await lookup(namespacePath);
    // A RESOLVED lookup is a completed scan: an empty array is verified empty
    // (fallback allowed), a non-empty one is a successful scan. A REJECTED
    // lookup is an operational failure and must never swap the source.
    return { authors, status: authors.length > 0 ? "success" : "empty-success" };
  } catch (error) {
    return { authors: [], status: classifyGitFailure(error) };
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

/**
 * Map a thrown git scan to its status. "no-repo" is the verified-absent case
 * git reports for a path that is not (and is not inside) a repository; it is
 * deliberately distinct from a failing scan so it may fall back to memory.
 */
function classifyGitFailure(error: unknown): string {
  const text = errorText(error);
  if (text === "timeout" || text === "enoent") return text;
  if (/not a git repository/i.test(text)) return "no-repo";
  return `non-zero:${text}`;
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
    return { authors: [], status: classifyGitFailure(error) };
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
