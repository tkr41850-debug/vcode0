# Worker Model

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the high-level architecture index.

## Worker Model: Process-per-Task

Each task spawns a dedicated child process using the Node.js process APIs; workers are wrapped behind the `SessionHarness` interface, whose baseline implementation is `PiSdkHarness`. Workers are pi-sdk `Agent` instances running in isolated git worktrees that branch from the owning feature branch. Each worker receives the task's reserved write paths as prompt context. Reservations are advisory metadata; active path locks are acquired lazily on the first write prehook for a path and released when the task pauses or exits, so only files being actively edited hold runtime ownership.

```text
main
└── feature/auth
    ├── Worker 1 (worktree: .gvc0/worktrees/task-jwt/)
    │   └── pi-sdk Agent → executes JWT validation
    ├── Worker 2 (worktree: .gvc0/worktrees/task-session/)
    │   └── pi-sdk Agent → executes session store
    └── Worker 3 (worktree: .gvc0/worktrees/task-middleware/)
        └── pi-sdk Agent → executes middleware wiring
```

- **Max concurrency**: configurable (default: CPU count or provider rate limit, whichever is lower)
- **Worktree lifecycle**: created on dispatch from the feature branch, squash-merged back into the feature branch on success, and retained until the owning feature lands on `main` or garbage collection snapshots and removes the stale worktree

### Git Commit Strategy

Workers make incremental commits inside their worktree as they work (conventional commits: `feat:`, `fix:`, etc.). On task completion, the orchestrator squash-merges the worktree branch into the owning feature branch as a single commit with the task summary as the message. Once feature work is complete, the merge train serializes feature-branch integration into `main`.

```text
task worktree branch (task-042):
  feat: add JWT types
  feat: implement token signing
  fix: handle expiry edge case
  test: add JWT unit tests
         ↓ squash merge
feature/auth:
  feat(auth): implement JWT signing and validation [task-042]
         ↓ merge train
main:
  feat(auth): merge feature/auth
```

## Feature Branch Integration

Each feature owns exactly one long-lived integration branch.

1. When a feature branch is requested, the orchestrator creates `feature/<feature-id>` from the current `main` and opens its feature worktree.
2. Task worktrees branch from the current HEAD of `feature/<feature-id>`.
3. Task completion merges into `feature/<feature-id>`.
4. When feature work control reaches `work_complete`, the orchestrator runs feature verification on the feature branch.
5. Only if feature verification passes does feature collaboration control become `merge_queued`.
6. The merge train rebases the feature branch onto the latest `main`, runs merge-train verification, and either merges or removes the feature from the queue for repair/retry on the same branch.
7. Same-feature task conflicts use a two-stage baseline: fail-closed mechanical rebase first, then task-local agent reconciliation with injected conflict context if git cannot resolve cleanly.

## IPC: NDJSON over stdio (swappable)

Workers communicate with the orchestrator via newline-delimited JSON on stdin/stdout.

```typescript
// Worker → Orchestrator
type WorkerMessage =
  | { type: "status"; taskId: string; status: TaskStatus }
  | { type: "progress"; taskId: string; message: string }
  | { type: "result"; taskId: string; summary: string; filesChanged: string[] }
  | { type: "error"; taskId: string; error: string }
  | { type: "cost"; taskId: string; usage: ProviderUsage }

interface ProviderUsage {
  provider: string;                // anthropic, openai, google, ...
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;        // exposed separately by some providers/models
  audioInputTokens?: number;
  audioOutputTokens?: number;
  totalTokens: number;
  usd: number;
  rawUsage?: unknown;              // provider response for audit / future fields
}

// Orchestrator → Worker
type OrchestratorMessage =
  | { type: "run"; task: Task; context: WorkerContext }
  | { type: "abort"; taskId: string }
  | { type: "steer"; taskId: string; message: string }
  | { type: "suspend"; taskId: string; reason: "file_lock"; files: string[] }
  | { type: "resume"; taskId: string; reason: string }
```

The `suspend` / `resume` messages are a **same-feature collaboration-control** mechanism. Cross-feature overlap uses a separate feature-pair protocol: reservation overlap applies only a scheduling penalty, while runtime overlap pauses the secondary feature's affected tasks, waits for the primary feature to land, then rebases and resumes the secondary side. If a task rebase cannot be auto-resolved with `ort` merge or similar, the orchestrator keeps the task in `conflict` collaboration control and uses `steer` to inject the exact conflict context instead of resetting files. `cost` messages are emitted after each provider call and should be treated as append-only accounting inputs; retries and failed attempts still count toward task and feature lifetime usage. See [Conflict Steering](./conflict-steering.md) for the recommendation/required-sync/escalation ladder.

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

