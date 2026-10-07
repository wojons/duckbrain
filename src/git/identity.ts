/**
 * GIT-IDENTITY-001 — single source of truth for git identity resolution.
 *
 * Historically autocommit.ts and attribution.ts each INVENTED a synthetic
 * identity (`DuckBrain` / `duckbrain at localhost`) whenever a git
 * config read failed, and wrote it into the per-namespace repo's LOCAL config.
 * Local config outranks global, so the pin was permanent and commits were
 * attributed to a fabricated author that disagreed with the user's real
 * identity (and, on some hosts, with a Zod-invalid email).
 *
 * The new contract: identity is RESOLVED through one ordered chain and never
 * written by the commit path:
 *
 *   1. repo-local git config (per-namespace repo)
 *   2. global git config
 *   3. documented env override (DUCKBRAIN_GIT_AUTHOR_NAME / DUCKBRAIN_GIT_AUTHOR_EMAIL)
 *
 * If nothing resolves, callers FAIL LOUDLY with an actionable error — a
 * fabricated identity never reaches a repo config, a commit, or a memory row.
 */

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

export const DUCKBRAIN_GIT_AUTHOR_NAME_ENV = "DUCKBRAIN_GIT_AUTHOR_NAME";
export const DUCKBRAIN_GIT_AUTHOR_EMAIL_ENV = "DUCKBRAIN_GIT_AUTHOR_EMAIL";

export interface GitIdentity {
  name: string;
  email: string;
}

export type GitIdentitySource =
  | "repo-local"
  | "global"
  | "env"
  | "none";

export interface ResolvedGitIdentity {
  identity: GitIdentity | null;
  source: GitIdentitySource;
  /** Actionable setup hint when identity === null. */
  error?: string;
}

/** Zod-valid-email shape (same rule as attribution's schema guard: a dot in the domain). */
function isPlausibleEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isNonEmpty(value: string | undefined | null): value is string {
  return value !== undefined && value !== null && value.trim().length > 0;
}

/**
 * Read a git config key. Returns the raw value or null.
 *
 * scope "local" reads the repo at cwd only (-C cwd --local), scope "global"
 * reads --global. execFileSync (not execSync) so values are never
 * shell-interpolated, and stdio "pipe" so a missing key is silent.
 */
function readGitConfig(
  key: string,
  cwd: string | undefined,
  scope: "local" | "global",
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  try {
    const args: string[] = ["config", `--${scope}`];
    if (cwd) args.unshift("-C", cwd);
    args.push(key);
    const value = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
      env,
    }).trim();
    return isNonEmpty(value) ? value : null;
  } catch {
    // Unset in this scope, git unavailable, or cwd not a repo — treat as unset.
    return null;
  }
}

function readEnv(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  return isNonEmpty(value) ? value.trim() : null;
}

const SYNTHETIC_NAME = "DuckBrain";
export const SYNTHETIC_LOCAL_IDENTITY = {
  name: SYNTHETIC_NAME,
  email: "duckbrain" + "@localhost" + ".localdomain",
} as const;

/** Does this name/email pair match the historical synthetic pin? */
export function isSyntheticIdentity(name: string | null, email: string | null): boolean {
  const nameMatch = isNonEmpty(name) && name.trim() === SYNTHETIC_NAME;
  const emailMatch =
    isNonEmpty(email) && /^duckbrain[@]localhost/i.test(email.trim());
  // The pin is only "synthetic" when it carries BOTH the fabricated name and
  // the fabricated email — a user who legitimately configured a DIFFERENT
  // name alongside a localhost email (or vice versa) must not be wiped.
  return nameMatch && emailMatch;
}

/**
 * Resolve the git author identity. Pure (git reads + env); never WRITES any
 * config. Order: repo-local -> global -> documented env override.
 *
 * Returns { identity, source } on success, or { identity: null, source:
 * "none", error } with an actionable setup hint when nothing resolves.
 */
