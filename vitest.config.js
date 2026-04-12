import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    testTimeout: 15000,
    hookTimeout: 10000,
    coverage: {
      provider: 'v8',
      include: ['lib/**'],
      exclude: ['tests/**', 'node_modules/**', 'lib/index.cjs'],
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 95,
        lines: 90,
      },
    },
  },
});
