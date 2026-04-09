import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: 'node',
    globals: false,
    passWithNoTests: true,
    include: ['test/**/*.test.ts', 'test/**/*.spec.ts'],
  },
});
