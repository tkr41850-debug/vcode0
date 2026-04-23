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
└── feat-<slugified-name>-<feature-id>
    ├── Worker 1 (worktree: .gvc0/worktrees/feat-<slugified-name>-<feature-id>-<task-id-a>/)
    │   └── pi-sdk Agent → executes first runnable task
    ├── Worker 2 (worktree: .gvc0/worktrees/feat-<slugified-name>-<feature-id>-<task-id-b>/)
    │   └── pi-sdk Agent → executes second runnable task
    └── Worker 3 (worktree: .gvc0/worktrees/feat-<slugified-name>-<feature-id>-<task-id-c>/)
        └── pi-sdk Agent → executes third runnable task
```

- **Max concurrency**: configurable (default: CPU count or provider rate limit, whichever is lower)
- **Worktree lifecycle**: worktrees are created lazily on first
  dispatch by the orchestrator's scheduler — task worktrees when
  the task is dispatched, the feature worktree when a task or
  feature-phase agent first needs it. The feature *branch* is
  created eagerly when the feature advances to
  `workControl = 'executing'` with `collabControl = 'branch_open'`
  (the canonical branch-creation trigger in
  [data-model.md](./data-model.md) and the FSM); only the checkout
  directory is lazy. Task worktrees branch from feature branch HEAD
  using the same basename as the task branch
  (`feat-<slugified-name>-<feature-id>-<task-id>`), squash-merged
  back into the feature branch on success, and retained until the
  owning feature lands on `main` or garbage collection snapshots
  and removes the stale worktree. Stale-worktree GC should preserve
  resumability by first creating a reversible `WIP snapshot`
  commit with a dedicated snapshot author/email; when that
  worktree/branch is later reloaded, the synthetic snapshot commit
  is undone so the work resumes as uncommitted state rather than as
  a normal authored commit.

### Git Commit Strategy

Workers make incremental commits inside their worktree as they
work (conventional commits: `feat:`, `fix:`, etc.).
On task completion, the orchestrator squash-merges the worktree
branch into the owning feature branch as a single commit with
the task summary as the message.
Once feature work is complete, the merge train serializes
feature-branch integration into `main`.

The branch names and commit subjects below are illustrative placeholders.
Canonical naming comes from `featureBranchName()` and `taskBranchName()` in `src/core/naming/index.ts`, which produce `feat-<slugified-name>-<feature-id>` and `feat-<slugified-name>-<feature-id>-<task-id>` with typed prefixes stripped from the ids.

```text
task branch in its task worktree (feat-<slugified-name>-<feature-id>-<task-id>):
  feat: add <first incremental change>
  feat: implement <second incremental change>
  fix: handle <edge case>
  test: add <targeted coverage>
         ↓ squash merge
feat-<slugified-name>-<feature-id>:
  feat(<feature-scope>): implement <task summary> [task-<task-id>]
         ↓ merge train
main:
  feat(<feature-scope>): merge feat-<slugified-name>-<feature-id>
