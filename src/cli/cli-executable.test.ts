/**
 * Tests for CLI executable
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('CLI executable', () => {
  const cliPath = path.join(process.cwd(), 'bin', 'duckbrain.js');
  
  it('should exist', () => {
    expect(fs.existsSync(cliPath)).toBe(true);
  });

  it('should be executable', () => {
    const stats = fs.statSync(cliPath);
    // Check if file has execute permission for owner
    expect(stats.mode & fs.constants.S_IXUSR).toBeGreaterThan(0);
  });

  it('should have shebang', () => {
    const content = fs.readFileSync(cliPath, 'utf8');
    expect(content.startsWith('#!/usr/bin/env node')).toBe(true);
  });
});
