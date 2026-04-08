# gsd2 Architecture: DAG-First Autonomous Agent

A TypeScript remake of GSD-2 built on pi-sdk (`@mariozechner/pi-agent-core`), replacing GSD-2's sequential-default execution model with a DAG scheduler that maximizes parallelism at every level.

---

## Core Thesis

GSD-2's execution model defaults to sequential. Parallelism is opt-in via `depends_on` declarations. This remake inverts that: **the DAG is the only execution model**. Every unit of work declares its dependencies explicitly; the scheduler runs the maximum parallel frontier at all times.

---

## Work Unit Hierarchy: Milestone → Feature → Task

```
Milestone (virtual feature aggregate)
├── Feature A
│   ├── Task 1
│   ├── Task 2
│   └── Task 3
├── Feature B (depends on Feature A)
│   └── Task 4
└── Feature C
    ├── Task 5
    └── Task 6
```

**Milestone** — a virtual feature aggregate. It has no tasks of its own. It depends on the set of features that make it up. Used for priority/ordering. A milestone is "done" when all its constituent features are done.

**Feature** — the primary unit in the dependency graph. Features depend on other features (or on milestones as aggregates). Each feature belongs to exactly one milestone. A feature progresses through phases (adapted from GSD-2, modified for DAG execution):

```
discussing → researching → planning → executing → verifying → summarizing → done
                                                                   ↓ (if checks fail)
                                                            replanning-feature
```

- **discussing** — blocking modal in TUI: the orchestrator launches a GSD-2-style discuss-phase agent, which presents clarifying questions. User responds interactively. Feature does not advance until the discussion agent completes. Skipped in `budget` token profile.
- **researching** — LLM scouts codebase and relevant docs to inform planning. Skipped in `budget` token profile.
- **planning** — decompose feature into tasks, assign weights, declare inter-task deps (uses planner agent with graph-mutation tools)
- **executing** — tasks dispatched to workers in parallel per DAG frontier
- **verifying** — all tasks submitted; feature-level checks run (if configured)
- **summarizing** — `light`-tier model writes feature summary for downstream context injection
- **done** — feature complete, dependents unblocked

Special phases: `blocked` (stuck detection threshold hit), `replanning-feature` (replanner running)

The orchestrator drives feature phase transitions. When a feature reaches `discussing`, it is shown as `⊡ needs discussion` in the TUI and waits for user input before advancing. All other phase transitions are automatic.

**Task** — the atomic unit of work. Executed by a single worker process. Tasks within a feature are independent (can run in parallel) unless explicitly ordered. A task is scoped to fit in one context window.

### Data Model

```typescript
interface Milestone {
  id: string;
  name: string;
  description: string;
  featureIds: string[];         // features that make up this milestone
  status: UnitStatus;
}

interface Feature {
  id: string;
  milestoneId: string;          // exactly one milestone per feature
  name: string;
  description: string;
  dependsOn: string[];          // feature or milestone ids
  taskIds: string[];
  status: UnitStatus;
}

interface Task {
  id: string;
  featureId: string;
  description: string;
  dependsOn: string[];          // task ids (within or across features)
  status: TaskStatus;
  workerId?: string;
  result?: TaskResult;
  weight?: number;              // estimated cost/complexity for critical path
}

type UnitStatus = "pending" | "in_progress" | "done" | "failed" | "cancelled";
type TaskStatus = "pending" | "ready" | "running" | "done" | "failed" | "blocked" | "cancelled";
```

### Scheduling Levels

The feature graph determines which features can run. Within a runnable feature, all tasks with satisfied deps are dispatched in parallel. Milestones provide priority ordering — features in milestone 1 are prioritized over milestone 2 when workers are scarce.

```
Milestone priority: M1 > M2 > M3

Feature graph (M1):
  F-auth ──→ F-api ──→ F-ui
                ↑
  F-db ────────┘

Ready frontier: [F-auth, F-db]  (no unmet deps)
After F-auth + F-db done: [F-api]
After F-api done: [F-ui]

Within F-auth:
  Task 1, Task 2, Task 3  (all independent → all dispatched in parallel)
```

---

## Graph Operations

### Core Mutations

