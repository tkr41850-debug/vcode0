# gsd2 Data Model

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the high-level architecture index.

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
