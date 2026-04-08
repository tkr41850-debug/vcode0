# gsd2 Data Model

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the high-level architecture index.

## Work Unit Hierarchy: Milestone → Feature → Task

```
Milestone (human-facing release / priority group)
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

**Milestone** — a human-facing release or priority group. It owns a set of features and contributes ordering / reporting metadata, but it does **not** participate in dependency edges in this version of the model.

**Feature** — the primary unit in the execution DAG. Features depend only on other features. Each feature belongs to exactly one milestone, owns exactly one feature branch, and exposes two state axes:

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
- **replanning** — recovery phase entered after repeated work failures or an unresolved integration conflict.
- **work_complete** — feature implementation is complete on its feature branch. Overall feature `done` is derived only after collaboration control reaches `merged`.

### Collaboration Control

Collaboration control tracks how the feature coordinates with branches, the merge train, and shared files.

```
none → branch_open → merge_queued → integrating → merged
                             ↓
                          conflict
```

- **none** — feature branch not opened yet.
- **branch_open** — feature branch exists; tasks are merging into it.
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
  order: number;                   // priority / display order only
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
  featureBranch: string;           // e.g. gsd2/feature-auth
  mergeTrainPosition?: number;
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
  | "retrying"
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

The feature graph determines which features can run. Milestones provide grouping and priority only; they do not unblock execution. Within a runnable feature, all tasks with satisfied in-feature deps are dispatched in parallel.

```
Milestone priority: M1 > M2 > M3

Feature graph:
  F-auth ──→ F-api ──→ F-ui
                ↑
  F-db ────────┘

Ready frontier: [F-auth, F-db]  (no unmet feature deps)
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

- A feature branch is created when a feature enters `executing` work control.
- Task worktrees branch from the current HEAD of the owning feature branch.
- Task completion squash-merges into the feature branch, not `main`.
- Once summarizing finishes and feature work control becomes `work_complete`, collaboration control moves to `merge_queued`.
- The merge train serializes feature-branch integration into `main`.
