# core

Pure domain layer for graph, lifecycle, scheduling, and derived-state rules.

This directory owns domain types, invariant checks, graph mutations, transition guards, naming, scheduling math, merge-train policy, and warning evaluation.
It must stay free of concrete runtime, persistence, git, or TUI dependencies.

## Layout

- `types/` — canonical model types for milestones, features, tasks, runs, verification, config, and token usage.
- `graph/` — `FeatureGraph` contract plus `InMemoryFeatureGraph`, with sibling modules for creation, dependency edits, feature/task/milestone mutations, usage rollups, validation, queries, and transitions.
- `fsm/` — legal feature/task transition guards and policy constants like repair escalation.
- `scheduling/` — combined graph construction, metrics, and ready-work prioritization.
- `merge-train/` — merge-queue ordering and integration coordination policy.
- `proposals/`, `state/`, `naming/`, `warnings/` — proposal payloads, derived display state, branch/worktree names, and warning evaluation.

## Boundary reminders

- Put invariant-bearing rules here first, then have orchestrator call them through `FeatureGraph` or FSM helpers.
- `graph/` and `fsm/` are authority for structural legality and phase transitions; adapters may persist or render results, not redefine them.
- Task dependencies stay same-feature only, and feature dependencies stay feature-only.

## See also

- [Architecture / Data Model](../../docs/architecture/data-model.md)
- [Architecture / Graph Operations](../../docs/architecture/graph-operations.md)
- [orchestrator](../orchestrator/README.md)
- [persistence](../persistence/README.md)
