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

### Rebase conflict steers existing task without destructive reset
- Given a suspended task had conflicting edits on locked files
- When rebasing onto the updated feature branch cannot auto-resolve cleanly
- Then the task remains in `conflict` collaboration control in the real conflicted worktree
- And the existing task agent receives exact conflict steering context instead of a destructive reset
