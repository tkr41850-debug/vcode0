# test_fs_lock_detection

## Goal

Capture same-feature file-lock detection and suspension.

## Scenarios

### Same-feature overlap suspends one task
- Given two task worktrees in the same feature branch modify the same file
- When the orchestrator polls for overlapping writes
- Then the worktree with fewer changes is suspended
- And task collaboration control becomes `suspended`

### Suspension details are persisted
- Given a task is suspended for file lock
- When the suspension is recorded
- Then SQLite stores `suspend_reason = file_lock`
- And the affected file list is persisted

### Suspended task receives IPC before stop
- Given a task is about to be suspended
- When suspension occurs
- Then the worker receives a `suspend` IPC message with the overlapping files
- And only then is the child process stopped
