/**
 * Tests for SSH tunnel module
 *
 * Tests tunnel creation, Unix socket management, and tunnel lifecycle.
 * Uses mocked child_process and fs to avoid real SSH connections.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  execSync: vi.fn(),
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      existsSync: vi.fn(),
      mkdirSync: vi.fn(),
      unlinkSync: vi.fn(),
      readdirSync: vi.fn(),
      statSync: vi.fn(),
    },
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    readdirSync: vi.fn(),
    statSync: vi.fn(),
  };
});

import {
  TunnelConfig,
  createTunnel,
  closeTunnel,
  listTunnels,
} from './tunnel';

describe('SSH Tunnel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: directories and files exist
    vi.mocked(fs.existsSync).mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createTunnel', () => {
    it('should spawn ssh -L with correct socket path', async () => {
      const mockProcess = {
        pid: 12345,
        on: vi.fn(),
        kill: vi.fn(),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
      };
      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      const config: TunnelConfig = {
        remoteHost: 'user@server.example.com',
        localSocketPath: path.join(os.homedir(), '.duckbrain', 'sockets', 'prod.sock'),
        remotePort: 3000,
      };

      const socketPath = await createTunnel(config);

      expect(socketPath).toContain('prod.sock');
      expect(spawn).toHaveBeenCalledWith('ssh', expect.arrayContaining([
        '-L',
        expect.stringContaining('prod.sock'),
        '-N',
        'user@server.example.com',
      ]));
    });

    it('should create Unix socket at ~/.duckbrain/sockets/{name}.sock', async () => {
      const mockProcess = {
        pid: 12345,
        on: vi.fn(),
        kill: vi.fn(),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
      };
      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      const config: TunnelConfig = {
        remoteHost: 'user@server',
        localSocketPath: path.join(os.homedir(), '.duckbrain', 'sockets', 'test.sock'),
        remotePort: 3000,
      };

      const socketPath = await createTunnel(config);

      expect(socketPath).toContain('.duckbrain/sockets/test.sock');
    });

    it('should set socket permissions to 0600', async () => {
      const mockProcess = {
        pid: 12345,
        on: vi.fn(),
        kill: vi.fn(),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
      };
      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      const config: TunnelConfig = {
        remoteHost: 'user@server',
        localSocketPath: path.join(os.homedir(), '.duckbrain', 'sockets', 'prod.sock'),
        remotePort: 3000,
      };

      await createTunnel(config);

      // Should chmod the socket after creation
      expect(spawnSync).toHaveBeenCalledWith(
        'chmod',
        expect.arrayContaining(['600', expect.stringContaining('prod.sock')])
      );
    });

    it('should ensure sockets directory exists', async () => {
      // First call: existsSync returns false for sockets dir
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const mockProcess = {
        pid: 12345,
        on: vi.fn(),
        kill: vi.fn(),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
      };
      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      const config: TunnelConfig = {
        remoteHost: 'user@server',
        localSocketPath: path.join(os.homedir(), '.duckbrain', 'sockets', 'new.sock'),
        remotePort: 3000,
      };

      await createTunnel(config);

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('.duckbrain/sockets'),
        { recursive: true }
      );
    });

    it('should store PID in sidecar file', async () => {
      const mockProcess = {
        pid: 54321,
        on: vi.fn(),
        kill: vi.fn(),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
      };
      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      const config: TunnelConfig = {
        remoteHost: 'user@server',
        localSocketPath: path.join(os.homedir(), '.duckbrain', 'sockets', 'prod.sock'),
        remotePort: 3000,
      };

      await createTunnel(config);

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('prod.pid'),
        '54321'
      );
    });
  });

  describe('closeTunnel', () => {
    it('should terminate SSH process and remove socket file', async () => {
      // Mock PID file exists
      vi.mocked(fs.readFileSync).mockReturnValue('12345');
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const mockKillResult = { status: 0, stdout: '', stderr: '' };
      vi.mocked(spawnSync).mockReturnValue(mockKillResult as any);

      const socketPath = path.join(os.homedir(), '.duckbrain', 'sockets', 'prod.sock');
      await closeTunnel(socketPath);

      // Should kill the process
      expect(spawnSync).toHaveBeenCalledWith('kill', ['12345']);
      // Should remove socket and PID files
      expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('prod.sock'));
      expect(fs.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('prod.pid'));
    });
  });

  describe('listTunnels', () => {
    it('should return active tunnels from socket directory', () => {
      // Mock readdirSync to return socket and pid files
      vi.mocked(fs.readdirSync).mockReturnValue([
        'prod.sock' as any,
        'prod.pid' as any,
        'dev.sock' as any,
        'dev.pid' as any,
      ]);

      // Mock PID files
      vi.mocked(fs.readFileSync)
        .mockReturnValueOnce('12345')
        .mockReturnValueOnce('67890');

      const tunnels = listTunnels();

      expect(tunnels).toHaveLength(2);
      expect(tunnels[0]).toEqual({
        name: 'prod',
        socketPath: expect.stringContaining('prod.sock'),
        remoteHost: expect.any(String),
      });
      expect(tunnels[1]).toEqual({
        name: 'dev',
        socketPath: expect.stringContaining('dev.sock'),
        remoteHost: expect.any(String),
      });
    });

    it('should return empty array when no sockets exist', () => {
      vi.mocked(fs.readdirSync).mockReturnValue([]);

      const tunnels = listTunnels();
      expect(tunnels).toHaveLength(0);
    });
  });
});