Each worker receives context about the overall plan and completed dependency outputs. Context assembly is configured in `.gvc0/config.json` with global defaults plus stage-specific overrides.

| Strategy | Description | Config |
|---|---|---|
| **shared-summary** (default) | Workers get a read-only summary of the plan + completed dep outputs | `context.defaults.strategy: "shared-summary"` |
| **fresh** | Workers get only their task description, no dependency context | `context.defaults.strategy: "fresh"` |
| **inherit** | Workers receive the full transcript of their dependency tasks | `context.defaults.strategy: "inherit"` |

```jsonc
{
  "tokenProfile": "balanced",
  "context": {
    "defaults": {
      "strategy": "shared-summary",
      "includeKnowledge": true,
      "includeDecisions": true,
      "includeCodebaseMap": true,
      "maxDependencyOutputs": 8
    },
    "stages": {
      "researching": {
        "strategy": "fresh",
        "includeDecisions": false
      },
      "planning": {
        "strategy": "shared-summary",
        "includeCodebaseMap": true
      },
      "executing": {
        "strategy": "shared-summary"
      },
      "replanning": {
        "strategy": "inherit",
        "includeKnowledge": true,
        "includeDecisions": true,
        "includeCodebaseMap": true
      },
      "summarizing": {
        "includeKnowledge": false,
        "includeDecisions": false,
        "includeCodebaseMap": false
      }
    }
  }
}
```

Precedence:
1. built-in defaults
2. token-profile defaults
3. `context.defaults`
4. `context.stages[stage]` partial override for the current stage

```typescript
interface WorkerContext {
  strategy: "shared-summary" | "fresh" | "inherit";
  planSummary?: string;            // overall plan description
  dependencyOutputs?: DepOutput[]; // summaries from completed deps
  codebaseMap?: string;            // contents of .gvc0/CODEBASE.md
  knowledge?: string;              // contents of .gvc0/KNOWLEDGE.md
  decisions?: string;              // contents of .gvc0/DECISIONS.md
}

interface DepOutput {
  taskId: string;
  featureName: string;
  summary: string;                 // LLM-generated summary of what was done
  filesChanged: string[];          // paths modified by the dep task
}
```

## Crash Recovery

On startup, gvc0 scans for orphaned tasks (status `running` with no live worker process) and resets or resumes them. Feature branches remain authoritative across restarts; resumed task worktrees rebase onto the current HEAD of the owning feature branch before continuing. The baseline uses `PiSdkHarness` only; `session_id` is an orchestrator-owned opaque reference passed back to the harness, and a future external session service may interpret/map those IDs without changing the main task schema.

### Session Harness Abstraction

Workers are wrapped in a harness that abstracts the underlying session provider. The baseline uses `PiSdkHarness`, which runs pi-sdk `Agent` instances directly and is the contract the rest of the orchestrator should target so future backends (for example `ClaudeCodeHarness`) can slot in without changing scheduler logic. The orchestrator should depend only on this harness interface plus pi-sdk's tool/model contracts, not on provider-specific session details.

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

// Baseline implementation
class PiSdkHarness implements SessionHarness { /* default — native pi-sdk Agent loop */ }
```

A `ClaudeCodeHarness` that wraps Claude Code sessions as worker backends is a [feature candidate](./feature-candidates/claude-code-harness.md), not part of the baseline.

Session IDs are stored in the `tasks` table (`session_id TEXT`) as orchestrator-owned opaque references. If a separate session service is ever introduced, it may map those IDs onto provider-specific underlying sessions without changing the main task schema. On startup:

```typescript
async function recoverOrphanedTasks(store: Store, pool: WorkerPool) {
  const orphaned = await store.getTasksByStatus("running");
  for (const task of orphaned) {
    if (task.sessionId) {
      // Resume from saved session, rebasing onto current feature branch HEAD first
      pool.dispatch(task, { resume: true, sessionId: task.sessionId });
    } else {
      // No resumable session — reset to pending for a fresh run
      await store.updateTask(task.id, { status: "pending", workerId: null });
    }
  }
}
```

SQLite addition: `feature_branch`, `worktree_branch`, and collaboration-control fields are part of the persisted schema (see [persistence.md](./persistence.md)).
