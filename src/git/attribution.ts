/**
 * Git Attribution for DuckBrain
 *
 * Retrieves author information from git config for attributing memory writes.
 * GIT-IDENTITY-001: the resolution chain (repo-local -> global -> documented
 * env override) lives in ./identity.ts and there is NO synthetic fallback —
 * when nothing is configured the resolvers THROW with an actionable setup
 * hint instead of silently attributing rows to 'DuckBrain
 * <duckbrain at localhost…>'.
 */

import { z } from "zod";
import {
  DUCKBRAIN_GIT_AUTHOR_EMAIL_ENV,
  resolveAuthorEmail as resolveEmail,
  resolveAuthorName as resolveName,
} from "./identity";

/**
 * Author information
 */
export interface AuthorInfo {
  email: string;
  name: string;
}

/**
 * The same email shape MemorySchema enforces on `author`
 * (`author: z.string().email()`, zod v4). resolveAuthorEmail() only returns
 * candidates it has already screened against a TLD-bearing-email rule; this
 * re-validation at the attribution boundary keeps the strict schema guarantee
 * explicit (a candidate the schema would reject is never returned).
 */
const EmailSchema = z.string().email();

/**
 * Get author email from git config (repo-local -> global) or the documented
 * env override.
 *
 * DF-0930-01: bare-host git identities such as `dogfood@localhost` or
 * `root@box` fail the schema's email validation (zod requires a dot in the
 * domain part); they are treated as unset.
 *
 * GIT-IDENTITY-001: throws an actionable error when nothing resolves — the
 * synthetic default pair is gone.
 *
 * @returns Author email address
 */
export function getAuthorEmail(): string {
  const email = resolveEmail();
  if (!EmailSchema.safeParse(email).success) {
    // resolveAuthorEmail's screen and the schema disagree — never possible
    // with the current rules, but fail loud rather than poison a memory row.
    throw new Error(
      `Resolved author email "${email}" does not pass the memory schema's ` +
        `email validation (${DUCKBRAIN_GIT_AUTHOR_EMAIL_ENV} or git user.email).`,
    );
  }
  return email;
}

/**
 * Get author name from git config (repo-local -> global) or the documented
 * env override.
 *
 * GIT-IDENTITY-001: throws an actionable error when nothing resolves.
 *
 * @returns Author name
 */
export function getAuthorName(): string {
  return resolveName();
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