| Operation | Description |
|---|---|
| **createMilestone(name, description)** | Create a new milestone |
| **createFeature(milestoneId, name, deps)** | Create a feature under a milestone with dependency edges |
| **createTask(featureId, description, deps?)** | Add a task to a feature |
| **addDependency(fromId, toId)** | Add a dependency edge (feature→feature, feature→milestone, or task→task) |
| **removeDependency(fromId, toId)** | Remove a dependency edge |
| **splitFeature(featureId, subfeatures)** | Break a feature into subfeatures: original keeps its deps but loses its tasks, new subfeatures take the tasks and depend on original's deps. Original becomes a virtual aggregate (like a mini-milestone) |
| **mergeFeatures(featureIds, name)** | Combine features into one. Union of deps and tasks. Redirect incoming edges |
| **cancelFeature(featureId, cascade?)** | Mark as cancelled. If cascade=true, cancel all transitive dependents |
| **changeMilestone(featureId, newMilestoneId)** | Reassign a feature to a different milestone |
| **editFeature(featureId, patch)** | Update name, description, or task list of a feature |
| **addTask(featureId, description, deps?)** | Add a task to an existing feature |
| **removeTask(taskId)** | Remove a task (only if pending) |
| **reorderTasks(featureId, taskIds)** | Reorder tasks within a feature (affects display, not scheduling) |
| **reweight(taskId, weight)** | Update estimated cost/complexity — affects critical path calculation |

### Validation

Every mutation must preserve DAG invariants:
- **No cycles** — topological sort must succeed after mutation
- **One milestone per feature** — moveFeature enforces this
- **Referential integrity** — no dangling dependency edges
- **Status consistency** — can't add tasks to a cancelled/done feature

```typescript
interface FeatureGraph {
  milestones: Map<string, Milestone>;
  features: Map<string, Feature>;
  tasks: Map<string, Task>;

  // Core queries
  readyFeatures(): Feature[];           // features whose deps are all done
  readyTasks(): Task[];                 // tasks whose deps are all done AND feature is ready
  criticalPath(): Task[];               // longest weighted path through the DAG
  isComplete(): boolean;                // all milestones done

  // Mutations (all validate invariants before applying)
  createFeature(opts: CreateFeatureOpts): Feature;
  splitFeature(id: string, splits: SplitSpec[]): Feature[];
  addDependency(from: string, to: string): void;
  // ... etc
}
```

---

## Worker Model: Process-per-Task

Each task spawns a dedicated child process. Workers are pi-sdk `Agent` instances running in isolated git worktrees.

```
Orchestrator (main process)
├── Worker 1 (child process, worktree: .gsd2/worktrees/task-001/)
│   └── pi-sdk Agent → executes Task 1
├── Worker 2 (child process, worktree: .gsd2/worktrees/task-002/)
│   └── pi-sdk Agent → executes Task 2
└── Worker 3 (child process, worktree: .gsd2/worktrees/task-003/)
    └── pi-sdk Agent → executes Task 3
```

- **Max concurrency**: configurable (default: CPU count or provider rate limit, whichever is lower)
- **Worktree lifecycle**: created on dispatch, squash-merged to main on success (all task commits collapsed to one), deleted after merge

### Git Commit Strategy

Workers make incremental commits inside their worktree as they work (conventional commits: `feat:`, `fix:`, etc.). On task completion, the orchestrator squash-merges the worktree branch to main as a single commit with the task summary as the message. This keeps main history clean — one commit per task, not dozens of intermediate saves.

```
worktree branch (task-042):
  feat: add JWT types
  feat: implement token signing
  fix: handle expiry edge case
  test: add JWT unit tests
         ↓ squash merge
main:
  feat(auth): implement JWT signing and validation [task-042]
```

---

## IPC: NDJSON over stdio (swappable)

Workers communicate with the orchestrator via newline-delimited JSON on stdin/stdout.

```typescript
// Worker → Orchestrator
type WorkerMessage =
  | { type: "status"; taskId: string; status: TaskStatus }
  | { type: "progress"; taskId: string; message: string }
  | { type: "result"; taskId: string; summary: string; filesChanged: string[] }
  | { type: "error"; taskId: string; error: string }
  | { type: "cost"; taskId: string; tokens: TokenUsage }

// Orchestrator → Worker
type OrchestratorMessage =
  | { type: "run"; task: Task; context: WorkerContext }
  | { type: "abort"; taskId: string }
  | { type: "steer"; taskId: string; message: string }
  | { type: "suspend"; taskId: string; reason: "file_lock"; files: string[] }
  | { type: "resume"; taskId: string; filesReset: string[]; reason: string }
```

