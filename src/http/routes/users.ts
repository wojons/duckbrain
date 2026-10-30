/**
 * Users API Routes
 *
 * Extracts unique authors from namespace git commit history.
 * Falls back to DuckDB memory queries if git is unavailable.
 */

import { Router, Request, Response } from "express";
import { runGitAsync } from "../../git/exec";
import { listNamespacesTool } from "../../mcp/tools/namespace";
import { getDuckDBConnection } from "../../duckdb/connection";
import { asyncHandler } from "../middleware/errorHandler";
import { getPrincipal } from "../../auth/middleware";
import path from "path";
import fs from "fs";

const router: Router = Router();

/** Finite per-git bound for one namespace's author scan (was the execSync timeout). */
const GIT_LOG_TIMEOUT_MS = 5000;
/** Bounded output: a chatty/looping log cannot grow the capture without limit. */
const GIT_LOG_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
/** Maximum number of namespace author scans allowed to run concurrently. */
const AUTHOR_SCAN_CONCURRENCY = 32;

type AuthorNamespace = { path: string };
type AuthorLookup = (namespacePath: string) => Promise<string[]>;

interface AuthorAggregationOptions {
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

/**
 * Extract unique authors from a git repository using git log.
 * Returns empty array if git is unavailable or repo has no commits.
 *
 * OPS-007: the spawn is bounded AND asynchronous (src/git/exec.ts) — it used
 * to be `execSync` inside the GET /users handler loop, so one slow namespace
 * repo stalled the event loop (and /health) for the whole scan. The caller
 * awaits it sequentially, which keeps the previous per-namespace semantics
 * while leaving the loop free between namespaces. Never rejects: a git error,
 * timeout or empty log yields [] and the route falls back to DuckDB.
 */
async function getAuthorsFromGit(repoPath: string): Promise<string[]> {
  try {
    const output = (
      await runGitAsync(["log", "--all", "--format=%aN"], repoPath, {
        timeoutMs: GIT_LOG_TIMEOUT_MS,
        maxBufferBytes: GIT_LOG_MAX_BUFFER_BYTES,
      })
    ).trim();

    if (!output) return [];

    // Split, trim, deduplicate, and filter empty lines
    return [
      ...new Set(
        output
          .split("\n")
          .map((a) => a.trim())
          .filter(Boolean),
      ),
    ];
  } catch {
    // Git not available or repo has no commits
    return [];
  }
}

/**
 * Fallback: extract unique authors from DuckDB memory entries.
 * Scans partition JSONL files for distinct author values.
 */
function getAuthorsFromDb(namespacePath: string): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    try {
      const db = getDuckDBConnection("singleton", namespacePath);

      // Get all partition paths from manifest
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
        .map((p: string) => path.join(namespacePath, p))
        .filter((p: string) => fs.existsSync(p));

      if (partitionPaths.length === 0) {
        resolve([]);
        return;
      }

      // Build file list
      const jsonlFiles: string[] = [];
      for (const pp of partitionPaths) {
        try {
          const files = fs
            .readdirSync(pp)
            .filter((f: string) => f.endsWith(".jsonl"))
            .map((f: string) => path.join(pp, f).replace(/\\/g, "/"));
          jsonlFiles.push(...files);
        } catch {
          /* skip inaccessible partitions */
        }
      }

      if (jsonlFiles.length === 0) {
        resolve([]);
        return;
      }

      const fileList = jsonlFiles.map((f: string) => `'${f}'`).join(", ");
      const sql = `SELECT DISTINCT author FROM read_json([${fileList}], format='newline_delimited') WHERE author IS NOT NULL ORDER BY author`;

      db.all(sql, (err: any, result: any) => {
        if (err || !result || !Array.isArray(result)) {
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

/**
 * GET /users
 * List unique authors across all namespaces from git commit history.
 * Falls back to DuckDB memory data if git is unavailable.
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    // card t_667d7e6c: author aggregation follows the caller's grant — the
    // namespace set handed to the tool is grant-filtered, so a scoped token
    // neither learns foreign namespace names through this route's scan nor
    // receives their authors. The response shape is unchanged ({users,count});
    // the aggregated set simply shrinks with the visible namespace set.
    const namespacesResult = await listNamespacesTool(
      {},
      { principal: getPrincipal(req) },
    );

    if (!namespacesResult.success) {
      res.json({ users: [] });
      return;
    }

    const users = await collectAuthorsForNamespaces(
      namespacesResult.namespaces,
    );
    res.json({ users, count: users.length });
  }),
);

export { router as createUsersRoutes };
export default router;