```

## Feature Branch Integration

Each feature owns exactly one long-lived integration branch.

1. When a feature branch is requested, the orchestrator creates
   `feat-<slugified-name>-<feature-id>` from the current `main`
   and opens its feature worktree.
2. Task worktrees use branch names
   `feat-<slugified-name>-<feature-id>-<task-id>` and branch from the current
   HEAD of `feat-<slugified-name>-<feature-id>`.
3. Worker `submit(summary, filesChanged)` is the explicit task-complete signal.
   `confirm()` is only a progress acknowledgement. The orchestrator treats
   terminal results with `completionKind === 'submitted'` as landed task work
   on the feature branch.
4. After the last task or repair task lands, the feature runs
   `ci_check` on the feature branch (pre-verify),
   then agent-level `verifying`.
5. If that path passes, feature work control becomes
   `awaiting_merge` and feature collaboration control may become
   `merge_queued`.
6. The in-process integration executor (see below) moves the queue head
   through `integrating` and either lands it on `main` or ejects to
   `replanning`.
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

### Integration Executor: In-Process Subprocess

The orchestrator runs a dedicated **integration-worker subprocess**
per merge-train cycle. This is distinct from task workers and
distinct from the tick-synchronous cross-feature rebase path used
during task execution — integration runs asynchronously so
long-running post-rebase `ci_check` does not block the scheduler
loop.

Canonical sequence inside the executor:

```text
awaiting_merge → merge_queued → integrating
  ↓
  write integration marker row (expectedParentSha, featureBranchPreIntegrationSha,
                                config_snapshot of verification.feature, intent='integrate')
  ↓
  git rebase onto latest main   — fail → eject, reroute to replanning with source:'rebase'
  ↓
  post-rebase ci_check          — fail → eject, reroute to replanning with
                                         source:'ci_check', phase:'post_rebase'
  ↓
  git merge --no-ff --force-with-lease=<expectedParentSha>
  ↓
  atomic DB tx: clear marker + set mainMergeSha/branchHeadSha +
                collabControl='merged' + workControl='summarizing'
  ↓
merged → summarizing → work_complete
```

Re-enqueue after eject uses `git rebase --onto <newMain>
<featureBranchPreIntegrationSha> HEAD` so the stale first-rebase
layer drops; git `rerere` is enabled as a backstop.

Crash between `git merge` and the clearing DB tx is resolved by the
startup reconciler treating git refs as authoritative
(see [verification-and-recovery.md](../operations/verification-and-recovery.md)).

Integration-worker IPC carries progress and result frames for each
sub-phase (rebase, ci_check, merge); full frame schema lives with
the executor implementation.

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
      completionKind?: "submitted" | "implicit";
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
    }
  | {
      type: "claim_lock";
      taskId: string;
      agentRunId: string;
      claimId: string;
      paths: readonly string[];
    };

// Orchestrator → Worker
type OrchestratorToWorkerMessage =
  | {
      type: "run";
      taskId: string;
      agentRunId: string;
      dispatch: TaskRuntimeDispatch;
      task: Task;
      payload: TaskPayload;
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
  | { type: "manual_input"; taskId: string; agentRunId: string; text: string }
  | {
      type: "claim_decision";
      taskId: string;
      agentRunId: string;
      claimId: string;
      kind: "granted" | "denied";
      deniedPaths?: readonly string[];
    };
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

The `claim_lock` / `claim_decision` pair implements the write-prehook
lock flow described above. Each `claim_lock` carries a
worker-generated `claimId` so a single run can have multiple claims
in flight and route replies by id. The orchestrator answers with a
matching `claim_decision`; on `denied` the worker's write tool throws
a tool-level error, the run aborts, and the same
`ConflictCoordinator` entry points used by the preventive scheduler
scan (`handleSameFeatureOverlap`, `handleCrossFeatureOverlap`) fire —
so whether overlap is caught preventively at dispatch time or
reactively at first-write time, downstream suspend-and-rebase
behavior is identical. Locks release exit-driven: when a terminal
`result` or `error` message arrives, every lock held by that
`agentRunId` is dropped. Mid-run explicit release is tracked as an
[optimization candidate](./optimization-candidates/explicit-lock-release.md).
The active-lock registry lives beside `ConflictCoordinator` in the
scheduler loop (`src/orchestrator/scheduler/active-locks.ts`); the
runtime overlap detector it complements lives in
`src/orchestrator/scheduler/overlaps.ts`.

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

## Task Payload: Planner-Baked

Task workers do not assemble their own context at dispatch time.
The planner bakes per-task objective/scope/expectedFiles/references/
outcomeVerification onto each Task row, plus a feature-level
objective and Definition of Done on the owning Feature row. At
dispatch, runtime reads those columns and packages them into a
`TaskPayload` that rides the `run` IPC frame. The worker system
prompt is rendered from this payload.

Resume dispatch does not rebuild payload state — session history
already carries the task's working context. Runtime passes an empty
payload on resume; the planner-baked fields remain on the Task row
if anything later needs them.

```typescript
interface TaskPayload {
  objective?: string;
  scope?: string;
  expectedFiles?: readonly string[];
  references?: readonly string[];
  outcomeVerification?: string;
  featureObjective?: string;
  featureDoD?: readonly string[];
  planSummary?: string;
  dependencyOutputs?: DependencyOutputSummary[];
}

