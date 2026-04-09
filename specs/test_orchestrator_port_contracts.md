# test_orchestrator_port_contracts

## Goal

Capture the responsibility split across the orchestrator adapter ports so orchestration logic can coordinate work without owning every side effect directly.

## Scenarios

### Store owns authoritative durable state
- Given the orchestrator needs the current graph and agent-run state
- When it loads or persists durable workflow state
- Then `Store` is the authority for graph snapshots and agent-run records
- And recovery-critical run fields such as status, owner, retry timing, and session pointers persist through that boundary
- And event records cross that same persistence boundary through `appendEvent()`

### GitPort owns repository and worktree operations
- Given the orchestrator needs a feature branch, a task worktree, a task merge, a feature rebase, or overlap scan results
- When it performs repository-facing collaboration work
- Then those actions go through `GitPort`
- And git-specific mechanics stay out of the scheduler and state model

### RuntimePort owns task process lifecycle
- Given a task needs to dispatch, suspend, resume, abort, or stop with the rest of the runtime
- When the orchestrator controls live task execution
- Then it does so through `RuntimePort`
- And runtime-dispatch options such as resume mode and session identifiers stay part of the runtime boundary

### AgentPort owns feature-phase agent work
- Given the system needs feature-level discuss, research, planning, verification, summary, or replanning work
- When the orchestrator dispatches that phase work
- Then it uses `AgentPort`
- And feature-phase agent responsibilities stay separate from task-runtime process control

### UiPort stays presentation-only
- Given the terminal UI must show state, refresh derived views, and dispose cleanly
- When user-facing presentation behavior occurs
- Then it flows through `UiPort`
- And the UI does not become the authoritative owner of graph or run state

### OrchestratorPorts is the full coordination seam
- Given the orchestrator is assembled for a runnable application
- When its dependencies are provided
- Then `OrchestratorPorts` supplies store, git, runtime, agents, UI, and config together as the orchestration boundary
- And swapping implementations at that seam does not change the orchestrator's workflow contract