export function resolveGitIdentity(
  repoPath?: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedGitIdentity {
  const nameLocal = repoPath
    ? readGitConfig("user.name", repoPath, "local", env)
    : null;
  const emailLocal = repoPath
    ? readGitConfig("user.email", repoPath, "local", env)
    : null;
  if (isNonEmpty(nameLocal) && isNonEmpty(emailLocal)) {
    return { identity: { name: nameLocal.trim(), email: emailLocal.trim() }, source: "repo-local" };
  }

  const nameGlobal = readGitConfig("user.name", undefined, "global", env);
  const emailGlobal = readGitConfig("user.email", undefined, "global", env);
  if (isNonEmpty(nameGlobal) && isNonEmpty(emailGlobal)) {
    return { identity: { name: nameGlobal.trim(), email: emailGlobal.trim() }, source: "global" };
  }

  const nameEnv = readEnv(env, DUCKBRAIN_GIT_AUTHOR_NAME_ENV);
  const emailEnv = readEnv(env, DUCKBRAIN_GIT_AUTHOR_EMAIL_ENV);
  if (isNonEmpty(nameEnv) && isNonEmpty(emailEnv)) {
    return { identity: { name: nameEnv, email: emailEnv }, source: "env" };
  }

  return {
    identity: null,
    source: "none",
    error: buildSetupHint(),
  };
}

/**
 * Resolve the git author identity for a namespace repo, THROWING a loud,
 * actionable error when nothing resolves. This is the single resolution
 * point for the commit path and the memory-row author fallback.
 */
export function requireGitIdentity(repoPath: string): GitIdentity {
  const resolved = resolveGitIdentity(repoPath);
  if (resolved.identity) return resolved.identity;
  throw new Error(resolved.error ?? buildSetupHint());
}

/**
 * Resolve ONLY the author email for memory-row attribution (DF-0930-01).
 *
 * Same ordered chain as resolveGitIdentity, but a partially-configured
 * identity (e.g. user.name set, user.email unset) still resolves the email
 * side independently; a candidate email that is empty, whitespace, or not a
 * plausible TLD-bearing email is treated as unset. THROWS when nothing
 * resolves — no synthetic fallback pair exists anymore.
 */
export function resolveAuthorEmail(
  repoPath?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const local = repoPath ? readGitConfig("user.email", repoPath, "local") : null;
  if (isNonEmpty(local) && isPlausibleEmail(local.trim())) return local.trim();
  const global = readGitConfig("user.email", undefined, "global");
  if (isNonEmpty(global) && isPlausibleEmail(global.trim())) return global.trim();
  const envValue = readEnv(env, DUCKBRAIN_GIT_AUTHOR_EMAIL_ENV);
  if (envValue && isPlausibleEmail(envValue)) return envValue;
  throw new Error(buildSetupHint());
}

/**
 * Resolve ONLY the author name for memory-row attribution. Same chain, same
 * no-fallback contract; throws when nothing resolves.
 */
export function resolveAuthorName(
  repoPath?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const local = repoPath ? readGitConfig("user.name", repoPath, "local") : null;
  if (isNonEmpty(local)) return local.trim();
  const global = readGitConfig("user.name", undefined, "global");
  if (isNonEmpty(global)) return global.trim();
  const envValue = readEnv(env, DUCKBRAIN_GIT_AUTHOR_NAME_ENV);
  if (envValue) return envValue;
  throw new Error(buildSetupHint());
}

export function buildSetupHint(): string {
  return (
    "No git author identity is configured. DuckBrain refuses to invent one " +
    "(GIT-IDENTITY-001: a synthetic 'DuckBrain <duckbrain at localhost>' pin used to be " +
    "written into every namespace repo). Fix it with ONE of:\n" +
    "  git config --global user.name \"Your Name\"\n" +
    "  git config --global user.email \"you@example.com\"\n" +
    `  (or per-namespace: git -C <namespace repo> config user.name/user.email)\n` +
    `  (or env: ${DUCKBRAIN_GIT_AUTHOR_NAME_ENV} / ${DUCKBRAIN_GIT_AUTHOR_EMAIL_ENV})`
  );
}

/**
 * GIT-IDENTITY-001 — doctor-style check.
 *
 * DuckBrain has no dedicated doctor surface, so this exported helper fills
 * that role for the identity dimension: it reports whether the host currently
 * resolves a REAL (non-synthetic) git identity, and flags any synthetic
 * local pins still present in the namespaces root. Pure reads — it never
 * writes config. Call repairNamespaceGitIdentities() (or the `duckbrain git
 * repair-identity` CLI command) to clean flagged pins.
 */
export function checkGitIdentityHealth(
  namespacesPath?: string,
): {
  ok: boolean;
  resolvedIdentity: GitIdentity | null;
  syntheticPins: string[];
  message: string;
} {
  const resolved = resolveGitIdentity();
  if (
    resolved.identity &&
    isSyntheticIdentity(resolved.identity.name, resolved.identity.email)
  ) {
    return {
      ok: false,
      resolvedIdentity: resolved.identity,
      syntheticPins: [],
      message:
        "The active git identity is the synthetic DuckBrain pair — configure a real " +
        "user.name/user.email. " +
        buildSetupHint(),
    };
  }

  const syntheticPins: string[] = [];
  if (namespacesPath) {
    try {
      const dirs = fs
        .readdirSync(namespacesPath, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(namespacesPath, d.name));
      for (const repoPath of dirs) {
        if (!fs.existsSync(path.join(repoPath, ".git"))) continue;
        const name = readGitConfig("user.name", repoPath, "local");
        const email = readGitConfig("user.email", repoPath, "local");
        if (isSyntheticIdentity(name, email)) {
          syntheticPins.push(path.basename(repoPath));
        }
      }
    } catch {
      // Unreadable namespaces root: the identity check still stands; the pin
      // scan is skipped rather than masking the identity verdict.
    }
  }

  if (!resolved.identity) {
    return {
      ok: false,
      resolvedIdentity: null,
      syntheticPins,
      message: resolved.error ?? buildSetupHint(),
    };
  }

  return {
    ok: syntheticPins.length === 0,
    resolvedIdentity: resolved.identity,
    syntheticPins,
    message:
      syntheticPins.length === 0
        ? `git identity OK (${resolved.source}): ${resolved.identity.name} <${resolved.identity.email}>`
        : `git identity OK (${resolved.source}), but ${syntheticPins.length} namespace repo(s) still carry synthetic local pins: ${syntheticPins.join(", ")} — run 'duckbrain git repair-identity'`,
  };
}

/**
 * GIT-IDENTITY-001 — remove ONLY the synthetic local identity pins.
 *
 * Scans the namespaces root one level deep (each subdirectory is treated as a
 * namespace repo candidate), reads its LOCAL user.name / user.email, and
 * unsets both keys when they carry the historical synthetic pair
 * (`DuckBrain` / `duckbrain at localhost*`). Nothing else is touched: global
 * config, non-synthetic local values, repo history, and working trees are
 * left alone. Idempotent by construction — a second run finds no synthetic
 * pins and changes nothing.
 */
export function repairNamespaceGitIdentities(namespacesPath: string): {
  scanned: string[];
  repaired: string[];
} {
  const scanned: string[] = [];
  const repaired: string[] = [];

  let entries: string[];
  try {
    entries = fs
      .readdirSync(namespacesPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(namespacesPath, d.name));
  } catch (error) {
    throw new Error(
      `Cannot read namespaces root ${namespacesPath}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  for (const repoPath of entries) {
    scanned.push(path.basename(repoPath));
    if (!fs.existsSync(path.join(repoPath, ".git"))) continue;

    const name = readGitConfig("user.name", repoPath, "local");
    const email = readGitConfig("user.email", repoPath, "local");
    if (!isSyntheticIdentity(name, email)) continue;

    for (const key of ["user.email", "user.name"]) {
      try {
        execFileSync("git", ["-C", repoPath, "config", "--local", "--unset", key], {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 5000,
        });
      } catch (error) {
        // --unset exits 5 when the key is already gone (concurrent repair or
        // a partial previous run); any other failure is a real error.
        const code =
          typeof error === "object" && error !== null && "status" in error
            ? (error as { status?: number }).status
            : undefined;
        if (code !== 5) {
          throw new Error(
            `Failed to unset ${key} in ${repoPath}: ` +
              (error instanceof Error ? error.message : String(error)),
          );
        }
      }
    }
    repaired.push(path.basename(repoPath));
  }

  return { scanned, repaired };
}
