# TUI

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the high-level architecture index.

## Progress TUI

Built on `@mariozechner/pi-tui`. The only baseline capability we rely on from pi-tui is component-based terminal rendering with efficient differential redraws; higher-level view-model, event-routing, and orchestration-state decisions belong to gvc0 rather than being assumed to come from the library.

The TUI should be event-driven: orchestrator/store/runtime services emit state changes, a small UI-facing controller recomputes derived display state, affected components call `invalidate()`, and pi-tui handles efficient redraw. The TUI should not poll for repaint on a fixed frame rate and should not treat warnings as authoritative state.

The UI presents two state axes:
- **Work control** — where work is in the GSD lifecycle
- **Collaboration control** — where the branch/merge/conflict lifecycle stands

Milestones are shown as organizational / progress buckets. Users may queue multiple milestones as an ordered steering override; otherwise auto-execution stays in autonomous mode and pulls from the global ready frontier.

```text
┌──────────────────────────────────────────────────────────────┐
│ gvc0  goal: "implement auth system"   cost: $1.23            │
├──────────────────────────────────────────────────────────────┤
│  M1: Core Infrastructure [queue: 1]       [3/5 done]        │
│  ├── ✓ F-db: Database schema                                   │
│  ├── ✓ F-models: Data models                                   │
│  ├── ⟳ F-auth: Auth middleware      [work: executing]          │
│  │                                [collab: branch_open]        │
│  │   ├── ✓ Task: JWT validation                                │
│  │   ├── ⟳ Task: Session store          [branch_open]          │
│  │   └── · Task: Middleware wiring     [ready]                 │
│  ├── · F-api: REST endpoints         [waiting on feature deps] │
│  └── · F-ui: Login page              [waiting on feature deps] │
│  M2: Testing                          [0/2 done]               │
│  └── · F-tests: Integration tests     [waiting on M1 features] │
├──────────────────────────────────────────────────────────────┤
│ workers: 3 running  2 idle   tasks: 4/12 done                │
└──────────────────────────────────────────────────────────────┘
```

### Status Conventions

**Work control**
- `✓` done
- `⟳` running / executing (`executing`, `feature_ci`, `verifying`, `summarizing`, `executing_repair`)
- `·` pending / ready (`pending`, `ready`, `awaiting_merge`)
- `⏸` blocked (derived UI state: waiting on retry/help/approval or collaboration pause)
- `!` stuck / replanning needed
- `✗` failed (no more progress)
- `⊘` cancelled

**Collaboration control**
- `branch_open` — active feature/task branch
- `suspended` — task-level same-feature file-lock pause, cross-feature pause, or feature-conflict-derived task suspension
- `merge_queued` — waiting in integration queue
- `integrating` — merge train is rebasing and running merge-train checks
- `conflict` — collaboration issue blocks integration
- `merged` — branch landed and cleaned up

**Run attention / ownership overlays**
- `retry_await` — execution run is backing off after a transient failure
- `await_response` — paused until a human answers or resumes manually
- `await_approval` — paused until a human approves a structured proposal
- `crashloop_backoff` — transient retries continue, but the run is visibly churny
- `manual` — user is attached or currently owns the run

A task should render as derived `blocked`
when its execution run is in `retry_await`,
`await_response`, or `await_approval`,
or when task collaboration control is
`suspended` / `conflict`.
This is a presentation overlay, not a persisted task enum.

```typescript
class DagView implements Component {
  render(width: number): string[] { /* milestone tree with work/collab badges */ }
  invalidate(): void {}
}
class StatusBar implements Component {
  render(width: number): string[] { /* "workers: N running  tasks: X/Y  cost: $Z" */ }
  invalidate(): void {}
}
```

### Update Flow

Baseline flow:
1. scheduler / worker pool / warning manager emits a state-change event
2. store persists authoritative changes where applicable
3. a UI-facing controller derives display state (counts, badges, queue labels, blocked summaries)
4. affected components call `invalidate()`
5. pi-tui performs the differential redraw

User actions should flow the other direction through orchestrator commands (`queue milestone`, `retry`, `replan`, `regenerate CODEBASE`, etc.) rather than mutating view state directly inside components.

## TUI Entry Points

All plan management is done through the TUI (like gsd-2), not CLI subcommands. The TUI has two modes: **interactive** (user drives) and **auto** (orchestrator drives, TUI shows progress).

```bash
gvc0              # open TUI in current directory
gvc0 --auto       # start auto-execution immediately, TUI shows progress
```

Output files written to current directory:
- `.gvc0/state.db` — SQLite DAG state
- `.gvc0/config.json` — project config (verification checks, budget, etc.)
- `.gvc0/worktrees/` — feature and task git worktrees

### Cost Detail

The main DAG tree should stay progress-focused rather than showing token totals inline for every node. Token and cost breakdown belongs in task / feature detail views, where the TUI may show lifetime usage totals (`input`, `output`, `cacheRead`, `cacheWrite`, optional `reasoning` / `audio`, `usd`, `llmCalls`, and per-model rollups).

### TUI Actions (keyboard-driven overlays)

| Key | Action |
|-----|--------|
| `n` | New plan — opens spec editor overlay, runs planner on submit |
| `a` | Add milestone — opens spec editor, planner adds to existing graph |
| `g` | Queue / dequeue milestone — edit the ordered milestone steering queue or return to autonomous scheduling |
| `space` | Start/pause auto-execution |
| `w` | Worker picker — select a worker to focus in Agent Monitor |
| `s` | Steer selected worker (in main view: opens worker picker first if none selected) |
| `r` | Retry failed task |
| `h` | Help inbox — answer `await_response` runs or approve `await_approval` proposals |
| `m` | Toggle Agent Monitor overlay (live worker output + steer) |
| `p` | Replan — trigger replanner for a stuck/conflicted feature |
| `u` | Release selected manual run back to the scheduler (`release_to_scheduler`) |
| `x` | Cancel feature (with cascade prompt) |
| `e` | Edit feature (name, description, tasks) |
| `d` | Show feature dependency detail |
| `c` | Force-regenerate codebase map (`.gvc0/CODEBASE.md`) from the current structural input bundle |
| `q` | Quit |

## Agent Monitor View

A TUI overlay (press `m`) showing all running workers with their live output streams. Each worker's pi-sdk `progress` IPC messages are displayed in a scrollable pane. Users can select a worker and steer it in real time. These log lines are runtime-only UI state and do not need to round-trip through SQLite.

```text
┌─────────────────────────────────────────────────────┐
│ Agent Monitor          [3 running]          [m] hide │
├──────────────┬──────────────────────────────────────┤
│ > worker-1   │ Task: JWT validation                  │
│   worker-2   │ ─────────────────────────────────     │
│   worker-3   │ Reading src/auth/middleware.ts...     │
│              │ Writing src/auth/jwt.ts...            │
│              │ Running: tsc --noEmit                 │
│              │ ✓ TypeScript compiles                 │
│              │ Calling submit...                     │
│              │                                       │
│              │ [s] steer  [x] abort                  │
└──────────────┴──────────────────────────────────────┘
```

```typescript
class AgentMonitorOverlay implements Component {
  private selectedWorker: string | null = null;
  private logs: Map<string, string[]> = new Map(); // workerId → recent lines

  onProgress(workerId: string, message: string): void {
    const lines = this.logs.get(workerId) ?? [];
    lines.push(message);
    if (lines.length > 200) lines.shift();
    this.logs.set(workerId, lines);
    this.invalidate();
  }

  render(width: number): string[] { /* two-pane layout */ }
  invalidate(): void {}
}
