/**
 * Tests for SSH client module
 *
 * Tests SSH config parsing, remote install checking, and installation.
 * Uses mocked child_process to avoid real SSH connections.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';

// Mock child_process - implementation uses spawnSync for all SSH calls
vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

// Mock fs for SSH config reading - preserve actual fs for most ops
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn(),
      existsSync: vi.fn(),
      mkdirSync: vi.fn(),
    },
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import {
  SSHConnectionConfig,
  connectToRemote,
  checkRemoteInstall,
  installRemote,
  parseSSHConfig,
} from './client';

/** Helper to create a successful spawnSync result */
function mockSpawnSuccess(stdout: string = '') {
  return {
    status: 0,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(''),
    pid: 12345,
    output: [null, Buffer.from(stdout), Buffer.from('')] as (Buffer | null)[],
    signal: null as string | null,
  };
}

/** Helper to create a failed spawnSync result */
function mockSpawnFailure(stderr: string = 'error') {
  return {
    status: 1,
    stdout: Buffer.from(''),
    stderr: Buffer.from(stderr),
    pid: 12345,
    output: [null, Buffer.from(''), Buffer.from(stderr)] as (Buffer | null)[],
    signal: null as string | null,
  };
}

describe('SSH Client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: fs.existsSync returns true (SSH config exists)
    vi.mocked(fs.existsSync).mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('parseSSHConfig', () => {
    it('should parse SSH config and return host entry', () => {
      const configContent = `
Host myserver
    HostName server.example.com
    User admin
    Port 2222
    IdentityFile ~/.ssh/id_custom

Host another
    HostName 192.168.1.100
    User root
`;
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const result = parseSSHConfig('myserver');

      expect(result).toEqual({
        host: 'server.example.com',
        user: 'admin',
        port: 2222,
        identityFile: expect.stringContaining('.ssh/id_custom'),
      });
    });

    it('should return null for unknown host', () => {
      const configContent = `
Host myserver
    HostName server.example.com
    User admin
`;
      vi.mocked(fs.readFileSync).mockReturnValue(configContent);

      const result = parseSSHConfig('unknown');
      expect(result).toBeNull();
    });

    it('should handle missing SSH config file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = parseSSHConfig('myserver');
      expect(result).toBeNull();
    });
  });

  describe('connectToRemote', () => {
    it('should establish SSH connection and return true on success', async () => {
      vi.mocked(spawnSync).mockReturnValue(mockSpawnSuccess('connected'));

      const config: SSHConnectionConfig = {
        host: 'user@server.example.com',
      };

      const result = await connectToRemote(config);
      expect(result).toBe(true);
    });

    it('should return false on connection failure', async () => {
      vi.mocked(spawnSync).mockReturnValue(mockSpawnFailure('Connection refused'));

      const config: SSHConnectionConfig = {
        host: 'user@unreachable.example.com',
      };

      const result = await connectToRemote(config);
      expect(result).toBe(false);
    });

    it('should use identity file when provided', async () => {
      vi.mocked(spawnSync).mockReturnValue(mockSpawnSuccess('connected'));

      const config: SSHConnectionConfig = {
        host: 'user@server.example.com',
        identityFile: '~/.ssh/id_custom',
      };

      await connectToRemote(config);

      const spawnCall = vi.mocked(spawnSync).mock.calls[0];
      const sshArgs = spawnCall[1] as string[];
      expect(sshArgs).toContain('-i');
      // The identityFile gets expanded via expandTilde
      const idIndex = sshArgs.indexOf('-i');
      expect(sshArgs[idIndex + 1]).toContain('id_custom');
    });
  });

  describe('checkRemoteInstall', () => {
    it('should return installed:false when duckbrain not found', async () => {
      // "which duckbrain" returns failure
      vi.mocked(spawnSync).mockReturnValue(mockSpawnFailure());

      const result = await checkRemoteInstall('user@server.example.com');

      expect(result).toEqual({
        installed: false,
        needsUpdate: false,
      });
    });

    it('should detect version from duckbrain --version output', async () => {
      // First call: "which duckbrain" succeeds
      // Second call: "duckbrain --version" succeeds
      vi.mocked(spawnSync)
        .mockReturnValueOnce(mockSpawnSuccess('/usr/local/bin/duckbrain'))
        .mockReturnValueOnce(mockSpawnSuccess('duckbrain v1.0.0'));

      const result = await checkRemoteInstall('user@server.example.com');

      expect(result.installed).toBe(true);
      expect(result.version).toBe('1.0.0');
      expect(result.needsUpdate).toBe(false);
    });

    it('should detect when update is needed', async () => {
      // First call: "which duckbrain" succeeds
      // Second call: "duckbrain --version" returns old version
      vi.mocked(spawnSync)
        .mockReturnValueOnce(mockSpawnSuccess('/usr/local/bin/duckbrain'))
        .mockReturnValueOnce(mockSpawnSuccess('duckbrain v0.1.0'));

      const result = await checkRemoteInstall('user@server.example.com');

      expect(result.installed).toBe(true);
      expect(result.version).toBe('0.1.0');
      expect(result.needsUpdate).toBe(true);
    });
  });

  describe('installRemote', () => {
    it('should attempt user-space installation (~/.local/bin)', async () => {
      // Mock successful user-space install
      vi.mocked(spawnSync).mockReturnValue(mockSpawnSuccess('installed'));

      const result = await installRemote('user@server.example.com');

      expect(result).toBe(true);

      // Verify it tried user-space install (no sudo)
      const calls = vi.mocked(spawnSync).mock.calls;
      const firstCallArgs = calls[0][1] as string[];
      // The command is the last arg in the SSH command
      const remoteCmd = firstCallArgs[firstCallArgs.length - 1];
      expect(remoteCmd).not.toContain('sudo');
      expect(remoteCmd).toContain('.local');
    });

    it('should print sudo command when user-space install fails and system-wide needed', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Mock user-space install failure
      vi.mocked(spawnSync).mockReturnValue(mockSpawnFailure('permission denied'));

      const result = await installRemote('user@server.example.com');

      // Should not auto-escalate to sudo (D-21)
      expect(result).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('sudo')
      );
    });
  });
});
