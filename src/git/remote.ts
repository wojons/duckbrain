/**
 * Git Remote Operations for DuckBrain
 *
 * Enables collaborative memory sharing via git push/pull.
 * Auto-merges conflicts using append-only architecture.
 */

import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { getConfig } from '../config/index';
import { autoMerge, logMergeActivity, resolveMergeConflict } from './merge';

/**
 * Remote operation result
 */
interface RemoteResult {
  success: boolean;
  error?: string;
  mergedCount?: number;
  skippedCount?: number;
}

/**
 * Pull from remote repository with auto-merge
 *
 * @param namespace - Namespace to pull from
 * @returns Pull result with merge statistics
 */
export async function pull(namespace?: string): Promise<RemoteResult> {
  try {
    const config = getConfig('.');
    const nsName = namespace || config.defaultNamespace;
    const nsPath = config.namespaceMappings?.[nsName];
    
    if (!nsPath) {
      return {
        success: false,
        error: `Namespace '${nsName}' not found`
      };
    }
    
    // Check if remote is configured
    try {
      execSync('git remote get-url origin', { cwd: nsPath, stdio: 'pipe' });
    } catch {
      return {
        success: false,
        error: 'No remote configured. Use "duckbrain remote add" to configure.'
      };
    }
    
    // Fetch first to check for changes
    execSync('git fetch', { cwd: nsPath, stdio: 'pipe' });
    
    // Check if there's anything to pull
    const status = execSync('git status --porcelain', { 
      cwd: nsPath, 
      encoding: 'utf-8',
      stdio: 'pipe' 
    });
    
    // Pull with no-commit to handle conflicts manually
    try {
      execSync('git pull --no-commit', { cwd: nsPath, stdio: 'pipe' });
    } catch (pullError) {
      // Pull might fail due to conflicts - that's OK, we auto-resolve
      const errorMsg = (pullError as any).stderr?.toString() || '';
      
      if (errorMsg.includes('conflict')) {
        // Conflicts detected - auto-resolve
        console.log('Conflicts detected, auto-resolving...');
      }
    }
    
    // Check for conflict markers
    const filesWithConflicts = findConflictMarkers(nsPath);
    
    if (filesWithConflicts.length > 0) {
      // Auto-resolve each conflicted file
      for (const file of filesWithConflicts) {
        const filePath = path.join(nsPath, file);
        await autoMerge(filePath + '.theirs', filePath);
      }
    }
    
    // Log merge activity
    const conflictsLogPath = path.join(nsPath, 'conflicts.log');
    if (fs.existsSync(conflictsLogPath)) {
      const mergeData = {
        success: true,
        mergedContent: '',
        stats: {
          oursCount: 0,
          theirsCount: 0,
          mergedCount: 0,
          duplicatesSkipped: 0,
          tombstonesHandled: 0
        }
      };
      logMergeActivity(mergeData, nsPath, 'origin');
    }
    
    // Commit the merge if there are changes
    try {
      const hasChanges = execSync('git status --porcelain', {
        cwd: nsPath,
        encoding: 'utf-8',
        stdio: 'pipe'
      }).trim();
      
      if (hasChanges) {
        execSync('git commit -m "Merge from origin"', { cwd: nsPath, stdio: 'pipe' });
      }
    } catch {
      // No changes to commit or merge already committed
    }
    
    return {
      success: true,
      mergedCount: 0,
      skippedCount: 0
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Push to remote repository
 *
 * @param namespace - Namespace to push
 * @returns Push result
 */
export async function push(namespace?: string): Promise<RemoteResult> {
  try {
    const config = getConfig('.');
    const nsName = namespace || config.defaultNamespace;
    const nsPath = config.namespaceMappings?.[nsName];
    
    if (!nsPath) {
      return {
        success: false,
        error: `Namespace '${nsName}' not found`
      };
    }
    
    // Check if remote is configured
    try {
      execSync('git remote get-url origin', { cwd: nsPath, stdio: 'pipe' });
    } catch {
      return {
        success: false,
        error: 'No remote configured. Use "duckbrain remote add" to configure.'
      };
    }
    
    // Push to remote
    execSync('git push', { cwd: nsPath, stdio: 'pipe' });
    
    return {
      success: true
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Add remote to namespace
 *
 * @param namespace - Namespace name
 * @param url - Remote URL
 * @returns Result
 */
export async function addRemote(namespace: string, url: string): Promise<RemoteResult> {
  try {
    const config = getConfig('.');
    const nsPath = config.namespaceMappings?.[namespace];
    
    if (!nsPath) {
      return {
        success: false,
        error: `Namespace '${namespace}' not found`
      };
    }
    
    // Try to add, if exists then update
    try {
      execSync(`git remote add origin ${url}`, { cwd: nsPath, stdio: 'pipe' });
    } catch {
      // Remote might exist - update it
      execSync(`git remote set-url origin ${url}`, { cwd: nsPath, stdio: 'pipe' });
    }
    
    return {
      success: true
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Remove remote from namespace
 *
 * @param namespace - Namespace name
 * @returns Result
 */
export async function removeRemote(namespace: string): Promise<RemoteResult> {
  try {
    const config = getConfig('.');
    const nsPath = config.namespaceMappings?.[namespace];
    
    if (!nsPath) {
      return {
        success: false,
        error: `Namespace '${namespace}' not found`
      };
    }
    
    execSync('git remote remove origin', { cwd: nsPath, stdio: 'pipe' });
    
    return {
      success: true
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Get configured remote URL
 *
 * @param namespace - Namespace name
 * @returns Remote URL or undefined
 */
export async function getRemote(namespace?: string): Promise<string | undefined> {
  try {
    const config = getConfig('.');
    const nsName = namespace || config.defaultNamespace;
    const nsPath = config.namespaceMappings?.[nsName];
    
    if (!nsPath) {
      return undefined;
    }
    
    const url = execSync('git remote get-url origin', {
      cwd: nsPath,
      encoding: 'utf-8',
      stdio: 'pipe'
    }).trim();
    
    return url;
  } catch {
    return undefined;
  }
}

/**
 * Find files with git conflict markers
 *
 * @param repoPath - Repository path
 * @returns Array of conflicted file paths
 */
function findConflictMarkers(repoPath: string): string[] {
  try {
    const status = execSync('git status --porcelain', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: 'pipe'
    });
    
    const conflicted: string[] = [];
    for (const line of status.split('\n')) {
      if (line.includes('U') || line.includes('DU') || line.includes('UD')) {
        const file = line.slice(3).trim();
        if (file) {
          conflicted.push(file);
        }
      }
    }
    
    return conflicted;
  } catch {
    return [];
  }
}

/**
 * MCP tool: Pull memories from remote
 */
export async function pullMemoriesTool(namespace?: string): Promise<RemoteResult> {
  return pull(namespace);
}

/**
 * MCP tool: Push memories to remote
 */
export async function pushMemoriesTool(namespace?: string): Promise<RemoteResult> {
  return push(namespace);
}
