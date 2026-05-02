# gvc0

gvc0 is a local-first TypeScript orchestrator for autonomous coding work. From one prompt, it builds a feature/task DAG, runs task agents in isolated git worktrees, routes questions to a unified inbox, and serializes completed feature branches through a merge train.

This repository is intentionally source-install only for v1. Public npm/global installs and standalone binaries are deferred distribution work.

## Requirements

- Node.js 24 or newer
- npm
- git
- Native build tools for platforms where `node-pty` must rebuild from source, such as Alpine/musl: Python, C/C++ compiler, make, and node-gyp-compatible headers

## Install from source

```bash
npm install
```

`npm install` runs the project postinstall hook. On platforms where the bundled `node-pty` prebuild is not loadable, the hook rebuilds `node-pty` from source so the terminal E2E lane and TUI PTY support can run.

## Configure a workspace

Run gvc0 from a workspace directory that contains `.gvc0/` and `gvc0.config.json`.

```bash
mkdir -p .gvc0
cat > gvc0.config.json <<'JSON'
{
  "models": {
    "topPlanner": { "provider": "anthropic", "model": "claude-haiku-4-5" },
    "featurePlanner": { "provider": "anthropic", "model": "claude-haiku-4-5" },
    "taskWorker": { "provider": "anthropic", "model": "claude-haiku-4-5" },
    "verifier": { "provider": "anthropic", "model": "claude-haiku-4-5" }
  }
}
JSON
```

Use model IDs and providers appropriate for your environment. Do not put API keys in `gvc0.config.json`; provider credentials should come from your normal shell environment.

## Run the TUI

From this source checkout:

```bash
npm run tui
```

To keep gvc0 state in another workspace:

```bash
npm run tui -- --cwd /path/to/workspace
```

On an empty workspace, the TUI starts with composer focus and shows:

```text
Run /init to create first milestone and planning feature.
```

Start a project with:

```text
/init --milestone-name "Milestone 1" --milestone-description "Initial milestone" --feature-name "Project startup" --feature-description "Plan initial project work"
```

## Verify the checkout

Run the main verification lane:

```bash
npm run check
```

Run terminal E2E smoke tests separately:

```bash
npm run test:tui:e2e
```

`npm run test` runs Vitest only. The TUI lane uses `@microsoft/tui-test` and is intentionally separate.

## Documentation

- [Architecture overview](./ARCHITECTURE.md) — system thesis, lifecycle split, and component map
- [Documentation index](./docs/README.md) — docs landing page
- [Prompt to main walkthrough](./docs/foundations/newcomer.md) — end-to-end operator story
- [Testing strategy](./docs/operations/testing.md) — verification lanes and coverage map
- [TUI reference](./docs/reference/tui.md) — keyboard and slash-command reference
