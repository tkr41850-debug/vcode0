# TUI

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for high-level architecture overview.

## Current Surface

Built on `@mariozechner/pi-tui`.
Current app shows milestone / feature / task DAG tree, status bar, and three overlays:

- help overlay
- dependency-detail overlay
- agent-monitor overlay

UI is event-driven. Scheduler and worker output update view-models, and components request redraws only when state changes.

## Status Conventions

### Work / derived status icons

- `✓` — done
- `⟳` — in progress
- `·` — pending or ready
- `⏸` — blocked
- `!` — partially failed / stuck
- `✗` — failed
- `⊘` — cancelled

Task rows render as derived `blocked` when:

- run status is `await_response`
- run status is `await_approval`
- run status is `retry_await` and `retry_at` is still in future
- task collaboration control is `suspended` or `conflict`

Feature rows render as blocked when current feature-phase run is waiting in `await_response`, `await_approval`, or active `retry_await`.

Feature and task metadata show current work-control / collab-control values directly in row badges.

## Entry Points

```bash
gvc0
gvc0 --auto
gvc0 --cwd /path/to/project
```

- `gvc0` starts interactive mode
- `gvc0 --auto` starts with auto-execution enabled
- `--cwd` changes working directory before composition/startup

Current runtime writes under project `.gvc0/` directory:

- `state.db` — SQLite state
- `config.json` — project config
- `worktrees/` — feature/task worktrees
- `sessions/` — persisted task and feature-phase session transcripts

## Keyboard Actions

### Navigation

| Key | Action |
|---|---|
| `↑` / `↓` | Move DAG selection |
| `esc` | Hide top overlay |

### Commands

| Key | Action |
|---|---|
| `space` | Start or pause auto-execution |
| `g` | Queue or dequeue selected milestone |
| `m` | Show or hide agent monitor overlay |
| `w` | Cycle active worker selection |
| `h` | Show or hide keyboard help |
| `d` | Show dependency detail for selected feature |
| `x` | Cancel selected feature |
| `q` | Quit TUI; if overlay is open, hide overlay first |

Not implemented in current TUI:

- new-plan editor
- milestone creation/edit flows
- retry / replan actions
- worker steer / abort controls
- manual run release
- `CODEBASE.md` regeneration command

## Overlays

### Help Overlay

Press `h`.
Shows navigation keys plus registered commands.
This is keyboard help, not operator inbox for answering blocked runs.

### Dependency Detail Overlay

Press `d` with feature selected.
Shows selected feature, milestone, dependencies, and dependents.

### Agent Monitor Overlay

Press `m`.
Shows recent worker output grouped by agent run. `w` cycles selected worker. Current monitor is read-only: it displays live output, but does not expose steer or abort actions.

Illustrative layout:

```text
┌─────────────────────────────────────────────────────┐
│ Agent Monitor [3 active]              [m/q/esc hide]│
├──────────────┬──────────────────────────────────────┤
│ > t-1        │ Task: t-1                             │
│   t-2        │ Run: run-task:t-1                     │
│   t-3        │ ────────────────────                  │
│              │ Reading src/...                       │
│              │ Running npm test                      │
│              │ submit() complete                     │
└──────────────┴──────────────────────────────────────┘
```
