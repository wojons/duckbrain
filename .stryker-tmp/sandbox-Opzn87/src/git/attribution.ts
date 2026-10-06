/**
 * Git Attribution for DuckBrain
 *
 * Retrieves author information from git config for attributing memory writes.
 * Falls back to environment variables or defaults if git config not set.
 */
// @ts-nocheck


import { execSync } from "child_process";
import { z } from "zod";

/**
 * Author information
 */
export interface AuthorInfo {
  email: string;
  name: string;
}

/**
 * The same email shape MemorySchema enforces on `author`
 * (`author: z.string().email()`, zod v4). Shared by import so the fallback
 * layer and the validator can never drift apart.
 */
const EmailSchema = z.string().email();

/**
 * Whether an email candidate is usable as a memory author
 *
 * DF-0930-01: bare-host git identities such as `dogfood@localhost` or
 * `root@box` are non-empty strings but fail the schema's email validation
 * (zod requires a dot in the domain part), which turned every memory write
 * on such hosts into HTTP 500 "Memory validation failed: Invalid email
 * address". A candidate the schema would reject is treated as unset.
 */
function isEmailSchemaUsable(value: string): boolean {
  return EmailSchema.safeParse(value).success;
}

/**
 * Get git config value
 * Falls back to environment variable or default
 *
 * @param isUsable - Optional predicate a candidate must satisfy to be used
 *   (applied to both the git value and the env fallback). A candidate that
 *   fails it is skipped, as if unset, and resolution continues to the next
 *   source. Callers resolving non-email keys (e.g. user.name) omit it.
 */
function getGitConfig(
  key: string,
  envVar: string,
  defaultValue: string,
  isUsable?: (value: string) => boolean,
): string {
  try {
    const value = execSync(`git config ${key}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).trim();

    if (value && (!isUsable || isUsable(value))) {
      return value;
    }
  } catch {
    // Git not available or config not set
  }

  // Fall back to environment variable
  const envValue = process.env[envVar];
  if (envValue && (!isUsable || isUsable(envValue))) {
    return envValue;
  }

  // Fall back to default
  return defaultValue;
}

/**
 * Get author email from git config or environment
 *
 * A git-config or env email that would fail the schema's email validation
 * (e.g. a bare-host `user.email` like `dogfood@localhost` with no dot in the
 * domain) is skipped, so the TLD-valid default is returned instead — the
 * strict schema never sees an invalid author.
 *
 * @returns Author email address
 */
export function getAuthorEmail(): string {
  return getGitConfig(
    "user.email",
    "GIT_AUTHOR_EMAIL",
    "duckbrain@localhost.localdomain",
    isEmailSchemaUsable,
  );
}

/**
 * Get author name from git config or environment
 *
 * @returns Author name
 */
export function getAuthorName(): string {
  return getGitConfig("user.name", "GIT_AUTHOR_NAME", "DuckBrain User");
}

/**
 * Get complete author information
 *
 * @returns Author info with email and name
 */
export function getAuthor(): AuthorInfo {
  return {
    email: getAuthorEmail(),
    name: getAuthorName(),
  };
}
