# Data Model

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for the high-level architecture overview.

## Work Unit Hierarchy: Milestone → Feature → Task

```
Milestone (organizational / progress unit)
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

**Milestone** — an organizational / progress unit. It owns a set of features, gives users a human-facing grouping for planning and tracking, and can optionally be queued explicitly as a scheduler steering target. Multiple milestones may be queued. It does **not** participate in dependency edges in this version of the model.

**Feature** — the primary unit in the execution DAG. Features depend only on other features. Each feature belongs to exactly one milestone, owns exactly one feature branch, and exposes two state axes. A feature may represent either a user-visible implementation slice or, where justified, a shared interface/contract prerequisite that later implementation features depend on.

### Work Control

Work control tracks where the feature is in the GSD planning / execution flow.

```text
discussing → researching → planning → executing → feature_ci → verifying → awaiting_merge
                                                   ↘                ↘
                                                    executing_repair ─→ feature_ci

awaiting_merge --(after collaboration control reaches `merged`)--> summarizing ─→ work_complete
                                                         \--(budget mode)--> work_complete

structural or repeated failure → replanning
```

- **discussing** — blocking modal in the TUI. The orchestrator launches a discuss-phase agent and waits for user answers. Skipped in `budget` token profile.
- **researching** — scouts the codebase and relevant docs to inform planning. Skipped in `budget` token profile.
- **planning** — decomposes the feature into tasks, assigns weights, and declares inter-task deps.
- **executing** — tasks dispatch to workers in parallel per the feature-local DAG frontier. The feature branch may be red during `executing`.
- **feature_ci** — heavy branch-level verification after the last task or repair task lands. By default the feature branch should be green before leaving `feature_ci` and entering `verifying`, though a loose feature-level policy may relax that boundary.
- **verifying** — agent-level review that checks whether the feature branch actually satisfies the feature spec, not just whether CI passes.
- **awaiting_merge** — local implementation and spec review are complete; the feature is waiting for collaboration control to carry it through the merge queue and integration into `main`.
- **summarizing** — after collaboration control reaches `merged`, a `light`-tier model writes a feature summary for downstream context injection. While this phase is active and the feature has no summary text yet, summary availability is treated as waiting.
- **executing_repair** — repair tasks appended on the same feature branch after `feature_ci`, `verifying`, or integration repair finds issues. This is still part of execution, and the branch may remain red here.
- **replanning** — recovery phase entered after repeated work failures, repeated unresolved same-feature conflict handling, or a structural integration mismatch.
- **work_complete** — feature implementation has merged and summarization outcome is derived from current state: if summary text exists it is available, and if no summary text exists the summary was skipped. Overall feature `done` is derived only after collaboration control reaches `merged`.

### Collaboration Control

Collaboration control tracks how the feature coordinates with branches, the merge train, and shared files.

```
none → branch_open → merge_queued → integrating → merged
                             ↓
                          conflict

