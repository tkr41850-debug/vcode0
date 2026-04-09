# test_agent_run_wait_states

## Goal

Capture how run-owned retry/help/approval waits affect dispatchability, derived blocked state, and release behavior for task execution runs, while keeping feature-phase approval/wait semantics visible where they share the same run model.

## Scenarios

### Transient failure enters retry wait
- Given a task execution run hits a transient provider or transport failure
- When the orchestrator handles that failure
- Then `agent_runs.run_status` becomes `retry_await`
- And `agent_runs.retry_at` is written
- And `tasks.status` returns to `ready`

### Retry wait blocks only until retry time
- Given a task execution run is `retry_await`
- And `retry_at` is still in the future
- When the scheduler evaluates readiness
- Then that task is not dispatchable yet
- And the UI renders the task as derived `blocked`

### Expired retry wait becomes dispatchable again
- Given a task execution run is `retry_await`
- And `retry_at` has passed
- When the scheduler evaluates readiness
- Then that task becomes dispatchable again
- And derived `blocked` clears unless another waiting/collaboration condition still applies

### Help wait is not dispatchable
- Given a task execution run is `await_response`
- When the scheduler evaluates readiness
- Then that task is not dispatchable
- And the task remains derived `blocked`

### Approval wait is not dispatchable
- Given a task or feature-phase run is `await_approval`
- When the scheduler evaluates readiness
- Then that run is not dispatchable
- And the owning work remains derived `blocked`

### Release to scheduler preserves unanswered help
- Given a manually owned run is `await_response`
- And its `payload_json` still contains an unanswered `request_help()` query
- When the user triggers `release_to_scheduler`
- Then the run does not return to automatic execution
- And it remains `await_response` with manual ownership

### Release to scheduler restores automatic execution after answer
- Given a manually owned run no longer has unanswered human-help state
- When the user triggers `release_to_scheduler`
- Then the run returns to `ready`
- And `owner` becomes `system`
