/**
 * Systemd Service Manager
 *
 * Manages DuckBrain as a systemd service (user or system-wide).
 * Auto-detects if systemd is available, falls back to background process.
 *
 * Usage:
 *   duckbrain service install [--system]  — Install service
 *   duckbrain service start              — Start service
 *   duckbrain service stop               — Stop service
 *   duckbrain service restart            — Restart service
 *   duckbrain service status             — Show status
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Check if systemd is available on this system
 */
function isSystemdAvailable(): boolean {
  try {
    execSync('which systemctl', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the path to the DuckBrain executable
 */
function getExecutablePath(): string {
  // Use the current process executable path
  return process.argv[1] || 'duckbrain';
}

/**
 * Generate systemd service file content
 */
function generateServiceContent(isSystem: boolean): string {
  const execPath = getExecutablePath();
  const user = isSystem ? 'duckbrain' : '%I';
  const target = isSystem ? 'multi-user.target' : 'default.target';

  return `[Unit]
Description=DuckBrain MCP Server
After=network.target

[Service]
Type=simple
User=${user}
ExecStart=${execPath} http --port=3000
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=${target}
`;
}

/**
 * Install DuckBrain as a systemd service
 *
 * @param options - Installation options
 * @param options.system - Install system-wide (requires root)
 * @returns true if installation succeeded
 */
export async function installService(options: { system?: boolean }): Promise<boolean> {
  const isSystem = options.system || false;

  if (isSystem && process.getuid?.() !== 0) {
    console.log('System-wide service requires root privileges.');
    console.log('Run: sudo duckbrain service install --system');
    return false;
  }

  // Check if systemd is available
  if (!isSystemdAvailable()) {
    console.log('systemd not available. Cannot install as a systemd service.');
    console.log('Consider running DuckBrain directly: duckbrain http');
    return false;
  }

  const serviceDir = isSystem
    ? '/etc/systemd/system'
    : path.join(os.homedir(), '.config/systemd/user');

  // Create user service directory if needed
  if (!isSystem) {
    fs.mkdirSync(serviceDir, { recursive: true });
  }

  const servicePath = path.join(serviceDir, 'duckbrain.service');
  const serviceContent = generateServiceContent(isSystem);

  fs.writeFileSync(servicePath, serviceContent, 'utf-8');

  console.log(`Service installed to: ${servicePath}`);
  console.log('');
  console.log('To start the service:');
  if (isSystem) {
    console.log('  sudo systemctl daemon-reload');
    console.log('  sudo systemctl start duckbrain');
    console.log('  sudo systemctl enable duckbrain  # auto-start on boot');
  } else {
    console.log('  systemctl --user daemon-reload');
    console.log('  systemctl --user start duckbrain');
    console.log('  systemctl --user enable duckbrain  # auto-start on login');
  }

  return true;
}

/**
 * Manage the DuckBrain systemd service
 *
 * @param action - Service action to perform
 * @returns true if action succeeded
 */
export async function manageService(
  action: 'start' | 'stop' | 'restart' | 'status'
): Promise<boolean> {
  // Check if systemd is available
  if (!isSystemdAvailable()) {
    console.log('systemd not available.');
    console.log('Falling back to background process management...');
    return manageBackgroundProcess(action);
  }

  const isUser = process.getuid?.() !== 0;
  const userFlag = isUser ? '--user ' : '';

  try {
    if (action === 'status') {
      const result = execSync(`systemctl ${userFlag}status duckbrain`, {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      console.log(result);
      return true;
    }

    // For start/stop/restart, run the systemctl command
    const result = execSync(`systemctl ${userFlag}${action} duckbrain`, {
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    if (result) {
      console.log(result);
    }
    console.log(`Service ${action} completed successfully.`);
    return true;
  } catch (error: any) {
    // systemctl status returns non-zero when service is not running
    if (action === 'status' && error.stdout) {
      console.log(error.stdout);
      return false;
    }

    console.error(`Failed to ${action} service: ${error.message || String(error)}`);
    return false;
  }
}

/**
 * Fallback: manage DuckBrain as a background process (non-systemd systems)
 */
async function manageBackgroundProcess(action: string): Promise<boolean> {
  const pidFile = path.join(os.homedir(), '.duckbrain', 'duckbrain.pid');
  const logFile = path.join(os.homedir(), '.duckbrain', 'duckbrain.log');

  // Ensure .duckbrain directory exists
  const duckbrainDir = path.dirname(pidFile);
  if (!fs.existsSync(duckbrainDir)) {
    fs.mkdirSync(duckbrainDir, { recursive: true });
  }

  switch (action) {
    case 'start': {
      // Check if already running
      if (fs.existsSync(pidFile)) {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim());
        try {
          process.kill(pid, 0); // Check if process exists
          console.log(`DuckBrain is already running (PID: ${pid})`);
          return true;
        } catch {
          // Process not running, clean up stale PID file
          fs.unlinkSync(pidFile);
        }
      }

      // Start in background
      const { spawn } = await import('child_process');
      const execPath = getExecutablePath();
      const child = spawn(process.execPath, [execPath, 'http'], {
        detached: true,
        stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')],
      });

      child.unref();

      fs.writeFileSync(pidFile, child.pid!.toString(), 'utf-8');
      console.log(`DuckBrain started in background (PID: ${child.pid})`);
      console.log(`Log file: ${logFile}`);
      return true;
    }

    case 'stop': {
      if (!fs.existsSync(pidFile)) {
        console.log('DuckBrain is not running (no PID file found)');
        return false;
      }

      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim());
      try {
        process.kill(pid, 'SIGTERM');
        console.log(`Stopped DuckBrain (PID: ${pid})`);
        fs.unlinkSync(pidFile);
        return true;
      } catch {
        console.log(`Process ${pid} not found. Cleaning up PID file.`);
        fs.unlinkSync(pidFile);
        return false;
      }
    }

    case 'restart': {
      await manageBackgroundProcess('stop');
      // Small delay for cleanup
      await new Promise(resolve => setTimeout(resolve, 500));
      return manageBackgroundProcess('start');
    }

    case 'status': {
      if (!fs.existsSync(pidFile)) {
        console.log('DuckBrain is not running (no PID file found)');
        return false;
      }

      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim());
      try {
        process.kill(pid, 0);
        console.log(`DuckBrain is running (PID: ${pid})`);
        return true;
      } catch {
        console.log(`DuckBrain is not running (stale PID file for ${pid})`);
        return false;
      }
    }

    default:
      console.log(`Unknown action: ${action}`);
      return false;
  }
}