branch_open / merge_queued / conflict → cancelled
```

- **none** — feature branch not opened yet.
- **branch_open** — feature branch / feature worktree exists as the integration surface; tasks may merge into it.
- **merge_queued** — feature is waiting in the serialized integration queue.
- **integrating** — feature branch is rebasing / running merge-train verification against the latest `main`.
- **merged** — feature branch landed on `main` and is cleaned up.
- **conflict** — feature-level collaboration issue blocks normal progress. While a feature is in `conflict`, suspend all non-repair task runs for that feature until the conflict is cleared.
- **cancelled** — feature participation in the branch / merge lifecycle has been explicitly stopped. Cancellation kills all in-flight tasks immediately, freezes the current work phase, and keeps the feature out of normal scheduling until it is explicitly restored.

Feature and milestone `status` fields are derived reporting values, not independent authority. Feature status is derived from collaboration control plus frontier task outcomes; milestone status is derived from child feature statuses. A feature becomes `done` only when `workControl = "work_complete"` and `collabControl = "merged"`. A feature becomes `failed` when all frontier tasks are failed, and `partially_failed` when only some frontier tasks are failed.

The baseline uses typed prefixed IDs to distinguish graph unit classes at compile time:
- milestones: `m-${string}`
- features: `f-${string}`
- tasks: `t-${string}`

This keeps graph references scalar and persistence-friendly while making dependency legality and ownership relations explicit in the type surface.

Containment and sibling order are child-owned in the baseline:
- `Feature.milestoneId` + `Feature.orderInMilestone` define feature membership and order within a milestone
- `Task.featureId` + `Task.orderInFeature` define task membership and order within a feature
- parent collections are derived by filtering children by owner and sorting by the child order field

The baseline expects relatively small sibling sets (roughly `<= 50` features per milestone and `<= 50` tasks per feature), so simple child-order rewrites are acceptable. The warning system should surface cardinality growth if that assumption stops holding.

**Task** — the atomic unit of work. Executed by a single worker process. Tasks may depend only on other tasks within the same feature. Task execution progress is part of work control; branch suspension / merge coordination is part of collaboration control.

### Data Model

```typescript
type MilestoneId = `m-${string}`;
type FeatureId = `f-${string}`;
type TaskId = `t-${string}`;

interface Milestone {
  id: MilestoneId;
  name: string;
  description: string;
  status: UnitStatus;              // derived aggregate status for reporting
  order: number;                   // display order only; not an execution dependency
  steeringQueuePosition?: number;  // ordered scheduler override; absent = not queued (effective ∞)
}

interface Feature {
  id: FeatureId;
  milestoneId: MilestoneId;        // exactly one authoritative milestone per feature
  orderInMilestone: number;        // authoritative sibling order within the owning milestone
  name: string;
  description: string;
  dependsOn: FeatureId[];          // feature ids only
  status: UnitStatus;              // derived aggregate reporting status
  workControl: FeatureWorkControl;
  collabControl: FeatureCollabControl;
  featureBranch: string;           // e.g. feat-auth
  featureTestPolicy?: TestPolicy;
  mergeTrainManualPosition?: number;  // manual override bucket position when explicitly ordered
  mergeTrainEnteredAt?: number;
  mergeTrainEntrySeq?: number;        // stable ordering tie-breaker for current queue entry
  mergeTrainReentryCount?: number;
  summary?: string;
  tokenUsage?: TokenUsageAggregate;   // lifetime aggregate across all task/model calls in the feature
}

interface Task {
  id: TaskId;
  featureId: FeatureId;            // exactly one authoritative owning feature per task
  orderInFeature: number;          // authoritative sibling order within the owning feature
  description: string;
  dependsOn: TaskId[];             // task ids within the same feature only
  status: TaskStatus;              // work-control execution status
  collabControl: TaskCollabControl;
  workerId?: string;
  worktreeBranch?: string;
  taskTestPolicy?: TestPolicy;
  result?: TaskResult;
  weight?: number;                 // estimated cost/complexity for critical path
  tokenUsage?: TokenUsageAggregate; // lifetime aggregate across retries, failures, and resumes
}

interface AgentRun {
  id: string;
  scopeType: "task" | "feature_phase";
  scopeId: TaskId | FeatureId;
  phase: AgentRunPhase;
  runStatus: AgentRunStatus;
  owner: RunOwner;
  attention: RunAttention;
  sessionId?: string;
  payloadJson?: string;
  restartCount: number;
  maxRetries: number;
  retryAt?: number;
}

interface TokenUsageAggregate {
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;         // 0 when the provider does not expose this separately
  audioInputTokens: number;
  audioOutputTokens: number;
  totalTokens: number;
  usd: number;
  byModel: Record<string, ModelUsageAggregate>; // key: `${provider}:${model}`
}

interface ModelUsageAggregate {
  provider: string;
  model: string;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  audioInputTokens: number;
  audioOutputTokens: number;
  totalTokens: number;
  usd: number;
}

