# Worker Model

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the high-level architecture overview.

## Worker Model: Process-per-Task

Each task spawns a dedicated child process using the Node.js
process APIs; workers are wrapped behind the `SessionHarness`
interface, whose baseline implementation is `PiSdkHarness`.
Workers are pi-sdk `Agent` instances running in isolated git
worktrees that branch from the owning feature branch.
Each worker receives the task's reserved write paths as prompt
context.
Reservations are advisory metadata; on the first write attempt
for a path, the write prehook tries to claim an active path lock
through the orchestrator.
If the claim succeeds, the write proceeds.
If the path is already locked, the orchestrator routes the
incident into the normal coordination flow
(same-feature overlap handling for the same feature,
cross-feature overlap handling for another feature).
Active path locks are released when the task pauses or exits,
so only files being actively edited hold runtime ownership.

```text
main
└── feat-<feature-id>
    ├── Worker 1 (worktree: .gvc0/worktrees/feat-<feature-id>-task-<task-id-a>/)
    │   └── pi-sdk Agent → executes first runnable task
    ├── Worker 2 (worktree: .gvc0/worktrees/feat-<feature-id>-task-<task-id-b>/)
    │   └── pi-sdk Agent → executes second runnable task
    └── Worker 3 (worktree: .gvc0/worktrees/feat-<feature-id>-task-<task-id-c>/)
        └── pi-sdk Agent → executes third runnable task
```

- **Max concurrency**: configurable (default: CPU count or provider rate limit, whichever is lower)
- **Worktree lifecycle**: created on dispatch from the
  feature branch, using the same basename as the task branch
  (`feat-<feature-id>-task-<task-id>`), squash-merged back into
  the feature branch on success, and retained until the owning
  feature lands on `main` or garbage collection snapshots and
  removes the stale worktree

### Git Commit Strategy

Workers make incremental commits inside their worktree as they
work (conventional commits: `feat:`, `fix:`, etc.).
On task completion, the orchestrator squash-merges the worktree
branch into the owning feature branch as a single commit with
the task summary as the message.
Once feature work is complete, the merge train serializes
feature-branch integration into `main`.

The branch names and commit subjects below are illustrative placeholders.

```text
task branch in its task worktree (feat-<feature-id>-task-<task-id>):
  feat: add <first incremental change>
  feat: implement <second incremental change>
  fix: handle <edge case>
  test: add <targeted coverage>
         ↓ squash merge
feat-<feature-id>:
  feat(<feature-scope>): implement <task summary> [task-<task-id>]
         ↓ merge train
main:
  feat(<feature-scope>): merge feat-<feature-id>
```

## Feature Branch Integration

Each feature owns exactly one long-lived integration branch.

1. When a feature branch is requested, the orchestrator creates
   `feat-<feature-id>` from the current `main`
   and opens its feature worktree.
2. Task worktrees use branch names
   `feat-<feature-id>-task-<task-id>` and branch from the current
   HEAD of `feat-<feature-id>`.
3. Task completion is finalized by `confirm()`,
   which merges into `feat-<feature-id>` after `submit()`
   preflight has passed.
4. After the last task or repair task lands, the feature runs
   `feature_ci` on the feature branch,
   then agent-level `verifying`.
5. If that path passes, feature work control becomes
   `awaiting_merge` and feature collaboration control may become
   `merge_queued`.
6. The merge train rebases the feature branch onto the latest
   `main`, runs merge-train verification, and either merges or
   removes the feature from the merge train for same-branch repair.
7. After collaboration control reaches `merged`,
   the feature normally runs blocking `summarizing`
   and then reaches `work_complete`;
   in budget mode it may instead skip summarizing,
   leave summary text empty,
   and move directly to `work_complete`.
8. Same-feature task conflicts use a two-stage baseline:
   fail-closed mechanical rebase first,
   then task-local agent reconciliation with injected conflict
   context if git cannot resolve cleanly.

## IPC: NDJSON over stdio (swappable)

Workers communicate with the orchestrator via
newline-delimited JSON on stdin/stdout.
For the baseline local-machine architecture,
plain stdio IPC is sufficient; stronger delivery guarantees,
acknowledgments, and explicit backpressure handling are deferred.
See [Feature Candidate: Advanced IPC Guarantees](./feature-candidates/advanced-ipc-guarantees.md).

