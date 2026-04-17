# orchestrator

Application service layer for driving graph state through runtime, persistence, and UI ports.

This directory owns scheduler flow, feature lifecycle coordination, proposal application, conflict handling, recovery/verification services, and post-merge summaries.
It may depend on `@core/*` contracts and adapter-facing ports, but not on concrete runtime, persistence, or TUI implementations.

## Layout

- `scheduler/` — event queue, ready-work dispatch, overlap scans, warning emission, event handling, and UI refresh triggers.
- `features/` — feature lifecycle progression, repair/replan escalation, and merge-train handoff.
- `proposals/` — parse, validate, apply, and summarize planner/replanner proposals.
- `conflicts/` — same-feature and cross-feature overlap coordination.
- `services/` — recovery, verification, and budget-facing helper services.
- `summaries/` — post-merge summary coordination and budget-mode skip behavior.
- `ports/` — orchestrator-facing interfaces for store, runtime, UI, and verification seams.

## Boundary reminders

- Put pure legality and graph math in [core](../core/README.md); orchestrator coordinates those rules, it does not redefine them.
- Depend on ports and contract types here. Concrete adapters get wired in from the composition root.
- When flows cross runtime, store, and UI, keep orchestration here rather than pushing workflow into adapters.

## See also

- [Architecture Topics](../../docs/architecture/README.md)
- [Operations / Conflict Coordination](../../docs/operations/conflict-coordination.md)
- [core](../core/README.md)
- [runtime](../runtime/README.md)