interface DependencyOutputSummary {
  taskId: string;
  featureName: string;
  summary: string;
  filesChanged: string[];
}
```

Knowledge and decisions injection is a feature-phase concern now
(see `docs/reference/knowledge-files.md`); runtime no longer assembles
them for task workers.

## Crash Recovery

On startup, gvc0 currently scans persisted task execution runs
for orphaned work (`scopeType = "task"` with `run_status = "running"`)
and resets or resumes them.
Feature branches remain authoritative across restarts;
resumed task worktrees rebase onto the current HEAD of the
owning feature branch before continuing.
Feature-phase runs share the same run/session model and session-store backing,
but the current startup recovery pass is task-run focused rather than a full
feature-phase orphan recovery sweep.
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
interface SessionExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

interface SessionHandle {
  sessionId: string;
  abort(): void;
  sendInput(text: string): Promise<void>;
  send(message: OrchestratorToWorkerMessage): void;
  onWorkerMessage(handler: (message: WorkerToOrchestratorMessage) => void): void;
  /** Fires once when the underlying worker exits (normally or via crash/error). */
  onExit(handler: (info: SessionExitInfo) => void): void;
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
  start(task: Task, payload: TaskPayload, agentRunId: string): Promise<SessionHandle>;
  /** Resume from authoritative persisted run/session state */
  resume(task: Task, run: ResumableTaskExecutionRunRef): Promise<ResumeSessionResult>;
}

// Baseline implementation
class PiSdkHarness implements SessionHarness { /* default — native pi-sdk Agent loop */ }
```

The harness owns child-exit detection: `PiSdkHarness` wires
`child.on('exit', …)` and `child.on('error', …)` through
`onExit`. When the worker pool receives an `onExit` while a
`liveRuns` entry is still present, it synthesizes a
`{ type: 'error', error: 'worker_exited: …' }` worker message so
the scheduler's existing completion path marks the run failed
instead of leaving it in `running` until the next startup
recovery pass. Normal completion deletes `liveRuns` first, so
subsequent exit fires as a no-op.

The harness also threads the orchestrator-supplied `agentRunId`
into every `OrchestratorToWorkerMessage` emitted on behalf of
the `SessionHandle` (`abort`, `manual_input`, `run`). Backend is
swappable, but the IDs on the wire are real.

A `ClaudeCodeHarness` that wraps Claude Code sessions as worker backends is a [feature candidate](./feature-candidates/claude-code-harness.md), not part of the baseline.

Session IDs are stored as orchestrator-owned opaque references.
`agent_runs.session_id` is the authoritative resumable pointer
for task execution runs;
`tasks.session_id` remains the task-facing compatibility field
for execution runs.
If a separate session service is ever introduced,
it may map those IDs onto provider-specific underlying sessions
without changing the main task schema.
At the orchestration model level, feature-level discussing,
researching, planning, verifying, summarizing, and
replanning phases use the same run/session plane as task execution:
they share `agent_runs`, retry/backoff,
and help/approval/manual-ownership waits.
In current baseline wiring, feature-phase message history also persists
through the same session-store backing used for task sessions
(currently `FileSessionStore` under `.gvc0/sessions/`).
The current startup recovery pass, however, only resumes or resets task
execution runs.
A future centralized or remote conversation/session persistence layer is a
separate feature candidate rather than baseline architecture.
The current `RuntimePort` surface is task-oriented because the
concrete worker-pool implementation is still task-only, but that is
an implementation detail rather than the architectural boundary.
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
