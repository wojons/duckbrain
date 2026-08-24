/**
 * Git Auto-Commit Helper
 *
 * Ensures per-namespace git repos are initialized and data is committed.
 *
 * Commits are BATCHED: each write lands in the working tree (JSONL) immediately,
 * but the git commit itself is debounced (gitBatching.maxSeconds, default 30s)
 * and line-capped (gitBatching.maxLines, default 100). A burst of N writes
 * therefore produces 1 commit, not N — each commit stores the FULL jsonl file
 * as a loose git object, so per-write commits balloon namespace .git repos
 * (85k commits ≈ 490GB of loose objects in the coding-hermes namespace,
 * 2026-08-06; the scheduler fleet-sync alone posts ~157 memories per 5-min
 * cycle). JSONL is the source of truth; git history is best-effort and the
 * next write sweeps up anything a crashed process left uncommitted
 * (git add -A stages everything).
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { getConfig } from "../config";
import { maybeSyncOnCommit } from "../s3";

export interface BatchingParams {
  maxLines: number;
  maxSeconds: number;
  enabled: boolean;
}

const DEFAULT_PARAMS: BatchingParams = {
  maxLines: 100,
  maxSeconds: 30,
  enabled: true,
};

interface PendingCommit {
  timer: NodeJS.Timeout;
  lines: number;
  message: string;
}

const pending = new Map<string, PendingCommit>();

/** Tracks whether the process 'exit' flush hook has been registered. */
let exitFlushRegistered = false;

function batchingParams(): BatchingParams {
  try {
    const cfg = getConfig();
    const gb = cfg.gitBatching as
      { maxLines?: number; maxSeconds?: number; enabled?: boolean } | undefined;
    if (!gb) return DEFAULT_PARAMS;
    return {
      maxLines: gb.maxLines ?? DEFAULT_PARAMS.maxLines,
      maxSeconds: gb.maxSeconds ?? DEFAULT_PARAMS.maxSeconds,
      enabled: gb.enabled ?? DEFAULT_PARAMS.enabled,
    };
  } catch {
    // Config unreadable (wrong cwd, missing file) — fall back to defaults.
    return DEFAULT_PARAMS;
  }
}

/**
 * Perform the actual git add + commit for a namespace repo.
 * Best-effort: failures are logged and swallowed (history only).
 */
function immediateCommit(namespacePath: string, message: string): void {
  try {
    // Init git repo if it doesn't exist
    const gitDir = path.join(namespacePath, ".git");
    if (!fs.existsSync(gitDir)) {
      execSync("git init", { cwd: namespacePath, stdio: "pipe" });
    }

    // Ensure git user identity is set (newly inited repos + pre-existing ones)
    try {
      execSync("git config user.email", { cwd: namespacePath, stdio: "pipe" });
    } catch {
      execSync('git config user.email "duckbrain@localhost.localdomain"', {
        cwd: namespacePath,
        stdio: "pipe",
      });
    }
    try {
      execSync("git config user.name", { cwd: namespacePath, stdio: "pipe" });
    } catch {
      execSync('git config user.name "DuckBrain"', {
        cwd: namespacePath,
        stdio: "pipe",
      });
    }

    // Stage all changes
    execSync("git add -A", { cwd: namespacePath, stdio: "pipe" });

    // Check if there are staged changes — git diff --cached --quiet exits 1 if there are
    try {
      execSync("git diff --cached --quiet", {
        cwd: namespacePath,
        stdio: "pipe",
      });
      // Exit code 0 = no staged changes, nothing to commit
    } catch {
      // Exit code 1 = there ARE staged changes
      execSync(`git commit -m "${message}"`, {
        cwd: namespacePath,
        stdio: "pipe",
      });
    }
    // Native S3 push hook — inert unless s3.enabled && s3.pushOnCommit.
    // Fire-and-forget: never blocks or fails the write path.
    maybeSyncOnCommit(namespacePath);
    // AUTOPUSH-001: push the namespace repo to the s3daily remote after
    // every commit flush (git-remote-s3 → s3://duckbrain/current/git/<ns>).
    // Synchronous + best-effort so short-lived CLI processes (remember →
    // commit → exit in <1s) push without waiting for the 03:47 daily cron.
    pushNamespace(namespacePath);
  } catch (error) {
    // Log but don't fail the tool — git is best-effort
    console.warn(
      `[Git] Auto-commit warning for ${namespacePath}: ${(error as Error).message}`,
    );
  }
}

/**
 * Debounced commit. First write schedules a commit in maxSeconds; writes
 * before the timer fires only bump the line counter. When the counter hits
 * maxLines the commit fires immediately. Every namespace repo has its own
 * independent window.
 */
