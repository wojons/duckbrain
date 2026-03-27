/**
 * Tests for human operator CLI commands
 */

import { describe, it, expect } from 'vitest';
import { runHumanCLI } from './human';

describe('human CLI commands', () => {
  it('should export runHumanCLI function', () => {
    expect(runHumanCLI).toBeDefined();
    expect(typeof runHumanCLI).toBe('function');
  });

  it('should handle help command', async () => {
    // Verify help command doesn't throw
    await expect(runHumanCLI('help', [])).resolves.not.toThrow();
  });

  it('should handle unknown command with error', async () => {
    await expect(runHumanCLI('unknown-command', [])).rejects.toThrow();
  });
});
