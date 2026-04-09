# Architecture: DAG-First Autonomous Agent

A TypeScript remake of GSD-2 built on pi-sdk
(`@mariozechner/pi-agent-core`), replacing GSD-2's
sequential-default execution model with a DAG scheduler
that maximizes parallelism at every level.
Execution is organized around a feature DAG,
with task DAGs local to a feature branch and collaboration
with `main` handled through a serialized merge train.

## Core Thesis

GSD-2's execution model defaults to sequential.
Parallelism is opt-in via `depends_on` declarations.
This remake inverts that:
**the DAG is the only execution model**.
Features depend only on features.
Tasks depend only on tasks within the same feature.
Milestones are organizational / progress units that can be
queued by the user as an ordered steering list,
but they are not dependency nodes.
Work progression is tracked through **work control** phases
that end at `work_complete`, while branch / merge / conflict
coordination is tracked separately through
**collaboration control** states.
Transient execution-session detail (retry/backoff,
help/approval waits, manual takeover) lives on run/session rows
rather than expanding task enums.
Overall feature `done` is derived only after merge.

## Component Map

```
gvc0/
├── src/
│   ├── main.ts                   -- app entrypoint / CLI bootstrap
│   ├── config.ts                 -- load .gvc0/config.json
│   ├── compose.ts                -- wire concrete packages together
│   └── app/                      -- top-level app lifecycle / startup
├── packages/
│   ├── core/
│   │   ├── graph/                -- Feature/Task/Milestone model + validation
│   │   ├── state/                -- work/collab/run state types + derivations
│   │   ├── scheduling/           -- pure readiness / priority / critical-path logic
│   │   ├── warnings/             -- warning evaluation rules
│   │   └── types/                -- shared DTOs and contracts
│   ├── orchestrator/
│   │   ├── scheduler/            -- main loop / dispatch / collect
│   │   ├── features/             -- feature lifecycle coordination
│   │   ├── conflicts/            -- overlap protocol + steering coordination
│   │   ├── summaries/            -- summary-status transitions
│   │   ├── ports/                -- Store, Git, Runtime, Agent, UI interfaces
│   │   └── services/             -- orchestration helpers / use-case services
│   ├── agents/
│   │   ├── planner.ts            -- planner agent
│   │   ├── replanner.ts          -- replanner agent
│   │   ├── prompts/              -- agent prompts and templates
│   │   └── tools/                -- graph mutation tools
│   ├── runtime/
│   │   ├── worker-pool.ts        -- child process lifecycle
│   │   ├── worker/               -- worker entry / submit / runtime loop
│   │   ├── ipc/                  -- stdio NDJSON transport
│   │   ├── harness/              -- SessionHarness + PiSdkHarness
│   │   ├── context/              -- WorkerContext assembly
│   │   └── routing/              -- model routing
│   ├── git/
│   │   ├── feature-branches.ts   -- feature branch creation
│   │   ├── worktrees.ts          -- task worktree lifecycle
│   │   ├── merge-train.ts        -- serialized integration queue
│   │   ├── overlap-scan.ts       -- runtime overlap detection helpers
│   │   └── rebases.ts            -- rebase/merge helpers
│   ├── persistence/
│   │   ├── sqlite.ts             -- better-sqlite3 implementation
│   │   ├── migrations/           -- schema migrations
│   │   └── queries/              -- persistence query helpers
│   └── tui/
│       ├── app.ts                -- TUI app bootstrap
│       ├── view-model/           -- derived display state
│       ├── components/           -- DagView, StatusBar, AgentMonitor, ...
│       └── commands/             -- queue milestone / retry / replan / etc.
├── docs/
│   ├── *.md                      -- baseline architecture reference by topic
│   ├── concerns/                 -- implementation risks or watch-items to revisit later
│   ├── optimization-candidates/  -- deferred performance / efficiency ideas
│   └── feature-candidates/       -- deferred product / coordination features outside the baseline
├── specs/
│   └── test_*.md                 -- scenario specs for later conversion into executable tests
├── package.json
└── tsconfig.json
```

