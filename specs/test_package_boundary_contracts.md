# test_package_boundary_contracts

## Goal

Capture current package-boundary and ownership rules across `src/` architecture layers.

## Scenarios

### App stays thin lifecycle/composition surface
- Given runnable application is assembled from multiple subsystems
- When startup wiring changes
- Then `src/main.ts`, `src/compose.ts`, and `src/app/` stay focused on CLI startup, lifecycle, and composition
- And subsystem behavior continues to live in package that owns it rather than being reimplemented at root

### Core stays pure
- Given `@core/*` owns graph types, scheduling rules, warnings, state derivation, and shared contracts
- When core behavior is added or refactored
- Then it does not depend on concrete runtime, persistence, git, or TUI implementations
- And side-effecting concerns stay behind higher-layer adapters or contracts

### Orchestrator coordinates through graph plus ports
- Given orchestrator needs durable graph state, task runtime control, feature-phase agent work, verification, and UI refresh
- When orchestration logic invokes those capabilities
- Then it coordinates through `FeatureGraph` plus adapter-owned ports/contracts rather than importing concrete backends directly
- And orchestration keeps ownership of workflow/state transitions rather than adapter-specific mechanics

### Agents own planning and feature-phase semantics
- Given `@agents/*` owns discuss/research/plan/verify/summarize/replan prompts and proposal tools
- When agent-driven feature work runs
- Then that package owns prompt behavior and proposal semantics
- And runtime-owned worker process/session mechanics stay outside `@agents/*`
- And worker tool catalog remains under `@agents/worker/*` even though worker system prompt is assembled by runtime

### Runtime owns execution mechanics
- Given `@runtime/*` owns worker lifecycle, IPC, session harnessing, session persistence seam, model routing, and task prompt assembly
- When task execution state changes in live worker session
- Then runtime handles process/session mechanics and worker prompt assembly
- And authoritative graph mutation and durable workflow state stay outside runtime package

### Persistence owns durable storage surfaces without swallowing whole orchestrator
- Given durable state is split across graph state and run/event state
- When persistence boundaries are implemented
- Then `PersistentFeatureGraph` owns milestone/feature/task/dependency graph I/O
- And `Store` owns `agent_runs` plus `events`
- And persistence-local row/codec/migration concerns stay under `@persistence/*` rather than leaking into `@core/*`

### TUI stays presentation-only
- Given `@tui/*` shows DAG state and user-triggered commands
- When presentation behavior changes
- Then TUI owns rendering, overlays, derived view-model state, and keybindings
- And TUI does not become source of truth for graph or run state

### Git stays direct, not separate architectural package
- Given orchestrator/runtime need repository-facing collaboration work
- When feature branches, task worktrees, rebases, and merges happen
- Then code uses `simple-git` directly where needed rather than introducing dedicated `@git/*` layer
- And naming conventions still live in shared core utilities
