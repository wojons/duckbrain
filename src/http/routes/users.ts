/**
 * Users API Routes
 *
 * Extracts unique authors from namespace git commit history.
 * Falls back to DuckDB memory queries if git is unavailable.
 */

import { Router, Request, Response } from 'express';
import { execSync } from 'child_process';
import { listNamespacesTool } from '../../mcp/tools/namespace';
import { getDuckDBConnection } from '../../duckdb/connection';
import { asyncHandler } from '../middleware/errorHandler';
import path from 'path';
import fs from 'fs';

const router = Router();

/**
 * Extract unique authors from a git repository using git log.
 * Returns empty array if git is unavailable or repo has no commits.
 */
function getAuthorsFromGit(repoPath: string): string[] {
  try {
    const output = execSync('git log --all --format=%aN', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim();

    if (!output) return [];

    // Split, trim, deduplicate, and filter empty lines
    return [...new Set(
      output.split('\n').map(a => a.trim()).filter(Boolean)
    )];
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
      const db = getDuckDBConnection('singleton', namespacePath);

      // Get all partition paths from manifest
      const manifestPath = path.join(namespacePath, 'manifest.json');
      if (!fs.existsSync(manifestPath)) { resolve([]); return; }

      let manifest: { partitions?: string[] };
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      } catch { resolve([]); return; }

      const partitionPaths: string[] = (manifest.partitions || [])
        .map((p: string) => path.join(namespacePath, p))
        .filter((p: string) => fs.existsSync(p));

      if (partitionPaths.length === 0) { resolve([]); return; }

      // Build file list
      const jsonlFiles: string[] = [];
      for (const pp of partitionPaths) {
        try {
          const files = fs.readdirSync(pp)
            .filter((f: string) => f.endsWith('.jsonl'))
            .map((f: string) => path.join(pp, f).replace(/\\/g, '/'));
          jsonlFiles.push(...files);
        } catch { /* skip inaccessible partitions */ }
      }

      if (jsonlFiles.length === 0) { resolve([]); return; }

      const fileList = jsonlFiles.map((f: string) => `'${f}'`).join(', ');
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
router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const namespacesResult = await listNamespacesTool({});

  if (!namespacesResult.success) {
    res.json({ users: [] });
    return;
  }

  const allAuthors = new Set<string>();

  for (const ns of namespacesResult.namespaces) {
    // Try git log first (commit history approach)
    const gitAuthors = getAuthorsFromGit(ns.path);
    if (gitAuthors.length > 0) {
      for (const author of gitAuthors) {
        allAuthors.add(author);
      }
    } else {
      // Fallback: query DuckDB JSONL files for distinct authors
      const dbAuthors = await getAuthorsFromDb(ns.path);
      for (const author of dbAuthors) {
        allAuthors.add(author);
      }
    }
  }

  const users = [...allAuthors].sort();
  res.json({ users, count: users.length });
}));

export { router as createUsersRoutes };
export default router;
