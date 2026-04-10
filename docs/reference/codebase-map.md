# Codebase Map

This page points to the code-local README files under `src/`. Use it when you already know which subsystem you are editing and want the nearest boundary description.

This docs page is separate from the generated `CODEBASE.md` artifact described in [Knowledge Files](./knowledge-files.md).

Start with [ARCHITECTURE.md](../../ARCHITECTURE.md) for the system-wide map, then jump to the source-area README that matches the code you are touching.

## Source-Area READMEs

- [src/README.md](../../src/README.md) — application entry and composition root.
- [src/core/README.md](../../src/core/README.md) — pure domain logic for graph/state/scheduling contracts.
- [src/orchestrator/README.md](../../src/orchestrator/README.md) — orchestration and state-transition services.
- [src/runtime/README.md](../../src/runtime/README.md) — worker lifecycle, IPC, harnessing, and local execution.
- [src/git/README.md](../../src/git/README.md) — feature branches, task worktrees, merge train, and overlap helpers.
- [src/persistence/README.md](../../src/persistence/README.md) — database-backed state storage and migrations.
- [src/agents/README.md](../../src/agents/README.md) — planner/replanner logic, prompts, and graph-mutation tools.
- [src/tui/README.md](../../src/tui/README.md) — terminal UI shell, derived view state, and TUI commands.

## When to Use These

- Use [Architecture Topics](../architecture/README.md) for canonical model and lifecycle rules.
- Use these `src/**/README.md` files for code-local responsibilities and boundary reminders.
- Use [Worker Model](../worker-model.md) and [Conflict Coordination](../operations/conflict-coordination.md) when a subsystem boundary crosses multiple source areas.