### Transport Abstraction

```typescript
interface IpcTransport {
  send(msg: OrchestratorMessage): void;
  onMessage(handler: (msg: WorkerMessage) => void): void;
  close(): void;
}

class NdjsonStdioTransport implements IpcTransport { /* ... */ }
class UnixSocketTransport implements IpcTransport { /* ... */ }
```

Default is `NdjsonStdioTransport`. Can swap to `UnixSocketTransport` if stdio latency becomes a bottleneck.

---

## Context Strategy: Configurable (default: shared read-only summary)

Each worker receives context about the overall plan and completed dependency outputs. The strategy is configurable:

| Strategy | Description | Config |
|---|---|---|
| **shared-summary** (default) | Workers get a read-only summary of the plan + completed dep outputs | `context: "shared-summary"` |
| **fresh** | Workers get only their task description, no dependency context | `context: "fresh"` |
| **inherit** | Workers receive the full transcript of their dependency tasks | `context: "inherit"` |

```typescript
interface WorkerContext {
  strategy: "shared-summary" | "fresh" | "inherit";
  planSummary?: string;            // overall plan description
  dependencyOutputs?: DepOutput[]; // summaries from completed deps
  codebaseMap?: string;            // contents of .gsd2/CODEBASE.md
  knowledge?: string;              // contents of .gsd2/KNOWLEDGE.md
  decisions?: string;              // contents of .gsd2/DECISIONS.md
}

interface DepOutput {
  taskId: string;
  featureName: string;
  summary: string;                 // LLM-generated summary of what was done
  filesChanged: string[];          // paths modified by the dep task
}
```

---

## Load Balancing: Critical-Path-First

The scheduler prioritizes tasks on the longest weighted path through the DAG. This minimizes total wall-clock time by ensuring bottleneck chains start as early as possible.

```typescript
function prioritizeReadyTasks(graph: FeatureGraph): Task[] {
  const ready = graph.readyTasks();
  const criticalWeights = computeCriticalPathWeights(graph);

  // Sort by: milestone priority (asc), then critical path weight (desc)
  return ready.sort((a, b) => {
    const mA = milestonePriority(graph, a);
    const mB = milestonePriority(graph, b);
    if (mA !== mB) return mA - mB;
    return criticalWeights.get(b.id)! - criticalWeights.get(a.id)!;
  });
}

// Critical path weight = task's own weight + max weight of any downstream path
function computeCriticalPathWeights(graph: FeatureGraph): Map<string, number> {
  // Reverse topological traversal, memoized
  // ...
}
```

When workers are scarce, critical-path tasks win. When workers are plentiful, everything ready runs.

---

## Persistence: SQLite

Single database file at `.gsd2/state.db`. All DAG state persisted atomically.

### Schema

```sql
CREATE TABLE milestones (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE features (
  id TEXT PRIMARY KEY,
  milestone_id TEXT NOT NULL REFERENCES milestones(id),
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  phase TEXT NOT NULL DEFAULT 'discussing',  -- feature lifecycle phase
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  feature_id TEXT NOT NULL REFERENCES features(id),
  description TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  status TEXT NOT NULL DEFAULT 'pending',
  worker_id TEXT,
  result_summary TEXT,
  files_changed TEXT,             -- JSON array of paths
  token_usage TEXT,               -- JSON {input, output, cost}
  session_id TEXT,                -- for crash recovery (SessionHarness)
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER,               -- epoch ms for next scheduled retry (NULL = not scheduled)
  retry_attempt INTEGER NOT NULL DEFAULT 0,
  suspended_at INTEGER,
  suspend_reason TEXT,
  suspended_files TEXT,           -- JSON array
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE dependencies (
  from_id TEXT NOT NULL,           -- feature, milestone, or task id
  to_id TEXT NOT NULL,             -- depends on this
  dep_type TEXT NOT NULL,          -- 'feature', 'milestone', or 'task'
  PRIMARY KEY (from_id, to_id)
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload TEXT                     -- JSON
);
```