export function commitNamespaceWithParams(
  namespacePath: string,
  message: string,
  params: BatchingParams,
): void {
  try {
    if (!params.enabled) {
      immediateCommit(namespacePath, message);
      return;
    }

    // DOGFOOD-005: Implicitly-created namespaces (CLI remember / REST POST
    // with no prior create_namespace) have a working dir + files but NO .git.
    // The debounced timer below is timer.unref()'d, so a short-lived CLI
    // process exits before it fires — leaving the namespace without git
    // version control. Force the FIRST write to a namespace to init + commit
    // synchronously (immediateCommit does git init + identity + add + commit).
    // After the repo exists, subsequent writes keep the batching window.
    const gitDir = path.join(namespacePath, ".git");
    if (!fs.existsSync(gitDir)) {
      immediateCommit(namespacePath, message);
      return;
    }

    const existing = pending.get(namespacePath);
    if (existing) {
      existing.lines += 1;
      if (existing.lines >= params.maxLines) {
        clearTimeout(existing.timer);
        pending.delete(namespacePath);
        immediateCommit(namespacePath, message);
      }
      return;
    }

    const timer = setTimeout(() => {
      pending.delete(namespacePath);
      immediateCommit(namespacePath, message);
    }, params.maxSeconds * 1000);
    if (typeof timer.unref === "function") timer.unref(); // don't hold the process open
    pending.set(namespacePath, { timer, lines: 1, message });
  } catch (error) {
    console.warn(
      `[Git] Auto-commit warning for ${namespacePath}: ${(error as Error).message}`,
    );
  }
}

/**
 * Commit a namespace now, flushing any pending debounce window.
 */
export function flushNamespaceCommit(namespacePath: string): void {
  const existing = pending.get(namespacePath);
  if (!existing) return;
  clearTimeout(existing.timer);
  pending.delete(namespacePath);
  immediateCommit(namespacePath, existing.message);
}

/**
 * Flush every pending debounce window (e.g. on graceful shutdown).
 */
export function flushAllCommits(): void {
  for (const namespacePath of [...pending.keys()]) {
    flushNamespaceCommit(namespacePath);
  }
}

/**
 * DOGFOOD-005: Register an exit-time flush so short-lived CLI processes
 * (e.g. `duckbrain remember` which resolves, writes, and exits in <1s) don't
 * lose their data to the 30s unref'd debounce timer. immediateCommit is fully
 * synchronous (execSync), so it is safe inside a process 'exit' handler.
 *
 * Registered exactly once per process and guarded for test environments where
 * this module may be re-imported. The handler itself is a no-op when nothing
 * is pending, so it is cheap to leave wired.
 */
if (
  typeof process !== "undefined" &&
  typeof process.on === "function" &&
  !exitFlushRegistered
) {
  process.on("exit", flushAllCommits);
  exitFlushRegistered = true;
}

/**
 * Initialize git repo if missing, then stage and commit all changes.
 * Uses a lightweight --allow-empty check to skip no-op commits.
 * BATCHED: see module docstring — commits are debounced per namespace.
 *
 * @param namespacePath - Absolute path to namespace directory
 * @param message - Commit message (default: auto-commit)
 */
export function commitNamespace(
  namespacePath: string,
  message: string = "chore: auto-commit namespace data",
): void {
  commitNamespaceWithParams(namespacePath, message, batchingParams());
}

/**
 * Select the remote a namespace repo should be pushed to. Prefers the
 * canonical `s3daily` remote (git-remote-s3, duckbrain profile — the path
 * the daily cron uses), falling back to the first configured remote.
 * Returns null when no remote is configured.
 */
export function selectPushRemote(remotes: string): string | null {
  const list = remotes
    .split(/\s+/)
    .map((r) => r.trim())
    .filter(Boolean);
  if (list.length === 0) return null;
  return list.includes("s3daily") ? "s3daily" : list[0];
}

/**
 * Build the git push command for a namespace repo whose branch has no
 * upstream: push explicitly to the remote and set upstream so later bare
 * `git push` calls resolve too.
 */
export function buildPushCommand(remote: string, branch: string): string {
  return `git push --set-upstream ${remote} ${branch}`;
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
    const remotes = execSync("git remote", {
      cwd: namespacePath,
      stdio: "pipe",
    })
      .toString()
      .trim();
    const remote = selectPushRemote(remotes);
    if (!remote) return;

    // Resolve the current branch. Namespace repos have no upstream (only the
    // s3daily remote), so a bare `git push` would no-op/fail — push
    // explicitly to remote + branch instead.
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: namespacePath,
      stdio: "pipe",
    })
      .toString()
      .trim();
    if (!branch || branch === "HEAD") return;

    execSync(buildPushCommand(remote, branch), {
      cwd: namespacePath,
      stdio: "pipe",
      timeout: 30000,
      // git-remote-s3 needs the duckbrain AWS profile + Hetzner endpoint —
      // the exact env the daily cron (duckbrain-s3-push.sh) exports.
      // Without them the helper dies with "invalid credentials" because
      // neither the daemon nor CLI processes carry AWS vars.
      env: {
        ...process.env,
        AWS_PROFILE: "duckbrain",
        AWS_ENDPOINT_URL: "https://hel1.your-objectstorage.com",
        AWS_DEFAULT_REGION: "us-east-1",
      },
    });
  } catch (error) {
    console.warn(
      `[Git] Push warning for ${namespacePath}: ${(error as Error).message}`,
    );
  }
}