```typescript
type TaskRuntimeDispatch =
  | { mode: "start"; agentRunId: string }
  | { mode: "resume"; agentRunId: string; sessionId: string };

type RuntimeSteeringDirective =
  | { kind: "sync_recommended"; timing: "next_checkpoint" | "immediate" }
  | { kind: "sync_required"; timing: "next_checkpoint" | "immediate" }
  | {
      kind: "conflict_steer";
      timing: "next_checkpoint" | "immediate";
      gitConflictContext: GitConflictContext;
    };

interface RuntimeUsageDelta {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  audioInputTokens?: number;
  audioOutputTokens?: number;
  totalTokens: number;
  usd: number;
  rawUsage?: unknown;
}

type ApprovalDecision =
  | { kind: "approved" }
  | { kind: "approve_always" }
  | { kind: "reject"; comment?: string }
  | { kind: "discuss" };

type HelpResponse =
  | { kind: "answer"; text: string }
  | { kind: "discuss" };

// Worker → Orchestrator
type WorkerToOrchestratorMessage =
  | { type: "progress"; taskId: string; agentRunId: string; message: string }
  | {
      type: "result";
      taskId: string;
      agentRunId: string;
      result: TaskResult;
      usage: RuntimeUsageDelta;
    }
  | {
      type: "error";
      taskId: string;
      agentRunId: string;
      error: string;
      usage?: RuntimeUsageDelta;
    }
  | { type: "request_help"; taskId: string; agentRunId: string; query: string }
  | {
      type: "request_approval";
      taskId: string;
      agentRunId: string;
      payload: ApprovalPayload;
    }
  | {
      type: "assistant_output";
      taskId: string;
      agentRunId: string;
      text: string;
    };

// Orchestrator → Worker
type OrchestratorToWorkerMessage =
  | {
      type: "run";
      taskId: string;
      agentRunId: string;
      dispatch: TaskRuntimeDispatch;
      task: Task;
      context: WorkerContext;
    }
  | {
      type: "steer";
      taskId: string;
      agentRunId: string;
      directive: RuntimeSteeringDirective;
    }
  | {
      type: "suspend";
      taskId: string;
      agentRunId: string;
      reason: "same_feature_overlap" | "cross_feature_overlap";
      files: string[];
    }
  | {
      type: "resume";
      taskId: string;
      agentRunId: string;
      reason: "same_feature_rebase" | "cross_feature_rebase" | "manual";
    }
  | { type: "abort"; taskId: string; agentRunId: string }
  | {
      type: "help_response";
      taskId: string;
      agentRunId: string;
      response: HelpResponse;
    }
  | {
      type: "approval_decision";
      taskId: string;
      agentRunId: string;
      decision: ApprovalDecision;
    }
  | { type: "manual_input"; taskId: string; agentRunId: string; text: string };
```

The `suspend` / `resume` messages are a general
**collaboration-control** mechanism.
Same-feature overlap and cross-feature overlap both use them for live
runtime coordination.
The task-scoped `resume` control path is only for live in-memory worker
state; authoritative restart recovery goes back through `run` with
`dispatch.mode = "resume"` plus the persisted `sessionId`.
If a task rebase cannot be auto-resolved with `ort` merge or similar,
the orchestrator keeps the task in `conflict`
collaboration control and uses a typed steering directive to inject the
exact git conflict context instead of resetting files.
Worker wait-state reporting stays semantic and explicit:
`request_help`, `request_approval`, and `assistant_output` report live
interaction needs, while `help_response`, `approval_decision`, and
`manual_input` carry operator responses back into the worker.
Terminal `result` / `error` messages may include a runtime-owned usage
delta for that attempt.
This transport does not carry extra task enums for retry/help/approval;
those remain execution-run concerns on `agent_runs`, while task status
stays coarse and `blocked` remains derived in the UI.
See [Conflict Coordination](./operations/conflict-coordination.md)
for the recommendation/required-sync/escalation ladder.

### Transport Abstraction

```typescript
interface IpcTransport {
  send(msg: OrchestratorToWorkerMessage): void;
  onMessage(handler: (msg: WorkerToOrchestratorMessage) => void): void;
  close(): void;
}

class NdjsonStdioTransport implements IpcTransport { /* ... */ }
class UnixSocketTransport implements IpcTransport { /* ... */ }
```

