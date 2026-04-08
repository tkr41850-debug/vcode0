# test_fs_lock_resume

## Goal

Capture same-feature resume behavior after a dominant task lands on the feature branch.

## Scenarios

### Dominant task lands first
- Given one suspended task and one dominant task in the same feature
- When the dominant task completes
- Then its worktree is merged into the feature branch

### Suspended task rebases onto updated feature branch
- Given a suspended task waiting on overlapping files
- When the dominant task has merged
- Then the suspended task worktree rebases onto the updated feature branch
- And not onto `main`

### Resume notifies worker about reset files
- Given a suspended task had conflicting edits on locked files
- When those files are reset to the feature branch version
- Then the worker receives a `resume` IPC message with `filesReset`
- And the agent is steered to re-check those files before continuing