The `events` table is an append-only audit log for debugging and progress reporting.

---

## Scheduler Loop

```typescript
async function schedulerLoop(graph: FeatureGraph, pool: WorkerPool, store: Store) {
  while (!graph.isComplete()) {
    const ready = prioritizeReadyTasks(graph);
    const idle = pool.idleWorkers();

    const toDispatch = ready.slice(0, idle.length);
    const dispatched: Promise<void>[] = [];

    for (let i = 0; i < toDispatch.length; i++) {
      const task = toDispatch[i];
      const worker = idle[i];
      graph.markRunning(task.id);
      store.updateTask(task.id, { status: "running", workerId: worker.id });

      dispatched.push(
        worker.run(task, buildWorkerContext(graph, task)).then(
          (result) => {
            graph.markDone(task.id, result);
            store.updateTask(task.id, { status: "done", result });
            propagateFeatureStatus(graph, task.featureId, store);
          },
          (err) => {
            graph.markFailed(task.id, err);
            store.updateTask(task.id, { status: "failed", error: err.message });
            // Orchestrator schedules retry via retry.ts (exponential backoff)
            // or marks blocked after maxConsecutiveFailures
          }
        )
      );
    }

    // Unblocks as soon as ANY dispatched task completes → immediate re-evaluation
    if (dispatched.length > 0) {
      await Promise.race(dispatched);
    } else {
      // All tasks blocked or running — wait for any running task to finish
      await pool.waitForAnyCompletion();
    }
  }
}
```

---

## Component Map

```
gsd2/
├── src/
│   ├── graph/
│   │   ├── types.ts          -- Milestone, Feature, Task, status types
│   │   ├── feature-graph.ts  -- FeatureGraph: DAG + all mutations + validation
│   │   └── critical-path.ts  -- critical path weight computation
│   ├── scheduler/
│   │   ├── scheduler.ts      -- main loop: frontier → dispatch → collect
│   │   ├── worker-pool.ts    -- child process lifecycle, max concurrency
│   │   ├── retry.ts          -- exponential backoff retry scheduling
│   │   ├── context.ts        -- build WorkerContext per task (injects CODEBASE.md, KNOWLEDGE.md, DECISIONS.md; regenerates CODEBASE.md on demand)
│   │   └── model-router.ts   -- dynamic model routing (tier → model selection)
│   ├── worker/
│   │   ├── entry.ts          -- child process entry point
│   │   ├── worker.ts         -- pi-sdk Agent wrapper
│   │   ├── submit.ts         -- submit tool + verification runner
│   │   ├── harness.ts        -- SessionHarness interface + PiSdkHarness + ClaudeCodeHarness
│   │   └── tools/            -- standard tools + append_knowledge + record_decision
│   ├── ipc/
│   │   ├── types.ts          -- WorkerMessage, OrchestratorMessage
│   │   ├── transport.ts      -- IpcTransport interface
│   │   └── ndjson.ts         -- NdjsonStdioTransport (default)
│   ├── tui/
│   │   ├── dag-view.ts       -- DagView component
│   │   ├── status-bar.ts     -- StatusBar component
│   │   └── agent-monitor.ts  -- AgentMonitorOverlay: live worker output + steer
│   ├── planner/
│   │   └── planner.ts        -- pi-sdk Agent with graph-mutation tools
│   ├── persistence/
│   │   ├── store.ts          -- Store interface
│   │   └── sqlite.ts         -- SQLite implementation
│   └── cli.ts                -- entry point
├── package.json
└── tsconfig.json
```

## Retry: Exponential Backoff up to 1 Week

Task-level retry is handled by the orchestrator. When a task fails, the orchestrator schedules a retry with exponential backoff. The ceiling is 1 week to handle quota resets.

```typescript
interface RetryPolicy {
  baseDelayMs: number;   // default: 1000
  maxDelayMs: number;    // default: 7 * 24 * 60 * 60 * 1000 (1 week)
  jitter: boolean;       // default: true (±10%)
}

function nextRetryDelay(attempt: number, policy: RetryPolicy): number {
  const exp = policy.baseDelayMs * 2 ** attempt;
  const capped = Math.min(exp, policy.maxDelayMs);
  return policy.jitter ? capped * (0.9 + Math.random() * 0.2) : capped;
}
```

