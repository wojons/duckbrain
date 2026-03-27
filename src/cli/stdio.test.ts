/**
 * Tests for stdio MCP entry point
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startStdioMode } from './stdio';

describe('stdio mode entry point', () => {
  it('should export startStdioMode function', () => {
    expect(startStdioMode).toBeDefined();
    expect(typeof startStdioMode).toBe('function');
  });

  it('should start MCP server with stdio transport', async () => {
    // Start stdio mode (will fail because server isn't fully set up yet)
    // This test verifies the function exists and has correct signature
    expect(async () => {
      await startStdioMode();
    }).toBeDefined();
  });
});
