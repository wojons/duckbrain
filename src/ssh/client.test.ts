/**
 * Tests for SSH client module
 *
 * Tests SSH config parsing, remote install checking, and installation.
 * Uses mocked child_process to avoid real SSH connections.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock child_process
vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

// Mock fs for SSH config reading
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
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
  RemoteStatus,
  connectToRemote,
  checkRemoteInstall,
  installRemote,
  parseSSHConfig,
} from './client';

describe('SSH Client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
        identityFile: path.expandTilde?.('~/.ssh/id_custom') || expect.any(String),
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
      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
        pid: 12345,
        output: [null, Buffer.from(''), Buffer.from('')],
        signal: null,
      });

      const config: SSHConnectionConfig = {
        host: 'user@server.example.com',
      };

      const result = await connectToRemote(config);
      expect(result).toBe(true);
    });

    it('should return false on connection failure', async () => {
      vi.mocked(spawnSync).mockReturnValue({
        status: 1,
        stdout: Buffer.from(''),
        stderr: Buffer.from('Connection refused'),
        pid: 12345,
        output: [null, Buffer.from(''), Buffer.from('Connection refused')],
        signal: null,
      });

      const config: SSHConnectionConfig = {
        host: 'user@unreachable.example.com',
      };

      const result = await connectToRemote(config);
      expect(result).toBe(false);
    });

    it('should use identity file when provided', async () => {
      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
        pid: 12345,
        output: [null, Buffer.from(''), Buffer.from('')],
        signal: null,
      });

      const config: SSHConnectionConfig = {
        host: 'user@server.example.com',
        identityFile: '~/.ssh/id_custom',
      };

      await connectToRemote(config);

      const spawnCall = vi.mocked(spawnSync).mock.calls[0];
      const sshArgs = spawnCall[1] as string[];
      expect(sshArgs).toContain('-i');
      expect(sshArgs).toContain(expect.stringContaining('id_custom'));
    });
  });

  describe('checkRemoteInstall', () => {
    it('should return installed:false when duckbrain not found', async () => {
      // Mock "which duckbrain" to fail
      vi.mocked(execSync)
        .mockImplementationOnce(() => {
          throw new Error('not found');
        });

      const result = await checkRemoteInstall('user@server.example.com');

      expect(result).toEqual({
        installed: false,
        needsUpdate: false,
      });
    });

    it('should detect version from duckbrain --version output', async () => {
      // Mock "which duckbrain" succeeds
      vi.mocked(execSync)
        .mockImplementationOnce(() => Buffer.from('/usr/local/bin/duckbrain'))
        // Mock "duckbrain --version" succeeds
        .mockImplementationOnce(() => Buffer.from('duckbrain v1.0.0'));

      const result = await checkRemoteInstall('user@server.example.com');

      expect(result.installed).toBe(true);
      expect(result.version).toBe('1.0.0');
      expect(result.needsUpdate).toBe(false);
    });

    it('should detect when update is needed', async () => {
      // Mock "which duckbrain" succeeds
      vi.mocked(execSync)
        .mockImplementationOnce(() => Buffer.from('/usr/local/bin/duckbrain'))
        // Mock "duckbrain --version" returns old version
        .mockImplementationOnce(() => Buffer.from('duckbrain v0.1.0'));

      const result = await checkRemoteInstall('user@server.example.com');

      expect(result.installed).toBe(true);
      expect(result.version).toBe('0.1.0');
      expect(result.needsUpdate).toBe(true);
    });
  });

  describe('installRemote', () => {
    it('should attempt user-space installation (~/.local/bin)', async () => {
      // Mock successful user-space install
      vi.mocked(execSync).mockReturnValue(Buffer.from('installed'));

      const result = await installRemote('user@server.example.com');

      expect(result).toBe(true);

      // Verify it tried user-space install (no sudo)
      const calls = vi.mocked(execSync).mock.calls;
      const firstCall = calls[0][0] as string;
      expect(firstCall).not.toContain('sudo');
      expect(firstCall).toContain('.local');
    });

    it('should print sudo command when user-space install fails and system-wide needed', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Mock user-space install failure
      vi.mocked(execSync)
        .mockImplementationOnce(() => {
          throw new Error('permission denied');
        });

      const result = await installRemote('user@server.example.com');

      // Should not auto-escalate to sudo (D-21)
      expect(result).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('sudo')
      );
    });
  });
});
