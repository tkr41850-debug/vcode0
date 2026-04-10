# Architecture: DAG-First Autonomous Agent

**gvc0** is a TypeScript remake of GSD-2 built on pi-sdk (`@mariozechner/pi-agent-core`). It replaces GSD-2's sequential-default execution model with a DAG scheduler that maximizes parallelism at every level.

## Core Thesis

- **The DAG is the execution model.** Features depend only on features. Tasks depend only on tasks within the same feature.
- **Milestones are organizational and steering units.** They can be queued as ordered scheduler buckets, but they are not dependency nodes.
- **State is intentionally split.**
  - **work control** tracks planning and execution progress
  - **collaboration control** tracks branch, merge, suspension, and conflict coordination
  - **run state** tracks retry windows, help/approval waits, and manual takeover on `agent_runs`
- **Typed prefixed IDs keep graph references scalar.** Milestones use `m-${string}`, features use `f-${string}`, and tasks use `t-${string}` so dependency kind and ownership stay explicit without object-shaped references.
- **Overall feature completion is merge-aware.** A feature is fully done only after collaboration control reaches `merged` and work control reaches `work_complete`.
- **Partially failed features are deprioritized.** Frontier failures surface as derived status, and the scheduler should prefer other runnable features while non-`partially_failed` work exists.
- **Summary availability is derived.** Post-merge summary behavior depends on lifecycle state plus the presence of summary text, rather than a second summary-status enum.

## Lifecycle Snapshot

```text
Feature work:
  discussing → researching → planning → executing → feature_ci → verifying → awaiting_merge
                                                         ↘                ↘
                                                          executing_repair ─→ feature_ci

  awaiting_merge --(after collab reaches `merged`)--> summarizing ─→ work_complete
                                           \--(budget mode)--> work_complete

Feature collaboration:
  none → branch_open → merge_queued → integrating → merged
                               ↓
                            conflict

  branch_open / merge_queued / conflict → cancelled

Task run overlay:
  ready ↔ running ↔ retry_await
                    ↘
                     await_response / await_approval / manual ownership
```

## Component Map

```text
gvc0/
├── src/
│   ├── main.ts
│   ├── config.ts
│   ├── compose.ts
│   ├── app/            -- app lifecycle and startup
│   ├── core/           -- graph/state/scheduling/warning contracts
│   ├── orchestrator/   -- scheduler, feature lifecycle, conflicts, summaries
│   ├── agents/         -- planner/replanner prompts and graph-mutation tools
│   ├── runtime/        -- worker pool, IPC, harness, context assembly
│   ├── git/            -- feature branches, worktrees, merge train, overlap helpers
│   ├── persistence/    -- SQLite implementation and migrations
│   └── tui/            -- terminal UI shell and derived view state
├── docs/
│   ├── README.md
│   ├── architecture/
│   ├── operations/
│   ├── reference/
│   ├── worker-model.md
│   ├── testing.md
│   ├── concerns/
│   ├── optimization-candidates/
│   ├── feature-candidates/
│   └── compare/
├── specs/
│   ├── README.md
│   └── test_*.md
├── package.json
└── tsconfig.json
```

## Boundary Notes

- `@core/*` owns pure workflow/domain contracts and scheduling/state rules.
- Adapter packages (`@git/*`, `@runtime/*`, `@persistence/*`, `@tui/*`) own their side-effecting mechanics and any adapter-specific port/result/reference types.
- `@orchestrator/*` coordinates through those adapter-owned contracts and should not depend on concrete adapter implementations.

## Documentation Entry Points

- [docs/README.md](./docs/README.md) — main documentation landing page.
- [docs/architecture/README.md](./docs/architecture/README.md) — canonical model and architecture topics.
- [docs/operations/README.md](./docs/operations/README.md) — verification, recovery, conflict coordination, and warnings.
- [docs/reference/README.md](./docs/reference/README.md) — TUI, knowledge files, codebase map, and source-area pointers.
- [docs/worker-model.md](./docs/worker-model.md) — process-per-task runtime, worktrees, IPC, and crash recovery.
- [docs/testing.md](./docs/testing.md) — testing strategy.
- [specs/README.md](./specs/README.md) — grouped scenario-spec inventory.

This file is the overview. Use the landing pages above for the detailed topic map.

## Source-Area Maps

When you already know which subsystem you are editing, use [docs/reference/codebase-map.md](./docs/reference/codebase-map.md) to jump to the nearest `src/**/README.md`.

## Deferred Notes

The baseline docs stay separate from deferred work:

- [Feature Candidates](./docs/feature-candidates/)
- [Optimization Candidates](./docs/optimization-candidates/)
- [Concerns](./docs/concerns/)
- [Compare](./docs/compare/)
