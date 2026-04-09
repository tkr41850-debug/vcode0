# Data Model

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the high-level architecture index.

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

```
discussing → researching → planning → executing → verifying → summarizing → work_complete
                                         ↓ (if work stalls or integration fails)
                                     replanning
```

- **discussing** — blocking modal in the TUI. The orchestrator launches a discuss-phase agent and waits for user answers. Skipped in `budget` token profile.
- **researching** — scouts the codebase and relevant docs to inform planning. Skipped in `budget` token profile.
- **planning** — decomposes the feature into tasks, assigns weights, and declares inter-task deps.
- **executing** — tasks dispatch to workers in parallel per the feature-local DAG frontier.
- **verifying** — all task outputs have landed on the feature branch and feature-level checks run.
- **summarizing** — a `light`-tier model writes a feature summary for downstream context injection.
- **replanning** — recovery phase entered after repeated work failures, repeated unresolved same-feature conflict handling, or an unresolved integration conflict.
- **work_complete** — feature implementation is complete on its feature branch. Overall feature `done` is derived only after collaboration control reaches `merged`.

### Collaboration Control

Collaboration control tracks how the feature coordinates with branches, the merge train, and shared files.

```
none → branch_open → merge_queued → integrating → merged
                             ↓
                          conflict
```

- **none** — feature branch not opened yet.
- **branch_open** — feature branch / feature worktree exists as the integration surface; tasks may merge into it.
- **merge_queued** — feature is waiting in the serialized integration queue.
- **integrating** — feature branch is rebasing / verifying against the latest `main`.
- **merged** — feature branch landed on `main` and is cleaned up.
- **conflict** — same-feature file-lock resolution or feature-branch integration surfaced a conflict that needs collaboration before work can continue.

A feature's aggregate `status` is derived for reporting. It becomes `done` only when `workControl = "work_complete"` and `collabControl = "merged"`.

**Task** — the atomic unit of work. Executed by a single worker process. Tasks may depend only on other tasks within the same feature. Task execution progress is part of work control; branch suspension / merge coordination is part of collaboration control.

### Data Model

```typescript
interface Milestone {
  id: string;
  name: string;
  description: string;
  featureIds: string[];            // features grouped under this milestone
  status: UnitStatus;              // derived aggregate status for reporting
  order: number;                   // display order only; not an execution dependency
  steeringQueuePosition?: number;  // ordered scheduler override; absent = not queued (effective ∞)
}

interface Feature {
  id: string;
  milestoneId: string;             // exactly one milestone per feature
  name: string;
  description: string;
  dependsOn: string[];             // feature ids only
  taskIds: string[];
  status: UnitStatus;              // derived aggregate reporting status
  workControl: FeatureWorkControl;
  collabControl: FeatureCollabControl;
  featureBranch: string;              // e.g. gvc0/feature-auth
  mergeTrainManualPosition?: number;  // manual override bucket position when explicitly ordered
  mergeTrainEnteredAt?: number;
  mergeTrainEntrySeq?: number;        // stable ordering tie-breaker for current queue entry
  mergeTrainReentryCount?: number;
  tokenUsage?: TokenUsageAggregate;   // lifetime aggregate across all task/model calls in the feature
}

interface Task {
  id: string;
  featureId: string;
  description: string;
  dependsOn: string[];             // task ids within the same feature only
  status: TaskStatus;              // work-control execution status
  collabControl: TaskCollabControl;
  workerId?: string;
  worktreeBranch?: string;
  result?: TaskResult;
  weight?: number;                 // estimated cost/complexity for critical path
  tokenUsage?: TokenUsageAggregate; // lifetime aggregate across retries, failures, and resumes
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

type UnitStatus = "pending" | "in_progress" | "done" | "failed" | "cancelled";

type FeatureWorkControl =
  | "discussing"
  | "researching"
  | "planning"
  | "executing"
  | "verifying"
  | "summarizing"
  | "replanning"
  | "work_complete";

type FeatureCollabControl =
  | "none"
  | "branch_open"
  | "merge_queued"
  | "integrating"
  | "merged"
  | "conflict";

type TaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "retry_await"
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
└── feature/auth
    ├── task/jwt-validation
    ├── task/session-store
    └── task/middleware-wiring
```

- A feature branch and feature worktree are created when that branch is requested and collaboration control enters `branch_open`.
- Task worktrees branch from the current HEAD of the owning feature branch.
- Task completion squash-merges into the feature branch, not `main`.
- Once summarizing finishes and feature work control becomes `work_complete`, run feature verification on the feature branch; only if it passes does collaboration control move to `merge_queued`.
- The merge train serializes feature-branch integration into `main`.
