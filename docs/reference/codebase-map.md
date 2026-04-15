# Codebase Map

This page points to code-local README files under `src/`. Use it when you already know which subsystem you are editing and want nearest boundary description.

This docs page is separate from any runtime `codebaseMap` prompt string. See [Knowledge Files](./knowledge-files.md) for current context-input wiring.

Start with [ARCHITECTURE.md](../../ARCHITECTURE.md) for system-wide map, then jump to source-area README that matches code you are touching.

## Source-Area READMEs

- [src/README.md](../../src/README.md) — repo-level composition root and cross-package boundary rules.
- [src/app/README.md](../../src/app/README.md) — application lifecycle wrapper around startup, UI show, and clean shutdown.
- [src/core/README.md](../../src/core/README.md) — pure domain logic for graph/state/scheduling contracts.
- [src/orchestrator/README.md](../../src/orchestrator/README.md) — orchestration and state-transition services.
- [src/runtime/README.md](../../src/runtime/README.md) — worker lifecycle, IPC, harnessing, session persistence, and local execution.
- [src/persistence/README.md](../../src/persistence/README.md) — database-backed state storage and migrations.
- [src/agents/README.md](../../src/agents/README.md) — feature-phase agents, planner/replanner logic, and worker-agent surfaces.
- [src/agents/worker/README.md](../../src/agents/worker/README.md) — worker agent tool catalog and toolset factory.
- [src/tui/README.md](../../src/tui/README.md) — terminal UI shell, derived view state, and TUI commands.

## When to Use These

- Use [Architecture Topics](../architecture/README.md) for canonical model and lifecycle rules.
- Use these `src/**/README.md` files for code-local responsibilities and boundary reminders.
- Use [Worker Model](../worker-model.md) and [Conflict Coordination](../operations/conflict-coordination.md) when a subsystem boundary crosses multiple source areas.
