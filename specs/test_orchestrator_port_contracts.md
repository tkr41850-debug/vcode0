# test_orchestrator_port_contracts

## Goal

Capture the responsibility split across the orchestrator adapter ports so orchestration logic can coordinate work without owning every side effect directly.

## Scenarios

### Store owns authoritative durable state
- Given the orchestrator needs the current graph and agent-run state
- When it loads or persists durable workflow state
- Then `Store` is the authority for persisted graph state and recovery state through `StoreGraphState` and `StoreRecoveryState`
- And `loadRecoveryState()` returns graph state together with recovery-critical agent-run records
- And `saveGraphState()` persists the authoritative graph state without reintroducing snapshot-shaped persistence contracts
- And recovery-critical run fields such as status, owner, retry timing, and session pointers persist through that boundary
- And event records cross that same persistence boundary through `appendEvent()` and `listEvents()`

### Git operations use simple-git directly
- Given the orchestrator needs a feature branch, a task worktree, a task merge, a feature rebase, or overlap scan results
- When it performs repository-facing collaboration work
- Then those actions use `simple-git` directly rather than a port abstraction
- And branch/worktree naming conventions live in `@core/naming`

### RuntimePort owns task process lifecycle
- Given a task needs to dispatch, suspend, resume, abort, or stop with the rest of the runtime
- When the orchestrator controls live task execution
- Then it does so through `RuntimePort`
- And runtime dispatch, steering, control, and IPC-facing contract types stay part of the runtime-owned boundary rather than the orchestrator package

### AgentPort owns feature-phase agent work
- Given the system needs feature-level discuss, research, planning, verification, summary, or replanning work
- When the orchestrator dispatches that phase work
- Then it uses `AgentPort`
- And those feature phases still participate in the same run/session plane as task execution (`agent_runs`, persisted conversation state, retry/backoff, help/approval/manual ownership, recovery)
- And `AgentPort` is the semantic dispatch surface for that work, not evidence of a separate execution plane

### UiPort stays presentation-only
- Given the terminal UI must show state, refresh derived views, and dispose cleanly
- When user-facing presentation behavior occurs
- Then it flows through `UiPort`
- And the UI does not become the authoritative owner of graph or run state

### OrchestratorPorts is the full coordination seam
- Given the orchestrator is assembled for a runnable application
- When its dependencies are provided
- Then `OrchestratorPorts` supplies store, runtime, agents, UI, and config together as the orchestration boundary
- And swapping implementations at that seam does not change the orchestrator's workflow contract

### Scheduler events are typed and processed serially
- Given the orchestrator scheduler receives events from workers, feature-phase agents, and internal signals
- When an event arrives
- Then it is enqueued as a typed `SchedulerEvent` into the serial event queue
- And the scheduler tick drains and processes events one at a time before computing the ready frontier
- And no concurrent event processing occurs within the orchestrator's coordination core

### State transitions are validated by pure FSM guards
- Given the orchestrator needs to transition a feature's work-control or collab-control state
- When the transition is proposed
- Then it is validated by a pure `core/fsm` guard function that checks both axes together
- And invalid transitions are rejected before any persistence write occurs
- And the guard functions have no side effects and no dependencies outside of `core`