Retry triggers: provider overload, rate limit, quota exhausted, 5xx, network errors.
No retry: verification failures (agent must fix and resubmit).
Retry state persisted in SQLite so retries survive orchestrator restarts.

---

## Verification: The `submit` Tool

Workers complete by calling a `submit` tool — the only way to mark a task done. Submit runs verification checks before accepting. Failures are returned as tool result text; the agent loop continues and must fix issues before resubmitting.

```typescript
const submitTool: AgentTool = {
  name: "submit",
  label: "Submit task",
  description: "Mark this task complete. Runs verification checks first.",
  schema: Type.Object({
    summary: Type.String(),
    filesChanged: Type.Array(Type.String()),
  }),
  execute: async (toolCallId, { summary, filesChanged }, signal) => {
    const checks = await runVerificationChecks(signal);
    if (checks.failed.length > 0) {
      return {
        content: [{ type: "text", text:
          `Verification failed. Fix these issues before submitting:\n\n${formatFailures(checks.failed)}`
        }],
        details: { verified: false, failures: checks.failed },
      };
    }
    ipc.send({ type: "result", taskId, summary, filesChanged });
    return {
      content: [{ type: "text", text: "Task submitted successfully." }],
      details: { verified: true },
    };
  },
};
```

### Verification Config

```jsonc
// .gsd2/config.json
{
  "verification": {
    "checks": [
      { "description": "TypeScript compiles", "command": "tsc --noEmit" },
      { "description": "Tests pass",          "command": "npm test" },
      { "description": "Lint clean",          "command": "eslint src/" }
    ],
    "timeoutSecs": 120,
    "continueOnFail": false
  }
}
```

Each check runs in the task's worktree. stdout+stderr is captured and included in the failure message fed back to the agent.

---

## Progress TUI

Built on `@mariozechner/pi-tui`. Redraws on state change (not fixed frame rate) using differential rendering.

```
┌─────────────────────────────────────────────────────┐
│ gsd2  goal: "implement auth system"   cost: $1.23   │
├─────────────────────────────────────────────────────┤
│  M1: Core Infrastructure          [3/5 done]        │
│  ├── ✓ F-db: Database schema                        │
│  ├── ✓ F-models: Data models                        │
│  ├── ⟳ F-auth: Auth middleware     [running 0:42]   │
│  │   ├── ✓ Task: JWT validation                     │
│  │   ├── ⟳ Task: Session store     [worker-3]       │
│  │   └── · Task: Middleware wiring [waiting]        │
│  ├── · F-api: REST endpoints       [blocked]        │
│  └── · F-ui: Login page            [blocked]        │
│  M2: Testing                       [0/2 done]       │
│  └── · F-tests: Integration tests  [blocked on M1]  │
├─────────────────────────────────────────────────────┤
│ workers: 3 running  2 idle   tasks: 4/12 done       │
└─────────────────────────────────────────────────────┘
```

Icons: `✓` done  `⟳` running  `·` pending  `✗` failed  `⊘` cancelled  `↺` retrying (with delay)

```typescript
class DagView implements Component {
  render(width: number): string[] { /* milestone tree with status icons */ }
  invalidate(): void {}
}
class StatusBar implements Component {
  render(width: number): string[] { /* "workers: N running  tasks: X/Y  cost: $Z" */ }
  invalidate(): void {}
}
```

---

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
| `p` | Replan — trigger replanner for a blocked/failed feature |
| `x` | Cancel feature (with cascade prompt) |
| `e` | Edit feature (name, description, tasks) |
| `d` | Show feature dependency detail |
| `c` | Regenerate codebase map (`.gsd2/CODEBASE.md`) |
| `q` | Quit |

---

## Budget

Configurable per-task and global USD ceilings. Workers report token usage via IPC after each LLM call; orchestrator accumulates and enforces limits.

```jsonc
// .gsd2/config.json
{
  "budget": {
    "globalUsd": 50.00,      // halt all workers when exceeded
    "perTaskUsd": 2.00,      // abort individual task when exceeded
    "warnAtPercent": 80      // emit warning event at 80% of global budget
  }
}
```