Default is `NdjsonStdioTransport`.
The message shapes stay transport-agnostic rather than stdio-specific,
so a future migration to a network transport is tractable without
redesigning the runtime seam.
See [Feature Candidate: Distributed Runtime](./feature-candidates/distributed-runtime.md).

## Context Strategy: Configurable (default: shared read-only summary)

Each worker receives context about the overall plan and
completed dependency outputs.
Context assembly is configured in `.gvc0/config.json`
with global defaults plus stage-specific overrides.

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
      "feature_ci": {
        "strategy": "shared-summary",
        "includeCodebaseMap": true
      },
      "verifying": {
        "strategy": "shared-summary",
        "includeKnowledge": true,
        "includeDecisions": true,
        "includeCodebaseMap": true
      },
      "executing_repair": {
        "strategy": "inherit",
        "includeKnowledge": true,
        "includeDecisions": true,
        "includeCodebaseMap": true
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

On startup, gvc0 scans the persisted feature/task/run tables
for orphaned work (task execution runs or feature-phase runs
with `run_status = "running"` but no live worker process)
and resets or resumes them.
Feature branches remain authoritative across restarts;
resumed task worktrees rebase onto the current HEAD of the
owning feature branch before continuing.
The baseline uses `PiSdkHarness` only;
`session_id` is an orchestrator-owned opaque reference passed
back to the harness, and a future external session service may
interpret/map those IDs without changing the main task schema.
On shutdown, the orchestrator stops accepting new scheduler work,
halts the scheduler loop, and attempts to stop all active tasks
cleanly before exit.

### Session Harness Abstraction

Workers are wrapped in a harness that abstracts the
underlying session provider.
The baseline uses `PiSdkHarness`, which runs pi-sdk `Agent`
instances directly and is the contract the rest of the
orchestrator should target so future backends
(for example `ClaudeCodeHarness`) can slot in without changing
scheduler logic.
The orchestrator should depend only on this harness interface
plus pi-sdk's tool/model contracts,
not on provider-specific session details.

```typescript
interface SessionHandle {
  sessionId: string;
  abort(): void;
  sendInput(text: string): Promise<void>;
  send(message: OrchestratorToWorkerMessage): void;
  onWorkerMessage(handler: (message: WorkerToOrchestratorMessage) => void): void;
}

type ResumeSessionResult =
  | { kind: "resumed"; handle: SessionHandle }
  | {
      kind: "not_resumable";
      sessionId: string;
      reason: "session_not_found" | "path_mismatch" | "unsupported_by_harness";
    };

interface SessionHarness {
  /** Start a new session for a task */
  start(task: Task, context: WorkerContext): Promise<SessionHandle>;
  /** Resume from authoritative persisted run/session state */
  resume(task: Task, run: ResumableTaskExecutionRunRef): Promise<ResumeSessionResult>;
}

// Baseline implementation
class PiSdkHarness implements SessionHarness { /* default — native pi-sdk Agent loop */ }
```

A `ClaudeCodeHarness` that wraps Claude Code sessions as worker backends is a [feature candidate](./feature-candidates/claude-code-harness.md), not part of the baseline.

Session IDs are stored as orchestrator-owned opaque references.
`agent_runs.session_id` is the authoritative resumable pointer
for both task execution runs and feature-phase runs;
`tasks.session_id` remains the task-facing compatibility field
for execution runs.
If a separate session service is ever introduced,
it may map those IDs onto provider-specific underlying sessions
without changing the main task schema.
Runtime live control remains task-scoped at the orchestrator seam,
while the runtime internally maps live task execution to
`agentRunId` / `sessionId` state.
On startup:

```typescript
async function recoverOrphanedTasks(store: Store, pool: WorkerPool) {
  const orphaned = await store.listAgentRuns({
    scopeType: "task",
    runStatus: "running",
  });

  for (const run of orphaned) {
    if (run.sessionId) {
      // Resume from saved session, rebasing onto current feature branch HEAD first
      await pool.dispatchTask(task, {
        mode: "resume",
        agentRunId: run.id,
        sessionId: run.sessionId,
      });
    } else {
      // No resumable session — reset to ready for a fresh run
      await store.updateAgentRun(run.id, { runStatus: "ready", owner: "system" });
    }
  }
}
```

SQLite addition: `feature_branch`, `worktree_branch`, and collaboration-control fields are part of the persisted schema (see [Architecture / Persistence](./architecture/persistence.md)).
