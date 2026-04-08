# test_crash_recovery

## Goal

Capture restart behavior when work is in flight.

## Scenarios

### Running task with session resumes
- Given the orchestrator restarts while a task is `running`
- And the task has a stored `session_id`
- When recovery runs
- Then the task resumes through `SessionHarness.resume()`
- And its worktree rebases onto the current feature branch HEAD first

### Running task without session resets
- Given the orchestrator restarts while a task is `running`
- And the task has no stored `session_id`
- When recovery runs
- Then the task resets to `pending`
- And may be dispatched again later

### Feature branch remains authoritative across restart
- Given a feature branch already contains merged task work
- When the orchestrator restarts
- Then that feature branch remains the source of truth for subsequent task worktrees and integration
