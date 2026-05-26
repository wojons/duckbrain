/**
 * Git Auto-Commit Helper
 *
 * Ensures per-namespace git repos are initialized and data is committed.
 * Called from MCP tool handlers (remember, forget) after writes.
 *
 * Design: each namespace gets its own git repo. For the default namespace
 * (which shares the parent repo), we init a standalone repo at the namespace
 * path. The parent's .gitignore excludes namespaces/ so there's no conflict.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Initialize git repo if missing, then stage and commit all changes.
 * Uses a lightweight --allow-empty check to skip no-op commits.
 *
 * @param namespacePath - Absolute path to namespace directory
 * @param message - Commit message (default: auto-commit)
 */
export function commitNamespace(
  namespacePath: string,
  message: string = 'chore: auto-commit namespace data'
): void {
  try {
    // Init git repo if it doesn't exist
    const gitDir = path.join(namespacePath, '.git');
    if (!fs.existsSync(gitDir)) {
      execSync('git init', { cwd: namespacePath, stdio: 'pipe' });
    }

    // Ensure git user identity is set (newly inited repos + pre-existing ones)
    try {
      execSync('git config user.email', { cwd: namespacePath, stdio: 'pipe' });
    } catch {
      execSync('git config user.email "duckbrain@localhost"', { cwd: namespacePath, stdio: 'pipe' });
    }
    try {
      execSync('git config user.name', { cwd: namespacePath, stdio: 'pipe' });
    } catch {
      execSync('git config user.name "DuckBrain"', { cwd: namespacePath, stdio: 'pipe' });
    }

    // Stage all changes
    execSync('git add -A', { cwd: namespacePath, stdio: 'pipe' });

    // Check if there are staged changes — git diff --cached --quiet exits 1 if there are
    try {
      execSync('git diff --cached --quiet', { cwd: namespacePath, stdio: 'pipe' });
      // Exit code 0 = no staged changes, nothing to commit
    } catch {
      // Exit code 1 = there ARE staged changes
      execSync(`git commit -m "${message}"`, { cwd: namespacePath, stdio: 'pipe' });
    }
  } catch (error) {
    // Log but don't fail the tool — git is best-effort
    console.warn(
      `[Git] Auto-commit warning for ${namespacePath}: ${(error as Error).message}`
    );
  }
}

/**
 * Push namespace repo to remote if configured.
 * Non-blocking — failures are logged and swallowed.
 *
 * @param namespacePath - Absolute path to namespace directory
 */
export function pushNamespace(namespacePath: string): void {
  try {
    // Check if remote is configured
    const remotes = execSync('git remote', { cwd: namespacePath, stdio: 'pipe' })
      .toString()
      .trim();
    if (!remotes) return;

    execSync('git push', { cwd: namespacePath, stdio: 'pipe', timeout: 30000 });
  } catch (error) {
    console.warn(
      `[Git] Push warning for ${namespacePath}: ${(error as Error).message}`
    );
  }
}
