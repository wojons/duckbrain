import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60000,
    hookTimeout: 120000,
    include: ['tests/**/*.int.test.ts'],
    pool: 'forks',
    fileParallelism: false,
  },
});
