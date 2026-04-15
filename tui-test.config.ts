import { defineConfig, Shell } from '@microsoft/tui-test';

export default defineConfig({
  reporter: 'list',
  testMatch: 'test/integration/tui/**/*.test.ts',
  timeout: 60_000,
  expect: {
    timeout: 30_000,
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
