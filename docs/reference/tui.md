# TUI

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for high-level architecture overview.

## Current Surface

Built on `@mariozechner/pi-tui`.
Current app shows:

- milestone / feature / task DAG tree
- status bar
- composer status strip
- composer input
- help overlay
- dependency-detail overlay
- agent-monitor overlay

TUI starts in composer focus. Status line can show current focus (`composer` or `graph`) and data mode (`live`, `draft`, or `live-planner`). Composer status strip shows current composer mode (`command`, `draft`, `approval`, `task`, `live-planner`, or `attached`).

The composer status strip's first line is a focus indicator that always shows where keystrokes route to. Three variants:

- `composer · graph` — normal command/draft entry routes to local graph mutations.
- `composer · project planner: <session-id>` — chat routes to the active project-planner session.
- `composer · feature plan: <feature-id>` — chat routes to the attached feature plan/replan session (covers `live-planner` and `approval` for plan/replan, and `attached` mode).

The label persists when the composer is defocused (`esc` to graph focus): the most recent destination remains visible so the operator knows what `esc` will return to.

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

Feature rows render as blocked when current feature-phase run is waiting in `await_response`, `await_approval`, or active `retry_await`. A feature-phase run in `failed` renders with the failed icon (`✗`) instead of the blocked pause; the inbox row written when the run failed is the operator's follow-up surface.

Feature and task metadata show current work_control / collaboration_control values directly in row badges.

### Integration Display

When a feature is in `collabControl=integrating`, the row carries the coarse integrating badge; the executor runs inline (rebase → post-rebase `ci_check` → plumbing CAS on `refs/heads/main`) without a dedicated per-step run surface. `FeatureWorkControl` stays coarse — no work-control enum values are added for integration sub-steps.

On integration failure, the row returns to the normal `replanning` badge once the executor has ejected and rerouted the feature.

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

## Focus Modes

TUI has two focus modes:

- `composer` — text entry, slash commands, history, autocomplete
- `graph` — DAG navigation and single-key hotkeys

Current focus is shown in status output.

Focus changes:

- startup begins in composer focus
- `esc` hides top overlay first
- `esc` from composer switches to graph focus
- `esc` from graph focus switches back to composer focus
- `/` from graph focus switches to composer focus and seeds input with `/`

Most single-key commands only work in graph focus. While composer is focused, regular keypresses go to text entry instead.

## Keyboard Actions

### Global / context-sensitive keys

| Key | Action |
|---|---|
| `esc` | Hide top overlay. If no overlay is open: composer switches to graph focus; graph switches back to composer focus. |
| `/` | From graph focus, move to composer focus and seed `/` for slash-command entry. |
| `q` | If an overlay is open, hide overlay first instead of quitting. |

### Composer keys

| Key | Action |
|---|---|
| `enter` | Submit composer input. |
| `tab` | Autocomplete slash commands and arguments. |

### Graph-focus hotkeys

| Key | Action |
|---|---|
| `↑` / `↓` | Move DAG selection. |
| `space` | Start or pause auto-execution. |
| `g` | Queue or dequeue selected node's milestone. |
| `m` | Show or hide agent monitor overlay. |
| `w` | Cycle active worker selection in agent monitor. |
| `h` | Show or hide keyboard help. |
| `d` | Show dependency detail for selected feature. Task selection resolves to its feature. |
| `x` | Cancel selected feature and abort its running task work. Task selection resolves to its feature. |
| `q` | Quit TUI when no overlay is open. |

## Composer and Slash Commands

Composer accepts both slash commands and plain-text planner chat. Slash-prefixed input goes through the slash-command surface (see below). Plain text on a feature in `planning` or `replanning` with a running plan/replan agent run is routed to the live planner as a follow-up turn (`Agent.followUp`), so the planner can revise its proposal in response. Plain text on a feature outside planning/replanning, or with no live run, is rejected with a notice. Plain text with no feature selected is rejected with a notice. While a manual proposal draft is active (after `/feature-add` etc and before `/submit` or `/discard`), plain text is rejected with `discard manual draft (/discard) before chatting with planner` to avoid two competing proposal sources.

Checkpoint-style `submit(...)` means a chat-driven follow-up that ends with another `submit(...)` replaces the prior pending proposal payload. The TUI's live planner mirror (`view: live-planner`) shows the running planner's incremental graph until the run reaches `await_approval`.

Slash-command parsing is shell-like:

- quoted multi-word values are supported
- `tab` autocompletes command names and argument templates
- autocomplete uses current selection where possible

