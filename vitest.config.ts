import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: 'node',
    globals: false,
    passWithNoTests: true,
    include: [
      'test/unit/**/*.test.ts',
      'test/unit/**/*.spec.ts',
      'test/integration/**/*.test.ts',
      'test/integration/**/*.spec.ts',
    ],
    exclude: ['test/integration/tui/**'],
  },
});
