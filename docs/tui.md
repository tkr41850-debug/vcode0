# gsd2 TUI

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the high-level architecture index.

## Progress TUI

Built on `@mariozechner/pi-tui`. Redraws on state change (not fixed frame rate) using differential rendering.

The UI presents two state axes:
- **Work control** — where work is in the GSD lifecycle
- **Collaboration control** — where the branch/merge/conflict lifecycle stands

```text
┌──────────────────────────────────────────────────────────────┐
│ gsd2  goal: "implement auth system"   cost: $1.23            │
├──────────────────────────────────────────────────────────────┤
│  M1: Core Infrastructure                   [3/5 done]        │
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
- `⟳` running / executing
- `·` pending / ready
- `↺` retrying
- `!` stuck / replanning needed
- `✗` failed
- `⊘` cancelled

**Collaboration control**
- `branch_open` — active feature/task branch
- `suspended` — same-feature file-lock pause
- `merge_queued` — waiting in integration queue
- `integrating` — merge train is rebasing/verifying
- `conflict` — collaboration issue blocks integration
- `merged` — branch landed and cleaned up

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

## TUI Entry Points

All plan management is done through the TUI (like gsd-2), not CLI subcommands. The TUI has two modes: **interactive** (user drives) and **auto** (orchestrator drives, TUI shows progress).

```bash
gsd2              # open TUI in current directory
gsd2 --auto       # start auto-execution immediately, TUI shows progress
```

Output files written to current directory:
- `.gsd2/state.db` — SQLite DAG state
- `.gsd2/config.json` — project config (verification checks, budget, etc.)
- `.gsd2/worktrees/` — per-task git worktrees

### TUI Actions (keyboard-driven overlays)

| Key | Action |
|-----|--------|
| `n` | New plan — opens spec editor overlay, runs planner on submit |
| `a` | Add milestone — opens spec editor, planner adds to existing graph |
| `space` | Start/pause auto-execution |
| `w` | Worker picker — select a worker to focus in Agent Monitor |
| `s` | Steer selected worker (in main view: opens worker picker first if none selected) |
| `r` | Retry failed task |
| `m` | Toggle Agent Monitor overlay (live worker output + steer) |
| `p` | Replan — trigger replanner for a stuck/conflicted feature |
| `x` | Cancel feature (with cascade prompt) |
| `e` | Edit feature (name, description, tasks) |
| `d` | Show feature dependency detail |
| `c` | Regenerate codebase map (`.gsd2/CODEBASE.md`) |
| `q` | Quit |

## Agent Monitor View

A TUI overlay (press `m`) showing all running workers with their live output streams. Each worker's pi-sdk `progress` IPC messages are displayed in a scrollable pane. Users can select a worker and steer it in real time.

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
