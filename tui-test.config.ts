import { defineConfig, Shell } from '@microsoft/tui-test';

export default defineConfig({
  reporter: 'list',
  testMatch: 'test/integration/tui/**/*.test.ts',
  // Increased from 60s: tsx startup on this environment takes ~26s leaving
  // insufficient margin at 60s for tests with seeding + TUI startup + assertions.
  timeout: 120_000,
  expect: {
    // Increased from 30s to match the raised tuiReadyTimeoutMs in tests.
    timeout: 60_000,
  },
  shellReadyTimeout: 30_000,
  workers: 1,
  trace: false,
  use: {
    shell: Shell.Bash,
    rows: 30,
    columns: 100,
    env: {
      TERM: 'xterm-256color',
    },
  },
});