type UnitStatus = "pending" | "in_progress" | "done" | "failed" | "partially_failed" | "cancelled";

type FeatureWorkControl =
  | "discussing"
  | "researching"
  | "planning"
  | "executing"
  | "feature_ci"
  | "verifying"
  | "awaiting_merge"
  | "summarizing"
  | "executing_repair"
  | "replanning"
  | "work_complete";

type FeatureCollabControl =
  | "none"
  | "branch_open"
  | "merge_queued"
  | "integrating"
  | "merged"
  | "conflict"
  | "cancelled";

type TaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "stuck"
  | "done"
  | "failed"
  | "cancelled";

type TaskCollabControl =
  | "none"
  | "branch_open"
  | "suspended"
  | "merged"
  | "conflict";

type TestPolicy = "loose" | "strict";

type AgentRunPhase =
  | "execute"
  | "discuss"
  | "research"
  | "plan"
  | "feature_ci"
  | "verify"
  | "summarize"
  | "replan";

type AgentRunStatus =
  | "ready"
  | "running"
  | "retry_await"
  | "await_response"
  | "await_approval"
  | "completed"
  | "failed"
  | "cancelled";

// State ownership rule:
// - tasks.status is coarse DAG/work progress only
// - tasks.collabControl is coordination only
// - agent_runs owns retry/help/approval/manual execution detail
// - blocked is derived for UI/reporting from run status + retry timing + collaboration state,
//   not persisted as a task enum

type RunOwner = "system" | "manual";

type RunAttention = "none" | "crashloop_backoff";
```

### Scheduling Levels

The feature graph determines which features can run. Milestones are organizational / steering units: they do not unblock execution and they do not create dependency edges. A user may queue multiple milestones to steer scheduler attention. Among ready work, the scheduler first compares the queue position of each task's associated milestone; work whose milestone is not queued gets an effective queue position of infinity. Within the same milestone queue-position bucket, normal critical-path / readiness logic applies. If no milestones are queued, the scheduler runs autonomously from the global ready frontier. Within a runnable feature, all tasks with satisfied in-feature deps are dispatched in parallel.

```
Feature graph:
  F-auth ──→ F-api ──→ F-ui
                ↑
  F-db ────────┘

Ready frontier: [F-auth, F-db]  (no unmet feature deps)
Queued milestones: [M1, M3]
Tuple ordering over ready work:
  1. milestoneQueuePosition(task.milestoneId)   // ∞ if not queued
  2. -criticalPathWeight(task)
  3. stable fallback
No queued milestones: start from the global ready frontier and sort by critical path
After F-auth + F-db done: [F-api]
After F-api done: [F-ui]

Within F-auth:
  Task 1, Task 2, Task 3  (all independent → all dispatched in parallel)
```

### Git Branch Model

```text
main
└── feat-auth
    ├── feat-auth-task-jwt-validation
    ├── feat-auth-task-session-store
    └── feat-auth-task-middleware-wiring
```

- A feature branch and feature worktree are created when that branch is requested and collaboration control enters `branch_open`; the baseline branch name is `feat-<feature-id>`.
- Task worktrees branch from the current HEAD of the owning feature branch and use the baseline branch name `feat-<feature-id>-task-<task-id>`.
- Task completion is a two-step closeout: `submit()` runs light preflight checks and returns concrete failure reasons when they fail; `confirm()` is the final terminate-session + squash-merge into the feature branch.
- After the last task or repair task lands, the feature enters `feature_ci` on the feature branch; only after that boundary passes does the feature enter agent-level `verifying`.
- If `verifying` passes, feature work control becomes `awaiting_merge` and collaboration control may move to `merge_queued`.
- After collaboration control reaches `merged`, the feature either enters blocking `summarizing` or, in budget mode, moves directly to `work_complete` without writing summary text.
- The merge train serializes feature-branch integration into `main`.
