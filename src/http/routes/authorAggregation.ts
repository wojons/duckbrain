/**
 * Author aggregation shared by the HTTP route and its fork-light worker.
 *
 * Git is tried first for each namespace. DuckDB is consulted only when that
 * namespace has no git authors, preserving the route's existing semantics.
 */

import path from "node:path";
import fs from "node:fs";
import { getDuckDBConnection } from "../../duckdb/connection";
import { runGitAsync } from "../../git/exec";

/** Finite per-git bound for one namespace's author scan. */
const GIT_LOG_TIMEOUT_MS = 5000;
/** Bounded output for one git author scan. */
const GIT_LOG_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
/** Maximum number of namespace author scans allowed to run concurrently. */
export const AUTHOR_SCAN_CONCURRENCY = 32;

export type AuthorNamespace = { path: string };
export type AuthorLookup = (namespacePath: string) => Promise<string[]>;

export interface AuthorAggregationOptions {
  concurrency?: number;
  getGitAuthors?: AuthorLookup;
  getDbAuthors?: AuthorLookup;
}

/**
 * Aggregate authors with a bounded worker pool.
 *
 * Each worker keeps the existing per-namespace ordering: it tries git first
 * and queries DuckDB only when that namespace has no git authors. Git errors
 * are treated as empty output so one failed repository still gets its
 * namespace-local fallback.
 */
export async function collectAuthorsForNamespaces(
  namespaces: AuthorNamespace[],
  options: AuthorAggregationOptions = {},
): Promise<string[]> {
  const getGitAuthors = options.getGitAuthors ?? getAuthorsFromGit;
  const getDbAuthors = options.getDbAuthors ?? getAuthorsFromDb;
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
      let gitAuthors: string[];
      try {
        gitAuthors = await getGitAuthors(namespace.path);
      } catch {
        gitAuthors = [];
      }

      const authors =
        gitAuthors.length > 0 ? gitAuthors : await getDbAuthors(namespace.path);
      for (const author of authors) {
        allAuthors.add(author);
      }
    }
  };

  if (workerCount > 0) {
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }

  return [...allAuthors].sort();
}

/** Extract unique authors from a namespace git repository. */
async function getAuthorsFromGit(repoPath: string): Promise<string[]> {
  try {
    const output = (
      await runGitAsync(["log", "--all", "--format=%aN"], repoPath, {
        timeoutMs: GIT_LOG_TIMEOUT_MS,
        maxBufferBytes: GIT_LOG_MAX_BUFFER_BYTES,
      })
    ).trim();

    if (!output) return [];

    return [
      ...new Set(
        output
          .split("\n")
          .map((author) => author.trim())
          .filter(Boolean),
      ),
    ];
  } catch {
    return [];
  }
}

/** Extract unique authors from DuckDB memory entries for one namespace. */
function getAuthorsFromDb(namespacePath: string): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    try {
      const db = getDuckDBConnection("singleton", namespacePath);
      const manifestPath = path.join(namespacePath, "manifest.json");
      if (!fs.existsSync(manifestPath)) {
        resolve([]);
        return;
      }

      let manifest: { partitions?: string[] };
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      } catch {
        resolve([]);
        return;
      }

      const partitionPaths: string[] = (manifest.partitions || [])
        .map((partition) => path.join(namespacePath, partition))
        .filter((partition) => fs.existsSync(partition));

      if (partitionPaths.length === 0) {
        resolve([]);
        return;
      }

      const jsonlFiles: string[] = [];
      for (const partitionPath of partitionPaths) {
        try {
          const files = fs
            .readdirSync(partitionPath)
            .filter((file) => file.endsWith(".jsonl"))
            .map((file) =>
              path.join(partitionPath, file).replace(/\\/g, "/"),
            );
          jsonlFiles.push(...files);
        } catch {
          /* skip inaccessible partitions */
        }
      }

      if (jsonlFiles.length === 0) {
        resolve([]);
        return;
      }

      const fileList = jsonlFiles.map((file) => `'${file}'`).join(", ");
      const sql = `SELECT DISTINCT author FROM read_json([${fileList}], format='newline_delimited') WHERE author IS NOT NULL ORDER BY author`;

      db.all(sql, (error: any, result: any) => {
        if (error || !result || !Array.isArray(result)) {
          resolve([]);
          return;
        }
        const authors = result
          .map((row: any) => row.author as string)
          .filter(Boolean);
        resolve(authors);
      });
    } catch {
      resolve([]);
    }
  });
}