## Documentation Index

- [Data Model](docs/data-model.md) — hierarchy,
  feature/task dependency constraints,
  and the work control vs collaboration control state model.
- [Feature Summary Status](docs/feature-summary-status.md) —
  how post-merge summarization outcomes are recorded,
  including budget-mode skip behavior.
- [Graph Operations](docs/graph-operations.md) — DAG mutations,
  validation rules, milestone steering overrides,
  critical-path scheduling, and merge-train coordination.
- [Worker Model](docs/worker-model.md) — process-per-task
  execution, pi-sdk session harnessing, feature branches,
  task worktrees, IPC, and crash recovery.
- [Persistence](docs/persistence.md) — `better-sqlite3` schema
  and persisted work/collaboration control state.
- [Verification and Recovery](docs/verification-and-recovery.md) —
  retries, configurable task/feature/merge-train verification,
  stuck detection, replanning, and integration queue behavior.
- [TUI](docs/tui.md) — progress view, entry points,
  and how work control / collaboration control are displayed.
- [Budget and Model Routing](docs/budget-and-model-routing.md) —
  budget enforcement, routing tiers, and token profiles.
- [Knowledge Files](docs/knowledge-files.md) —
  CODEBASE.md, KNOWLEDGE.md, and DECISIONS.md.
- [Planner](docs/planner.md) — planner tool-call workflow.
- [File-Lock Conflict Resolution]
  (docs/file-lock-conflict-resolution.md) —
  same-feature overlap detection, suspension, resume,
  and cross-feature integration boundaries.
- [Cross-Feature Overlap Priority]
  (docs/cross-feature-overlap-priority.md) —
  baseline ranking policy for choosing primary vs secondary
  during cross-feature runtime overlap.
- [Conflict Steering](docs/conflict-steering.md) —
  sync recommendation ladder, checkpoint timing,
  and escalation from upstream updates to explicit
  conflict handling.
- [Testing](docs/testing.md) — unit and integration testing
  strategy, plus references to scenario specs.
- [Warnings](docs/warnings.md) — warning categories,
  tracked signals, and staged rollout from simple thresholds
  to trend detection.

## Candidate Notes

- [Feature Candidate: Arbitrary Merge-Train Manual Ordering]
  (docs/feature-candidates/arbitrary-merge-train-manual-ordering.md) —
  future support for fully persistent arbitrary user queue
  ordering beyond the baseline manual-override bucket.
- [Feature Candidate: Advanced IPC Guarantees]
  (docs/feature-candidates/advanced-ipc-guarantees.md) —
  future support for explicit acknowledgments, backpressure,
  and stronger delivery semantics beyond local stdio IPC.
- [Feature Candidate: Claude Code Harness]
  (docs/feature-candidates/claude-code-harness.md) —
  future support for wrapping Claude Code sessions
  as worker backends.
- [Feature Candidate: Long Verification Timeouts]
  (docs/feature-candidates/long-verification-timeouts.md) —
  future support for workflows that need longer-running
  verification than the local baseline.
- [Optimization Candidate: Testing Cost Reduction]
  (docs/optimization-candidates/testing.md) —
  future ideas for reducing verification/testing cost.
- [Optimization Candidate: Verification Reuse]
  (docs/optimization-candidates/verification-and-recovery.md) —
  future ideas for reusing or narrowing repeated
  verification work.

## Concern Notes

- [Concern: Verification and Repair Churn]
  (docs/concerns/verification-and-repair-churn.md) —
  watch repeated repair/verification loops that may dominate
  runtime and cost.
- [Concern: Planner Write-Reservation Accuracy]
  (docs/concerns/planner-write-reservation-accuracy.md) —
  watch predictive write-set quality because bad reservations
  can hurt concurrency or detect overlap too late.

## Scenario Specs

High-level test situations live under `specs/test_*.md`.
These markdown specs capture feature-branch lifecycle,
merge-train, file-lock, replanning, and crash-recovery scenarios
before they are converted into executable tests.
