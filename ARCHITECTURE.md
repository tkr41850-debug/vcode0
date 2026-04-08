# gsd2 Architecture: DAG-First Autonomous Agent

A TypeScript remake of GSD-2 built on pi-sdk (`@mariozechner/pi-agent-core`), replacing GSD-2's sequential-default execution model with a DAG scheduler that maximizes parallelism at every level. Execution is organized around a feature DAG, with task DAGs local to a feature branch and collaboration with `main` handled through a serialized merge train.

## Core Thesis

GSD-2's execution model defaults to sequential. Parallelism is opt-in via `depends_on` declarations. This remake inverts that: **the DAG is the only execution model**. Features depend only on features. Tasks depend only on tasks within the same feature. Milestones are organizational / progress units that can be queued by the user as an ordered steering list, but they are not dependency nodes. Work progression is tracked through **work control** phases that end at `work_complete`, while branch / merge / conflict coordination is tracked separately through **collaboration control** states. Overall feature `done` is derived only after merge.

## Component Map

```
gsd2/
├── src/
│   ├── graph/
│   │   ├── types.ts              -- Milestone, Feature, Task, work/collaboration control types
│   │   ├── feature-graph.ts      -- FeatureGraph: DAG + all mutations + validation
│   │   └── critical-path.ts      -- critical path weight computation
│   ├── scheduler/
│   │   ├── scheduler.ts          -- main loop: frontier → dispatch → collect
│   │   ├── worker-pool.ts        -- child process lifecycle, max concurrency
│   │   ├── retry.ts              -- exponential backoff retry scheduling
│   │   ├── feature-branches.ts   -- feature branch creation + task worktree branching
│   │   ├── merge-train.ts        -- serialized integration queue for feature branches → main
│   │   ├── context.ts            -- build WorkerContext per task (injects CODEBASE.md, KNOWLEDGE.md, DECISIONS.md; regenerates CODEBASE.md on demand)
│   │   └── model-router.ts       -- dynamic model routing (tier → model selection)
│   ├── worker/
│   │   ├── entry.ts              -- child process entry point
│   │   ├── worker.ts             -- pi-sdk Agent wrapper
│   │   ├── submit.ts             -- submit tool + verification runner
│   │   ├── harness.ts            -- SessionHarness interface + PiSdkHarness + ClaudeCodeHarness
│   │   └── tools/                -- standard tools + append_knowledge + record_decision
│   ├── ipc/
│   │   ├── types.ts              -- WorkerMessage, OrchestratorMessage
│   │   ├── transport.ts          -- IpcTransport interface
│   │   └── ndjson.ts             -- NdjsonStdioTransport (default)
│   ├── tui/
│   │   ├── dag-view.ts           -- DagView component
│   │   ├── status-bar.ts         -- StatusBar component
│   │   └── agent-monitor.ts      -- AgentMonitorOverlay: live worker output + steer
│   ├── planner/
│   │   └── planner.ts            -- pi-sdk Agent with graph-mutation tools
│   ├── persistence/
│   │   ├── store.ts              -- Store interface
│   │   └── sqlite.ts             -- SQLite implementation
│   └── cli.ts                    -- entry point
├── docs/
│   └── *.md                      -- architecture reference by topic
├── specs/
│   └── test_*.md                 -- scenario specs for later conversion into executable tests
├── package.json
└── tsconfig.json
```

## Documentation Index

- [Data Model](docs/data-model.md) — hierarchy, feature/task dependency constraints, and the work control vs collaboration control state model.
- [Graph Operations](docs/graph-operations.md) — DAG mutations, validation rules, milestone steering overrides, critical-path scheduling, and merge-train coordination.
- [Worker Model](docs/worker-model.md) — process-per-task execution, feature branches, task worktrees, IPC, and crash recovery.
- [Persistence](docs/persistence.md) — SQLite schema and persisted work/collaboration control state.
- [Verification and Recovery](docs/verification-and-recovery.md) — retries, configurable task/feature/merge-train verification, stuck detection, replanning, and integration queue behavior.
- [TUI](docs/tui.md) — progress view, entry points, and how work control / collaboration control are displayed.
- [Budget and Model Routing](docs/budget-and-model-routing.md) — budget enforcement, routing tiers, and token profiles.
- [Knowledge Files](docs/knowledge-files.md) — CODEBASE.md, KNOWLEDGE.md, and DECISIONS.md.
- [Planner](docs/planner.md) — planner tool-call workflow.
- [File-Lock Conflict Resolution](docs/file-lock-conflict-resolution.md) — same-feature overlap detection, suspension, resume, and cross-feature integration boundaries.
- [Testing](docs/testing.md) — unit and integration testing strategy, plus references to scenario specs.
- [Warnings](docs/warnings.md) — warning categories, tracked signals, and staged rollout from simple thresholds to trend detection.

## Scenario Specs

High-level test situations live under `specs/test_*.md`. These markdown specs capture feature-branch lifecycle, merge-train, file-lock, replanning, and crash-recovery scenarios before they are converted into executable tests.