```typescript
// Orchestrator checks after each cost IPC message
function checkBudget(state: BudgetState, config: BudgetConfig): BudgetAction {
  if (state.totalUsd >= config.globalUsd) return "halt";
  if (state.totalUsd >= config.globalUsd * config.warnAtPercent / 100) return "warn";
  return "ok";
}
```

When global budget is hit: pause all workers, emit `budget_exceeded` event, show in TUI. User can raise the ceiling and resume.

---

## File-Lock Conflict Resolution

Workers run in isolated git worktrees but may edit the same files (e.g. shared config, index files). The orchestrator periodically scans all active worktrees for changed files and detects overlaps.

### Mechanism

```
Orchestrator polls every N seconds (default: 30):
  1. For each active worktree, run: git diff --name-only HEAD
  2. Build map: file → [worktree1, worktree2, ...]
  3. For any file touched by 2+ worktrees:
     a. Count changes per worktree (git diff --stat)
     b. Suspend the worktree with FEWER changes (SIGSTOP to child process)
     c. Record the suspension in SQLite with reason + suspended files
     d. Notify suspended worker via IPC before SIGSTOP:
        { type: "suspend", reason: "file_lock", files: ["src/index.ts"] }
```

### Resolution

When the larger-change worktree completes its task:
1. Merge its branch to main
2. For each suspended worktree that was blocked on those files:
   a. Rebase worktree branch onto updated main
   b. If rebase has conflicts on the locked files: reset those files to main's version, record which files were reset
   c. Send resume IPC message to worker:
      ```
      { type: "resume", filesReset: ["src/index.ts"], reason: "file_lock released" }
      ```
   d. SIGCONT the child process
3. Worker agent receives the resume message as a steering injection and continues with awareness of what changed

### Worker-side handling

The `submit` tool checks for a pending resume message before running verification. If files were reset, the failure message includes which files need re-examination.

The orchestrator injects the resume notification as a pi-sdk `steer()` call after SIGCONT:

```typescript
agent.steer({
  role: "user",
  content: [{ type: "text", text:
    `Work was paused due to a file edit lock on: ${filesReset.join(", ")}.\n` +
    `These files were reset to the merged version from another task. ` +
    `Please review the current state of these files and continue your work.`
  }],
  timestamp: Date.now(),
});
```

### SQLite

Suspension fields are part of the main `tasks` schema (see Persistence section).

---

## Dynamic Model Routing

Each task type is assigned a complexity tier. The router selects the best-fit model within that tier, never exceeding the user's configured ceiling model.

| Tier | Task Types | Default Model |
|---|---|---|
| **heavy** | planning, replanning, roadmap reassessment | Opus-class |
| **standard** | task execution, research | Sonnet-class |
| **light** | verification, completion summaries, codebase map generation | Haiku-class |

```typescript
type RoutingTier = "heavy" | "standard" | "light";

function routeModel(tier: RoutingTier, config: ModelRoutingConfig): Model {
  // Never exceed user's ceiling model
  // Escalate tier on repeated task failure (escalate_on_failure)
  // Downgrade toward light when approaching budget ceiling (budget_pressure)
}
```

Config in `.gsd2/config.json`:
```jsonc
{
  "modelRouting": {
    "enabled": true,
    "ceiling": "claude-opus-4-6",
    "tiers": {
      "heavy":    "claude-opus-4-6",
      "standard": "claude-sonnet-4-6",
      "light":    "claude-haiku-4-5"
    },
    "escalateOnFailure": true,
    "budgetPressure": true
  }
}
```

---

## Token Profiles

A single config knob that coordinates model selection, context compression, and phase skipping. Adapted from GSD-2.

| Profile | Models | Context | Phases | Savings |
|---|---|---|---|---|
| **budget** | Sonnet/Haiku | minimal | skip `discussing` + `researching` + `summarizing` | 40-60% |
| **balanced** (default) | user default | standard | skip `discussing` + `researching` | ~20% |
| **quality** | user default | full | all phases run | 0% |

```jsonc
{ "tokenProfile": "balanced" }
```

Context inline levels per profile:
- **minimal** — task description + essential prior summaries only
- **standard** — task plan + prior summaries + slice plan + roadmap excerpt
- **full** — everything: plans, summaries, decisions register, KNOWLEDGE.md, codebase map

---

## Crash Recovery

On startup, gsd2 scans for orphaned tasks (status `running` with no live worker process) and resets them. Worker sessions are persisted so execution can resume from where it left off.

