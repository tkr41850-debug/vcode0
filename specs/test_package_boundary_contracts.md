# test_package_boundary_contracts

## Goal

Capture the package-boundary and ownership rules across the `src/` architecture layers.

## Scenarios

### App stays the composition root
- Given the runnable application is assembled from multiple subsystems
- When startup wiring is added or changed
- Then `src/` remains a thin composition root for process startup, config loading, and subsystem wiring
- And subsystem behavior continues to live in the package that owns it rather than being reimplemented at the root

### Core stays pure
- Given `@core/*` owns graph types, scheduling rules, warnings, and shared contracts
- When core behavior is added or refactored
- Then it does not depend on concrete runtime, persistence, git, or TUI implementations
- And side-effecting concerns stay behind higher-layer adapters or contracts

### Orchestrator coordinates through ports
- Given the orchestrator needs persistence, git, runtime, agent, and UI capabilities
- When orchestration logic invokes those capabilities
- Then it does so through the port interfaces rather than importing concrete backend implementations directly
- And orchestration keeps ownership of workflow coordination rather than adapter-specific mechanics

### Agents own planning logic without becoming the runtime
- Given `@agents/*` owns planner and replanner prompts and graph-mutation tools
- When agent-driven planning work runs
- Then that package owns planning behavior and restructuring proposals
- And live worker execution, session management, and IPC remain runtime concerns

### Runtime owns execution mechanics without becoming graph authority
- Given `@runtime/*` owns worker lifecycle management, session harnessing, context assembly, and IPC transport
- When task execution state changes in a live worker session
- Then runtime handles process and session mechanics
- And authoritative graph mutation and durable workflow state stay outside the runtime package

### Persistence, git, and TUI stay in their lanes
- Given `@persistence/*`, `@git/*`, and `@tui/*` each represent distinct side-effecting surfaces
- When the system saves state, manipulates branches/worktrees, or presents operator controls
- Then persistence owns durable storage, git owns repository operations, and TUI owns presentation and user-triggered commands
- And none of those packages becomes the source of truth for the overall orchestration model