Example:

```text
/feature-add --milestone m-1 --name "Planner TUI" --description "Command-first composer"
```

### Operational commands

- `/auto` — toggle auto execution
- `/queue` — queue or dequeue selected node's milestone
- `/monitor` — show or hide agent monitor overlay
- `/worker-next` — cycle active worker selection
- `/help` — show or hide keyboard help
- `/deps` — show dependency detail for selected feature
- `/cancel` — cancel selected feature and abort any running task work for it
- `/quit` — quit TUI

### Draft editing commands

Draft commands operate on selected planning or replanning feature context.
Starting draft work pauses auto-execution until draft is submitted or discarded.
This composer `/submit` command submits a planning/replanning proposal draft for approval; it is unrelated to the worker-side task `submit()` tool.

- `/milestone-add --name "" --description ""`
- `/feature-add`
- `/feature-remove`
- `/feature-edit`
- `/task-add`
- `/task-remove`
- `/task-edit`
- `/dep-add`
- `/dep-remove`
- `/submit`
- `/discard`

Task commands support `--weight trivial|small|medium|heavy`.
While draft is active, DAG title shows draft mode and status bar reports `view: draft`.

### Help-response commands

`/reply --text "..."` answers the most recent pending request. Routing is by selection:

- task selected and run is `await_response` → answers the task's `request_help` via runtime help-response IPC
- feature selected and feature is in `planning` or `replanning` with pending feature-phase help → answers the planner's oldest pending `request_help` via `respondToFeaturePhaseHelp`
- otherwise rejected with notice

`/input --text "..."` sends manual input on a task run currently `running/manual` (operator attached). Plain-text composer input (no slash) on a planning/replanning feature with a running plan/replan run routes to the planner as a follow-up turn (see Composer plain-text behavior earlier). Use `/input` for tasks; rely on plain-text for planner chat.

### Approval commands

When selected feature has pending proposal, composer enters approval mode and surfaces approval commands:

- `/approve`
- `/reject --comment "reason"`
- `/rerun`

`/submit` stores pending proposal for approval. `/discard` drops current draft. Both restore previous auto-execution setting.

### Project proposal review

When attached to a project-planner session and a project-scope proposal is pending review, the composer renders the proposal diff via `src/tui/proposal-review.ts`: added/removed milestones, added/removed features, and feature-dependency edge changes. The diff is computed from `(before, after)` graph snapshots — `before` is the current authoritative graph, `after` is the project-planner draft snapshot from `LiveProjectPlannerSessions`.

Cancellation-approval gate: if the proposal affects features that have running task or feature-phase runs, the controller renders a separate cancellation-approval block listing the affected feature ids and the affected run count. The operator must explicitly approve cancellation before the topology change applies. Detection uses the shared `findRunningTasksAffected` helper (`src/orchestrator/proposals/running-tasks-affected.ts`) — single source of truth with the apply-time CAS check in `applyProjectProposal`.

Rebase rejections (`ProposalRebaseReason`) are rendered with human-readable framing:

- `kind: 'stale-baseline'` — the proposal was prepared against an older `graphVersion`; the session reopens with a refreshed snapshot.
- `kind: 'running-tasks-affected'` — the proposal touches features with live runs; cancel them or wait before re-approving.

## Overlays

### Help Overlay

Open with `h` in graph focus or `/help` from composer.
Shows navigation keys plus registered commands.
This is keyboard help, not operator inbox for answering blocked runs.

### Dependency Detail Overlay

Open with `d` in graph focus or `/deps` from composer.
Works when feature or task is selected; task selection resolves to owning feature.
Shows selected feature, milestone, dependencies, and dependents.

### Agent Monitor Overlay

Open with `m` in graph focus or `/monitor` from composer.
Shows recent worker output grouped by agent run. `w` or `/worker-next` cycles selected worker. Current monitor is read-only: it displays live output, but does not expose steer or abort actions.

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
│              │ task t-1 confirmed                    │
└──────────────┴──────────────────────────────────────┘
```

## Known Limitations

- composer currently supports a minimal milestone authoring flow (`/milestone-add`) but still lacks milestone edit/remove commands
- agent monitor is read-only; no worker steer or abort controls are exposed
- task-run operator attach (subprocess scope) is not wired in the TUI; only feature-phase plan/replan attach is currently exposed via `/attach` and `/release-to-scheduler` (see `docs/operations/feature-phase-operator-attach.md`)