### Session Harness Abstraction

Workers are wrapped in a harness that abstracts the underlying session provider. This allows resuming from different session backends.

```typescript
interface SessionHarness {
  /** Start a new session for a task */
  start(task: Task, context: WorkerContext): Promise<SessionHandle>;
  /** Resume an existing session by stored ID */
  resume(sessionId: string, task: Task): Promise<SessionHandle>;
  /** Persist session state for crash recovery */
  persist(handle: SessionHandle): Promise<void>;
}

interface SessionHandle {
  sessionId: string;
  agent: Agent;
  abort(): void;
}

// Implementations
class PiSdkHarness implements SessionHarness { /* default */ }
class ClaudeCodeHarness implements SessionHarness { /* resumes claude code sessions */ }
```

Session IDs are stored in the `tasks` table (`session_id TEXT`). On startup:

```typescript
async function recoverOrphanedTasks(store: Store, pool: WorkerPool) {
  const orphaned = await store.getTasksByStatus("running");
  for (const task of orphaned) {
    if (task.sessionId) {
      // Resume from saved session
      pool.dispatch(task, { resume: true, sessionId: task.sessionId });
    } else {
      // No session to resume — reset to pending
      await store.updateTask(task.id, { status: "pending", workerId: null });
    }
  }
}
```

SQLite addition: `session_id TEXT` is part of the main `tasks` schema (see Persistence section).

---

## Codebase Map

A lightweight project structure summary written to `.gsd2/CODEBASE.md`. Generated once per orchestrator run (or on demand via `c` key in TUI), regenerated when the file tree changes significantly.

Generated by a `light`-tier model call at session start. Contents injected into `WorkerContext.codebaseMap`. Workers use it to orient without spending tool calls reading the filesystem.

```
.gsd2/CODEBASE.md contents:
- Key directories and their purpose
- Entry points
- Conventions (naming, file structure)
- Truncated source file tree
```

---

## KNOWLEDGE.md

Append-only file at `.gsd2/KNOWLEDGE.md`. Workers read it at task start (injected into system prompt). Workers append to it when they discover recurring patterns, non-obvious constraints, or rules future tasks should follow.

```typescript
// Tool available to all workers
const appendKnowledgeTool: AgentTool = {
  name: "append_knowledge",
  description: "Record a project rule, pattern, or lesson for future tasks.",
  schema: Type.Object({ entry: Type.String() }),
  execute: async (_, { entry }) => {
    await fs.appendFile(".gsd2/KNOWLEDGE.md", `\n- ${entry}\n`);
    return { content: [{ type: "text", text: "Recorded." }], details: {} };
  },
};
```

---

## Decisions Register

Append-only file at `.gsd2/DECISIONS.md`. Records significant architectural decisions made during execution. Prevents parallel workers from making contradictory choices.

