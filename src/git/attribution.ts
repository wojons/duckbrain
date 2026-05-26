/**
 * Git Attribution for DuckBrain
 *
 * Retrieves author information from git config for attributing memory writes.
 * Falls back to environment variables or defaults if git config not set.
 */

import { execSync } from 'child_process';

/**
 * Author information
 */
export interface AuthorInfo {
  email: string;
  name: string;
}

/**
 * Get git config value
 * Falls back to environment variable or default
 */
function getGitConfig(key: string, envVar: string, defaultValue: string): string {
  try {
    const value = execSync(`git config ${key}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000
    }).trim();
    
    if (value) {
      return value;
    }
  } catch {
    // Git not available or config not set
  }
  
  // Fall back to environment variable
  const envValue = process.env[envVar];
  if (envValue) {
    return envValue;
  }
  
  // Fall back to default
  return defaultValue;
}

/**
 * Get author email from git config or environment
 *
 * @returns Author email address
 */
export function getAuthorEmail(): string {
  return getGitConfig('user.email', 'GIT_AUTHOR_EMAIL', 'duckbrain@localhost');
}

/**
 * Get author name from git config or environment
 *
 * @returns Author name
 */
export function getAuthorName(): string {
  return getGitConfig('user.name', 'GIT_AUTHOR_NAME', 'DuckBrain User');
}

/**
 * Get complete author information
 *
 * @returns Author info with email and name
 */
export function getAuthor(): AuthorInfo {
  return {
    email: getAuthorEmail(),
    name: getAuthorName()
  };
}
