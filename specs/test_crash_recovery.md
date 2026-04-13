# test_crash_recovery

## Goal

Capture restart behavior when work is in flight.

## Scenarios

### Running task with session resumes
- Given the orchestrator restarts while a task is `running`
- And the task execution run has a stored `agent_runs.session_id`
- When recovery runs
- Then the task resumes through resume dispatch plus `SessionHarness.resume()`
- And its worktree rebases onto the current feature branch HEAD first

### Running task without session resets
- Given the orchestrator restarts while a task is `running`
- And the task execution run has no stored `agent_runs.session_id`
- When recovery runs
- Then the run resets to `ready`
- And `owner` becomes `system`
- And automatic system ownership may dispatch it again later

### Retry wait survives restart
- Given the orchestrator restarts while a task execution run is `retry_await`
- And its `retry_at` is persisted
- When recovery runs
- Then the run remains in `retry_await`
- And the original backoff window is preserved

### Await-response survives restart
- Given the orchestrator restarts while a run is `await_response`
- And its unanswered human-help payload is persisted
- When recovery runs
- Then the run remains `await_response`
- And it does not resume automatic execution on its own

### Await-approval survives restart
- Given the orchestrator restarts while a run is `await_approval`
- And its proposal payload is persisted
- When recovery runs
- Then the run remains `await_approval`
- And it stays blocked pending approval

### Feature-phase run resumes from persisted conversation state
- Given the orchestrator restarts while a resumable feature-phase run was `running`
- And the planner or replanner has persisted its conversation state to disk
- When recovery runs
- Then the orchestrator resumes that feature-phase run from the persisted conversation state

### Agent run session id is the authoritative recovery pointer
- Given both `agent_runs.session_id` and `tasks.session_id` exist for task execution state
- When recovery runs
- Then `agent_runs.session_id` is treated as authoritative
- And `tasks.session_id` remains only a compatibility/task-facing field

### Feature branch remains authoritative across restart
- Given a feature branch already contains merged task work
- When the orchestrator restarts
- Then that feature branch remains the source of truth for subsequent task worktrees and integration
