# test_orchestrator_port_contracts

## Goal

Capture current responsibility split across orchestrator graph and adapter seams so orchestration logic can coordinate work without owning every side effect directly.

## Scenarios

### FeatureGraph owns durable graph state
- Given orchestrator needs authoritative milestone / feature / task / dependency state
- When it loads or persists graph mutations
- Then that authority lives on `FeatureGraph` implementation boundary
- And current durable implementation is `PersistentFeatureGraph`
- And graph persistence does not flow through `Store`

### Store owns agent runs and events only
- Given orchestrator needs persisted run/session state and event history
- When it reads or writes through `Store`
- Then `Store` owns `agent_runs` queries and updates
- And `Store` owns append/list access for event records
- And `Store` does not become graph-state persistence surface

### Git operations use simple-git directly
- Given orchestrator needs feature branch, task worktree, merge, rebase, or overlap scan behavior
- When it performs repository-facing collaboration work
- Then those actions use `simple-git` directly rather than separate port abstraction
- And branch/worktree naming conventions live in `@core/naming`

### RuntimePort owns task process/session lifecycle
- Given task needs dispatch, suspend, resume, abort, or global stop
- When orchestrator controls live task execution
- Then it does so through `RuntimePort`
- And runtime-owned IPC/control contract types stay on runtime boundary rather than orchestrator package

### PiFeatureAgentRuntime owns feature-phase agent work
- Given system needs feature-level discuss, research, planning, verification, summary, or replanning work
- When orchestrator dispatches that work
- Then it uses `PiFeatureAgentRuntime` (wired into `OrchestratorPorts.agents`)
- And those phases share same `agent_runs`/session plane as task execution rather than living in separate persistence model
- And phase completion is reported through structured phase submit tools rather than trailing free-text summaries

### VerificationService owns feature verification checks
- Given feature reaches `ci_check` or verification boundary
- When orchestrator needs concrete verification execution
- Then it calls `VerificationService` (wired into `OrchestratorPorts.verification`)
- And semantic feature-phase verdicts remain distinct from raw verification command execution

### UiPort stays presentation-only
- Given terminal UI must show state, refresh derived views, and dispose cleanly
- When user-facing presentation behavior occurs
- Then it flows through `UiPort`
- And UI does not become authoritative owner of graph or run state

### OrchestratorPorts is full coordination seam
- Given runnable orchestrator is composed from external collaborators
- When dependencies are provided
- Then `OrchestratorPorts` supplies `store`, `runtime`, `agents`, `verification`, `ui`, and `config`
- And swapping implementations at that seam does not change orchestrator workflow contract

### Scheduler events are typed and processed serially
- Given scheduler receives worker messages, feature-phase events, and internal signals
- When event arrives
- Then it is enqueued as typed `SchedulerEvent`
- And scheduler tick drains/processes events one at time before recomputing ready frontier
- And no concurrent event processing occurs inside coordination core

### State transitions are validated by pure FSM guards
- Given orchestrator needs to transition feature or task state
- When transition is proposed
- Then pure `@core` FSM/state guards validate legality before durable write
- And invalid transitions are rejected before persistence mutation occurs
