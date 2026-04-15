# TUI integration tests

This folder uses [@microsoft/tui-test](https://www.npmjs.com/package/@microsoft/tui-test), not Vite or Vitest.

Run these tests with:

```bash
npx tui-test
```

Or via the package script:

```bash
npm run test:tui:e2e
```

The live app entry these tests exercise is:

```bash
npm run tui
```

Do not expect `npm run test` or plain Vitest runs to pick up files in this folder.
