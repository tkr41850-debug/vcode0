import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    globals: false,
    passWithNoTests: true,
    include: ['test/**/*.test.ts', 'test/**/*.spec.ts'],
  },
});
