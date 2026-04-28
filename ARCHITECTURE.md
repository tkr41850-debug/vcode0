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
- **Containment order is child-owned.** Membership stays on child foreign keys and sibling order stays on child rows rather than parent-owned id arrays.
- **Overall feature completion is merge-aware.** A feature is fully done only after collaboration control reaches `merged` and work control reaches `work_complete`.
- **Integration runs in-process.** The merge-train executor runs integration inline in the scheduler flow through IntegrationCoordinator; async subprocess variant deferred. Verify-shaped failures (verify, `ci_check` pre-verify or post-rebase, rebase) all route to `replanning` with a typed `VerifyIssue[]`.
- **Runtime dispatch is unified.** Scheduler and recovery route both task execution and feature phases through `RuntimePort.dispatchRun(...)`; feature phases no longer ride a separate orchestrator `agents` port.
- **Partially failed features are deprioritized.** `partially_failed` is a derived display status (not part of `UnitStatus`) computed when some frontier tasks have failed but dispatchable work remains. The scheduler prefers other runnable features while non-`partially_failed` work exists.
- **Small sibling sets are assumed.** The baseline expects roughly `<= 50` features per milestone and `<= 50` tasks per feature; warnings should surface when that assumption drifts.
- **Summary availability is derived.** Post-merge summary behavior depends on lifecycle state plus the presence of summary text, rather than a second summary-status enum.

## Lifecycle Snapshot

```text
Feature work:
  discussing → researching → planning → executing → ci_check → verifying → awaiting_merge
                                                                 ↘
                                                                  replanning

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
│   ├── agents/         -- planner/replanner prompts and proposal-graph tools
│   ├── runtime/        -- worker pool, IPC, harness, context assembly
│   ├── persistence/    -- SQLite implementation and migrations
│   └── tui/            -- terminal UI shell and derived view state
├── docs/
│   ├── README.md
│   ├── architecture/
│   ├── operations/
│   ├── reference/
│   ├── agent-prompts/
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

- `@core/*` owns pure workflow/domain contracts, scheduling/state rules, and naming utilities.
- Adapter packages (`@runtime/*`, `@persistence/*`, `@tui/*`) own their side-effecting mechanics and any adapter-specific port/result/reference types. Git operations use `simple-git` directly rather than a separate architectural layer.
- `@orchestrator/*` coordinates through those adapter-owned contracts and should not depend on concrete adapter implementations.

## Documentation Entry Points

- [docs/README.md](./docs/README.md) — main documentation landing page.
- [docs/architecture/README.md](./docs/architecture/README.md) — canonical model and architecture topics.
- [docs/operations/README.md](./docs/operations/README.md) — verification, recovery, conflict coordination, and warnings.
- [docs/reference/README.md](./docs/reference/README.md) — TUI, knowledge/context inputs, codebase map, and source-area pointers.
- [docs/agent-prompts/README.md](./docs/agent-prompts/README.md) — feature-phase and worker prompt references.
- [docs/architecture/worker-model.md](./docs/architecture/worker-model.md) — process-per-task runtime, worktrees, IPC, and crash recovery.
- [docs/operations/testing.md](./docs/operations/testing.md) — testing strategy.
- [specs/README.md](./specs/README.md) — grouped scenario-spec inventory.

This file is overview. Use landing pages above for detailed topic map.

## Source-Area Maps

When you already know which subsystem you are editing, use [docs/reference/codebase-map.md](./docs/reference/codebase-map.md) to jump to nearest `src/**/README.md`.

## Deferred Notes

Baseline docs stay separate from deferred work:

- [Feature Candidates](./docs/feature-candidates/README.md)
- [Optimization Candidates](./docs/optimization-candidates/README.md)
- [Concerns](./docs/concerns/README.md)
- [Compare](./docs/compare/README.md)
