# gsd2 Worker Model

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the high-level architecture index.

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

SQLite addition: `session_id TEXT` is part of the main `tasks` schema (see [persistence.md](./persistence.md)).
