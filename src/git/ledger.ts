/**
 * Generic committed-ledger git reader (DB-SUPA-5).
 *
 * The realtime change feed reads committed namespace history — never the
 * working tree, never a checkout, never `manifest.json`. This generalizes the
 * ref-resolution + no-checkout read pattern proved by `src/git/asof.ts`
 * (`git show <ref>:<path>`, `git ls-tree`) into the operations the feed needs:
 * HEAD observation, first-parent traversal, tree discovery under an arbitrary
 * committed directory, and byte-exact blob reads.
 *
 * Every function runs `git` with `cwd = namespaceRepoDir` (DuckBrain keeps one
 * git repo per namespace) and writes nothing: no checkout, no index mutation,
 * no worktree.
 */

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export class GitLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitLedgerError";
  }
}

function runGit(
  repoDir: string,
  args: string[],
  encoding: "utf-8" | "buffer",
): string | Buffer {
  return execFileSync("git", args, {
    cwd: repoDir,
    encoding: encoding === "utf-8" ? "utf-8" : undefined,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: GIT_MAX_BUFFER,
  }) as string | Buffer;
}

/** Run git and return stdout; throws GitLedgerError on any failure. */
export function gitText(repoDir: string, args: string[]): string {
  try {
    return (runGit(repoDir, args, "utf-8") as string).trim();
  } catch (error) {
    throw new GitLedgerError(
      `git ${args.join(" ")} failed in ${repoDir}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Run git and return trimmed stdout, or null when the command fails. */
export function gitTry(repoDir: string, args: string[]): string | null {
  try {
    const out = (runGit(repoDir, args, "utf-8") as string).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/** Run git and return raw stdout bytes; throws GitLedgerError on failure. */
export function gitBytes(repoDir: string, args: string[]): Buffer {
  try {
    return runGit(repoDir, args, "buffer") as Buffer;
  } catch (error) {
    throw new GitLedgerError(
      `git ${args.join(" ")} failed in ${repoDir}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function isGitRepository(repoDir: string): boolean {
  if (!fs.existsSync(path.join(repoDir, ".git"))) return false;
  return gitTry(repoDir, ["rev-parse", "--git-dir"]) !== null;
}

/**
 * The namespace's current first-parent HEAD, or null when the namespace has
 * no repository or no commits yet. A namespace that has never been committed
 * simply has no committed position to publish.
 */
export function resolveHeadSha(repoDir: string): string | null {
  if (!isGitRepository(repoDir)) return null;
  return gitTry(repoDir, ["rev-parse", "--verify", "HEAD^{commit}"]);
}

/** Full 40-hex commit SHA for a ref, or null when it does not exist. */
export function resolveCommitSha(repoDir: string, ref: string): string | null {
  return gitTry(repoDir, ["rev-parse", "--verify", `${ref}^{commit}`]);
}

/** Whether a commit object exists in the repository at all. */
export function commitExists(repoDir: string, sha: string): boolean {
  if (!/^[0-9a-f]{40}$/.test(sha)) return false;
  return gitTry(repoDir, ["cat-file", "-e", `${sha}^{commit}`]) !== null;
}

/** Commit time of a commit as strict ISO-8601 (e.g. 2026-09-16T10:00:00-05:00). */
export function commitTimeIso(repoDir: string, sha: string): string {
  return gitText(repoDir, ["show", "-s", "--format=%cI", sha]);
}

/** First parent of a commit (null for a root commit or missing object). */
export function firstParentOf(repoDir: string, sha: string): string | null {
  return gitTry(repoDir, ["rev-parse", "--verify", `${sha}^1^{commit}`]);
}

/** Whether `ancestor` is reachable from `descendant` (any parent chain). */
export function isAncestor(
  repoDir: string,
  ancestor: string,
  descendant: string,
): boolean {
  try {
    runGit(repoDir, ["merge-base", "--is-ancestor", ancestor, descendant], "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * The retained first-parent window of a namespace: `limit` newest first-parent
 * commits ending at `head`, newest first. A cursor whose commit is not in this
 * window is older than the configured retained history.
 */
export function firstParentWindow(
  repoDir: string,
  head: string,
  limit: number,
): string[] {
  const raw = gitTry(repoDir, [
    "rev-list",
    "--first-parent",
    `--max-count=${limit}`,
    head,
  ]);
  if (raw === null) return [];
  return raw.split("\n").filter((line) => line.trim() !== "");
}

/**
 * First-parent commits strictly after `anchor` through `head`, oldest first.
 * With a null anchor (a repository whose HEAD did not exist yet) every
 * first-parent commit is returned — at that point the caller knows the
 * namespace had no committed history before.
 */
export function firstParentCommitsAfter(
  repoDir: string,
  anchor: string | null,
  head: string,
): string[] {
  const raw = gitTry(repoDir, [
    "rev-list",
    "--first-parent",
    "--reverse",
    anchor === null ? head : `${anchor}..${head}`,
  ]);
  if (raw === null) return [];
  return raw.split("\n").filter((line) => line.trim() !== "");
}

export interface TreeEntry {
  /** Repo-relative path (`_audit/current.jsonl`). */
  path: string;
  /** Blob object id. */
  sha: string;
}

/**
 * Every file committed under `dir` at `ref`, recursively. Returns an empty
 * list when the directory does not exist at that ref (a namespace that has
 * never written an audit row). Paths are repo-relative and POSIX-separated.
 */
export function readTreeEntries(
  repoDir: string,
  ref: string,
  dir: string,
): TreeEntry[] {
  const prefix = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  let raw: string;
  try {
    raw = (runGit(repoDir, ["ls-tree", "-r", "-z", ref, "--", prefix], "utf-8") as string);
  } catch {
    return [];
  }
  const entries: TreeEntry[] = [];
  for (const chunk of raw.split("\u0000")) {
    if (chunk === "") continue;
    // `<mode> SP <type> SP <sha> TAB <path>`
    const tab = chunk.indexOf("\t");
    if (tab < 0) continue;
    const meta = chunk.slice(0, tab).split(/\s+/);
    const filePath = chunk.slice(tab + 1);
    if (meta.length < 3) continue;
    if (meta[1] !== "blob") continue;
    if (!filePath.startsWith(prefix + "/")) continue;
    entries.push({ path: filePath, sha: meta[2] });
  }
  return entries;
}

/** Raw bytes of a blob object. */
export function readBlobBytes(repoDir: string, blobSha: string): Buffer {
  return gitBytes(repoDir, ["cat-file", "blob", blobSha]);
}

/** Raw bytes of a committed path, or null when it is absent at that ref. */
export function readPathBytes(
  repoDir: string,
  ref: string,
  filePath: string,
): Buffer | null {
  try {
    return gitBytes(repoDir, ["show", `${ref}:${filePath}`]);
  } catch {
    return null;
  }
}