```typescript
const recordDecisionTool: AgentTool = {
  name: "record_decision",
  description: "Record an architectural decision that other tasks should respect.",
  schema: Type.Object({
    decision: Type.String(),
    rationale: Type.String(),
  }),
  execute: async (_, { decision, rationale }) => {
    const entry = `\n## ${new Date().toISOString()}\n**Decision:** ${decision}\n**Rationale:** ${rationale}\n`;
    await fs.appendFile(".gsd2/DECISIONS.md", entry);
    return { content: [{ type: "text", text: "Decision recorded." }], details: {} };
  },
};
```

Both files are injected into `WorkerContext` under the `standard` and `quality` token profiles. Omitted under `budget`.

---

## Agent Monitor View

A TUI overlay (press `m`) showing all running workers with their live output streams. Each worker's pi-sdk `progress` IPC messages are displayed in a scrollable pane. Users can select a worker and steer it in real time.

```
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

  // Fed by orchestrator forwarding worker "progress" IPC messages
  onProgress(workerId: string, message: string): void {
    const lines = this.logs.get(workerId) ?? [];
    lines.push(message);
    if (lines.length > 200) lines.shift(); // rolling buffer
    this.logs.set(workerId, lines);
    this.invalidate();
  }

  render(width: number): string[] { /* two-pane layout */ }
  invalidate(): void {}
}
```

---

## Planner: Tool-Call Output Format

The planner is a pi-sdk `Agent` with access to the feature-graph mutation tools. It builds the DAG incrementally via tool calls rather than emitting a JSON blob. This means the graph is validated as it's constructed (no cycles, referential integrity) and the planner can reason step-by-step.

```typescript
// Tools exposed to the planner agent
const plannerTools: AgentTool[] = [
  createMilestoneTool,   // createMilestone(name, description) → Milestone
  createFeatureTool,     // createFeature(milestoneId, name, description, dependsOn[]) → Feature
  createTaskTool,        // createTask(featureId, description, dependsOn[]) → Task
  addDependencyTool,     // addDependency(fromId, toId) → void
  submitPlanTool,        // submit() → signals planner is done
];
```

The planner receives the spec text as its prompt and calls these tools to build the graph. The orchestrator watches the graph grow in real time and renders it in the TUI as it's constructed.

For `add-milestone`, the planner receives the current graph state (existing milestones/features as context) plus the new spec, and adds to the existing graph.

---

## Stuck Detection

A task is "stuck" when it repeatedly fails verification and resubmits without making progress. Detected by counting consecutive submit-failures per task.

```typescript
interface StuckPolicy {
  maxConsecutiveFailures: number;  // default: 5
}
```

When `maxConsecutiveFailures` is reached:
1. Worker is suspended (SIGSTOP)
2. Task enters `blocked` status in the DAG
3. TUI highlights the task with `⊘ blocked` and shows the last verification failure
4. User can: **steer** (inject a message and resume), **skip** (cancel the task), or **replan** (trigger replanning for the feature)

---

## Replanning

Triggered manually (user presses `p` on a blocked/failed feature) or automatically when a feature fails after exhausting retries.

The replanner is a pi-sdk `Agent` with the same feature-graph tools as the planner, plus read access to the current graph state and the failure context. It can:
- Split the failed feature into smaller subfeatures
- Add/remove dependencies
- Edit task descriptions
- Cancel the feature and add an alternative

Running workers are not interrupted during replanning. The replanner only mutates pending/failed nodes.

```typescript
// Replanner prompt includes:
// - Current graph state (serialized)
// - Failed feature + its tasks + last error output
// - Instruction: "Restructure this feature to make it achievable"
```

After replanning, the scheduler re-evaluates the frontier and dispatches newly ready tasks.

---

## Testing

### Unit Tests

Vitest unit tests for pure logic — no LLM calls, no child processes.

Key targets:
- `graph/feature-graph.ts` — DAG mutations, cycle detection, frontier computation
- `graph/critical-path.ts` — critical path weight calculation
- `scheduler/retry.ts` — backoff math, jitter bounds
- `scheduler/model-router.ts` — tier selection, ceiling enforcement, budget pressure
- `ipc/ndjson.ts` — message framing, partial line handling

### Integration Tests: pi-sdk Faux Provider

Integration tests use pi-sdk's `fauxModel` + scripted `FauxResponse` sequences as the `streamFn`. This runs a real `Agent` loop with real tool dispatch — no API calls, deterministic responses.

```typescript
import { Agent } from "@mariozechner/pi-agent-core";
import { fauxStreamFn, fauxModel } from "../test/utils/faux-stream.js";

test("worker calls submit after passing verification", async () => {
  const agent = new Agent({
    initialState: { model: fauxModel, tools: workerTools },
    streamFn: fauxStreamFn([
      { toolCalls: [{ name: "submit", args: { summary: "done", filesChanged: [] } }] },
      { text: "Task complete." },
    ]),
  });
  await agent.prompt("Implement the feature.");
});
```

Integration test targets:
- Worker submit → verification pass/fail loop
- Worker suspend/resume IPC flow
- Planner builds valid DAG via tool calls
- Scheduler dispatches correct frontier after task completion
- Crash recovery: orphaned `running` tasks reset or resumed on startup

### Test Utilities

```
gsd2/
├── test/
│   ├── utils/
│   │   ├── faux-stream.ts    -- fauxModel + fauxStreamFn (wraps pi-sdk faux provider)
│   │   ├── graph-builders.ts -- helpers to build test FeatureGraphs
│   │   └── store-memory.ts   -- in-memory Store (no SQLite needed in tests)
│   ├── unit/
│   └── integration/
```
