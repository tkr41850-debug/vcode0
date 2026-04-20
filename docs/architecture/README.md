# Architecture Topics

Use [ARCHITECTURE.md](../../ARCHITECTURE.md) for the high-level system map. Use the pages below for the canonical architecture details.

- [Data Model](./data-model.md) — milestones, features, tasks, work control, collaboration control, run state, and derived summary availability.
- [Graph Operations](./graph-operations.md) — DAG mutations, scheduling rules, milestone steering, and merge-train coordination.
- [Worker Model](./worker-model.md) — process-per-task execution, worktrees, IPC, context assembly, and crash recovery.
- [Persistence](./persistence.md) — SQLite schema, authoritative state, and JSON-vs-column boundaries.
- [Planner](./planner.md) — planner tool workflow and write-reservation heuristics.
- [Budget and Model Routing](./budget-and-model-routing.md) — budget ceilings, routing tiers, and token profiles.
