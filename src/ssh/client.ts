/**
 * SSH Client Module
 *
 * Provides SSH connection management, remote DuckBrain installation checking,
 * and remote installation capabilities.
 *
 * Uses native ssh command via child_process for maximum compatibility.
 *
 * Exports:
 * - connectToRemote(config) - Establishes SSH connection
 * - checkRemoteInstall(host) - Checks if DuckBrain is installed remotely
 * - installRemote(host) - Installs DuckBrain on remote server
 * - parseSSHConfig(hostAlias) - Reads ~/.ssh/config for host settings
 */

import { spawnSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * SSH connection configuration
 */
export interface SSHConnectionConfig {
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

/**
 * Remote DuckBrain installation status
 */
export interface RemoteStatus {
  installed: boolean;
  version?: string;
  needsUpdate: boolean;
}

/**
 * Parsed SSH config entry
 */
interface SSHConfigEntry {
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

/** Current DuckBrain version for update comparison */
const CURRENT_VERSION = '1.0.0';

/**
 * Expand tilde in file paths
 */
function expandTilde(filePath: string): string {
  if (filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

/**
 * Parse SSH config file (~/.ssh/config) for a given host alias
 *
 * Supports: HostName, User, Port, IdentityFile directives
 *
 * @param hostAlias - The SSH host alias to look up
 * @returns Parsed config entry or null if not found
 */
export function parseSSHConfig(hostAlias: string): SSHConfigEntry | null {
  const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');

  if (!fs.existsSync(sshConfigPath)) {
    return null;
  }

  const configContent = fs.readFileSync(sshConfigPath, 'utf-8');
  const lines = configContent.split('\n');

  let inTargetBlock = false;
  const entry: Partial<SSHConfigEntry> = {};

  for (const line of lines) {
    const trimmed = line.trim();

    // Check for Host directive
    if (trimmed.startsWith('Host ')) {
      // If we were in the target block, we're done
      if (inTargetBlock) {
        break;
      }

      const hosts = trimmed.slice(5).trim().split(/\s+/);
      if (hosts.includes(hostAlias)) {
        inTargetBlock = true;
        entry.host = hostAlias;
      }
      continue;
    }

    if (!inTargetBlock) continue;

    // Parse directives within the host block
    const match = trimmed.match(/^(\S+)\s+(.+)$/);
    if (match) {
      const [, key, value] = match;
      switch (key.toLowerCase()) {
        case 'hostname':
          entry.host = value;
          break;
        case 'user':
          entry.user = value;
          break;
        case 'port':
          entry.port = parseInt(value, 10);
          break;
        case 'identityfile':
          entry.identityFile = expandTilde(value);
          break;
      }
    }
  }

  if (!inTargetBlock) {
    return null;
  }

  return entry as SSHConfigEntry;
}

/**
 * Parse a host string into user and hostname components
 *
 * @param host - Host string in format [user@]hostname
 * @returns Object with user and hostname
 */
function parseHostString(host: string): { user?: string; hostname: string } {
  const atIndex = host.indexOf('@');
  if (atIndex > 0) {
    return {
      user: host.slice(0, atIndex),
      hostname: host.slice(atIndex + 1),
    };
  }
  return { hostname: host };
}

/**
 * Build SSH arguments array from connection config
 *
 * @param config - SSH connection configuration
 * @param command - Optional remote command to execute
 * @returns Array of SSH arguments
 */
function buildSSHArgs(config: SSHConnectionConfig, command?: string): string[] {
  const args: string[] = [];

  // Check if host is an alias in SSH config
  const sshConfig = parseSSHConfig(config.host);
  const parsed = parseHostString(config.host);

  // Port
  const port = config.port || sshConfig?.port;
  if (port) {
    args.push('-p', port.toString());
  }

  // Identity file
  const identityFile = config.identityFile || sshConfig?.identityFile;
  if (identityFile) {
    args.push('-i', expandTilde(identityFile));
  }

  // Connection timeout
  args.push('-o', 'ConnectTimeout=10');
  args.push('-o', 'StrictHostKeyChecking=accept-new');

  // Build destination [user@]hostname
  const user = config.user || sshConfig?.user || parsed.user;
  const hostname = sshConfig?.host || parsed.hostname;
  const destination = user ? `${user}@${hostname}` : hostname;
  args.push(destination);

  // Remote command
  if (command) {
    args.push(command);
  }

  return args;
}

/**
 * Establish SSH connection to remote server
 *
 * Tests connectivity by running a simple command (echo) on the remote.
 *
 * @param config - SSH connection configuration
 * @returns true if connection succeeded, false otherwise
 */
export async function connectToRemote(config: SSHConnectionConfig): Promise<boolean> {
  const args = buildSSHArgs(config, 'echo connected');

  try {
    const result = spawnSync('ssh', args, {
      timeout: 15000,
      encoding: 'utf-8',
    });

    if (result.status === 0) {
      return true;
    }

    if (result.stderr) {
      const errMsg = typeof result.stderr === 'string' 
        ? result.stderr.trim() 
        : String(result.stderr).trim();
      console.error(`[ssh] Connection error: ${errMsg}`);
    }
    return false;
  } catch (error) {
    console.error('[ssh] Failed to connect:', error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * Check if DuckBrain is installed on the remote server
 *
 * Runs "which duckbrain" and "duckbrain --version" remotely.
 *
 * @param host - Remote host in format [user@]hostname
 * @returns Installation status with version info
 */
export async function checkRemoteInstall(host: string): Promise<RemoteStatus> {
  const config: SSHConnectionConfig = { host };

  try {
    // Check if duckbrain binary exists
    const whichArgs = buildSSHArgs(config, 'which duckbrain');
    const whichResult = spawnSync('ssh', whichArgs, {
      timeout: 10000,
      encoding: 'utf-8',
    });

    if (whichResult.status !== 0) {
      return { installed: false, needsUpdate: false };
    }

    // Get version
    const versionArgs = buildSSHArgs(config, 'duckbrain --version');
    const versionResult = spawnSync('ssh', versionArgs, {
      timeout: 10000,
      encoding: 'utf-8',
    });

    if (versionResult.status !== 0) {
      return { installed: true, needsUpdate: false };
    }

    // Parse version from output like "duckbrain v1.0.0" or "1.0.0"
    const versionOutput = String(versionResult.stdout).trim();
    const versionMatch = versionOutput.match(/(\d+\.\d+\.\d+)/);
    const version = versionMatch ? versionMatch[1] : versionOutput.replace(/^duckbrain\s+v?/, '');

    // Check if update is needed
    const needsUpdate = compareVersions(version, CURRENT_VERSION) < 0;

    return {
      installed: true,
      version,
      needsUpdate,
    };
  } catch (error) {
    console.error('[ssh] Install check failed:', error instanceof Error ? error.message : error);
    return { installed: false, needsUpdate: false };
  }
}

/**
 * Install DuckBrain on remote server
 *
 * Prefers user-space installation (~/.local/bin) to avoid needing sudo.
 * If user-space install fails, prints sudo command for user to run manually (D-21).
 *
 * @param host - Remote host in format [user@]hostname
 * @returns true if installation succeeded, false otherwise
 */
export async function installRemote(host: string): Promise<boolean> {
  const config: SSHConnectionConfig = { host };

  try {
    // Try user-space installation first (~/.local/bin)
    const installCmd = [
      'mkdir -p ~/.local/bin',
      '&& curl -fsSL https://github.com/wojons/duckbrain/releases/latest/download/duckbrain-linux-x64 -o ~/.local/bin/duckbrain',
      '&& chmod +x ~/.local/bin/duckbrain',
      '&& echo "export PATH=~/.local/bin:\\$PATH" >> ~/.bashrc',
      '&& echo "installed"',
    ].join(' ');

    const args = buildSSHArgs(config, installCmd);
    const result = spawnSync('ssh', args, {
      timeout: 60000,
      encoding: 'utf-8',
    });

    if (result.status === 0 && result.stdout.includes('installed')) {
      return true;
    }

    // User-space install failed — print sudo command (D-21: never auto-escalate)
    console.error('');
    console.error('User-space installation failed. Run manually with sudo:');
    console.error(`  ssh ${host} "sudo npm install -g duckbrain"`);
    console.error('  OR:');
    console.error(`  ssh ${host} "sudo curl -fsSL https://github.com/wojons/duckbrain/releases/latest/download/duckbrain-linux-x64 -o /usr/local/bin/duckbrain && sudo chmod +x /usr/local/bin/duckbrain"`);
    return false;
  } catch (error) {
    console.error('[ssh] Install failed:', error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * Compare two semantic version strings
 *
 * @returns negative if a < b, 0 if equal, positive if a > b
 */
function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const partA = partsA[i] || 0;
    const partB = partsB[i] || 0;
    if (partA !== partB) {
      return partA - partB;
    }
  }

  return 0;
}
