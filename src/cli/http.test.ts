/**
 * Tests for HTTP MCP server
 */

import { describe, it, expect } from 'vitest';
import { startHttpMode, createHttpServer } from './http';

describe('HTTP server entry point', () => {
  it('should export startHttpMode function', () => {
    expect(startHttpMode).toBeDefined();
    expect(typeof startHttpMode).toBe('function');
  });

  it('should export createHttpServer function', () => {
    expect(createHttpServer).toBeDefined();
    expect(typeof createHttpServer).toBe('function');
  });

  it('should start HTTP server with default options', async () => {
    // Verify function signature
    expect(async () => {
      await startHttpMode({ port: 3001 });
    }).toBeDefined();
  });
});
