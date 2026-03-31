/**
 * SSH Tunnel Module
 *
 * Manages SSH tunnels that forward remote DuckBrain HTTP servers to local Unix sockets.
 * Provides tunnel creation, lifecycle management, and socket file management.
 *
 * Implementation details per D-03, D-04:
 * - Socket naming: ~/.duckbrain/sockets/{name}.sock
 * - Permission 0600 ensures only user can access (security default per D-20)
 * - -N flag keeps SSH connection open without executing remote command
 * - PID stored in sidecar file ~/.duckbrain/sockets/{name}.pid for management
 *
 * Exports:
 * - createTunnel(config) - Creates SSH tunnel with Unix socket forwarding
 * - closeTunnel(socketPath) - Closes tunnel and cleans up
 * - listTunnels() - Lists active tunnels
 */

import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Tunnel configuration
 */
export interface TunnelConfig {
  remoteHost: string;
  localSocketPath: string;
  remotePort: number;
}

/**
 * Active tunnel information
 */
export interface TunnelInfo {
  name: string;
  socketPath: string;
  remoteHost: string;
}

/** Base directory for socket files */
const SOCKETS_DIR = path.join(os.homedir(), '.duckbrain', 'sockets');

/**
 * Ensure the sockets directory exists
 */
function ensureSocketsDir(): void {
  if (!fs.existsSync(SOCKETS_DIR)) {
    fs.mkdirSync(SOCKETS_DIR, { recursive: true });
  }
}

/**
 * Get the PID file path for a given socket path
 */
function getPidPath(socketPath: string): string {
  return socketPath.replace(/\.sock$/, '.pid');
}

/**
 * Get the host info file path for a given socket path
 */
function getHostInfoPath(socketPath: string): string {
  return socketPath.replace(/\.sock$/, '.host');
}

/**
 * Create an SSH tunnel forwarding a remote port to a local Unix socket
 *
 * Spawns: ssh -L {socketPath}:localhost:{remotePort} {remoteHost} -N
 *
 * @param config - Tunnel configuration
 * @returns The local socket path
 * @throws Error if tunnel creation fails
 */
export async function createTunnel(config: TunnelConfig): Promise<string> {
  const { remoteHost, localSocketPath, remotePort } = config;

  // Ensure sockets directory exists
  ensureSocketsDir();

  // Build SSH command: ssh -L /path/to/socket:localhost:port user@host -N
  const sshArgs = [
    '-L', `${localSocketPath}:localhost:${remotePort}`,
    '-N',  // No remote command, just keep connection open
    '-o', 'ConnectTimeout=10',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    remoteHost,
  ];

  // Spawn SSH process
  const sshProcess = spawn('ssh', sshArgs);

  // Handle process events
  sshProcess.on('error', (err) => {
    console.error(`[ssh-tunnel] Process error: ${err.message}`);
  });

  sshProcess.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) {
      console.error(`[ssh-tunnel] ${msg}`);
    }
  });

  // Wait briefly for the tunnel to establish
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      // If we haven't errored in 2s, assume tunnel is up
      resolve();
    }, 2000);

    sshProcess.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`SSH tunnel failed: ${err.message}`));
    });

    // Check for early exit (auth failure, etc.)
    sshProcess.on('exit', (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`SSH tunnel exited with code ${code}`));
      }
    });
  });

  // Set socket permissions to 0600 (user-only)
  // The socket may take a moment to appear after SSH connects
  let retries = 0;
  while (!fs.existsSync(localSocketPath) && retries < 10) {
    await new Promise(r => setTimeout(r, 200));
    retries++;
  }

  if (fs.existsSync(localSocketPath)) {
    spawnSync('chmod', ['600', localSocketPath]);
  }

  // Write PID to sidecar file for management
  const pidPath = getPidPath(localSocketPath);
  fs.writeFileSync(pidPath, sshProcess.pid!.toString());

  // Write host info for listTunnels()
  const hostInfoPath = getHostInfoPath(localSocketPath);
  fs.writeFileSync(hostInfoPath, remoteHost);

  return localSocketPath;
}

/**
 * Close an SSH tunnel by socket path
 *
 * Reads the PID from the sidecar file, kills the SSH process,
 * and removes the socket and PID files.
 *
 * @param socketPath - Path to the Unix socket
 */
export async function closeTunnel(socketPath: string): Promise<void> {
  const pidPath = getPidPath(socketPath);
  const hostInfoPath = getHostInfoPath(socketPath);

  // Read PID from sidecar file
  if (fs.existsSync(pidPath)) {
    const pid = fs.readFileSync(pidPath, 'utf-8').trim();

    if (pid) {
      try {
        // Kill the SSH process
        spawnSync('kill', [pid]);
      } catch {
        // Process may already be dead
      }
    }

    // Remove PID file
    try {
      fs.unlinkSync(pidPath);
    } catch {
      // Ignore cleanup errors
    }
  }

  // Remove socket file
  if (fs.existsSync(socketPath)) {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // Ignore cleanup errors
    }
  }

  // Remove host info file
  if (fs.existsSync(hostInfoPath)) {
    try {
      fs.unlinkSync(hostInfoPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * List all active SSH tunnels
 *
 * Scans ~/.duckbrain/sockets/ for .sock files and returns metadata.
 *
 * @returns Array of active tunnel info
 */
export function listTunnels(): TunnelInfo[] {
  const tunnels: TunnelInfo[] = [];

  if (!fs.existsSync(SOCKETS_DIR)) {
    return tunnels;
  }

  const entries = fs.readdirSync(SOCKETS_DIR);
  const socketFiles = entries.filter(f => f.endsWith('.sock'));

  for (const socketFile of socketFiles) {
    const name = socketFile.replace('.sock', '');
    const socketPath = path.join(SOCKETS_DIR, socketFile);
    const hostInfoPath = getHostInfoPath(socketPath);

    let remoteHost = 'unknown';
    if (fs.existsSync(hostInfoPath)) {
      try {
        remoteHost = fs.readFileSync(hostInfoPath, 'utf-8').trim();
      } catch {
        // Use default
      }
    }

    tunnels.push({
      name,
      socketPath,
      remoteHost,
    });
  }

  return tunnels;
}
