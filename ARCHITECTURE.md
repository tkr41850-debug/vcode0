# gsd2 Architecture: DAG-First Autonomous Agent

A TypeScript remake of GSD-2 built on pi-sdk (`@mariozechner/pi-agent-core`), replacing GSD-2's sequential-default execution model with a DAG scheduler that maximizes parallelism at every level.

## Core Thesis

GSD-2's execution model defaults to sequential. Parallelism is opt-in via `depends_on` declarations. This remake inverts that: **the DAG is the only execution model**. Every unit of work declares its dependencies explicitly; the scheduler runs the maximum parallel frontier at all times.

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

## Documentation Index

- [Data Model](docs/data-model.md) — work unit hierarchy, lifecycle, and scheduling levels.
- [Graph Operations](docs/graph-operations.md) — DAG mutations, validation rules, scheduler loop, and critical-path prioritization.
- [Worker Model](docs/worker-model.md) — process-per-task execution, IPC, context injection, and crash recovery.
- [Persistence](docs/persistence.md) — SQLite schema and persisted orchestration state.
- [Verification and Recovery](docs/verification-and-recovery.md) — retries, submit-time verification, stuck detection, and replanning.
- [TUI](docs/tui.md) — progress view, entry points, and agent monitor behavior.
- [Budget and Model Routing](docs/budget-and-model-routing.md) — budget enforcement, routing tiers, and token profiles.
- [Knowledge Files](docs/knowledge-files.md) — CODEBASE.md, KNOWLEDGE.md, and DECISIONS.md.
- [Planner](docs/planner.md) — planner tool-call workflow.
- [File-Lock Conflict Resolution](docs/file-lock-conflict-resolution.md) — overlap detection, suspension, and resume flow.
- [Testing](docs/testing.md) — unit and integration testing strategy.
