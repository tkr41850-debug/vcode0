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

### Resolved same-feature conflict returns to normal task flow
- Given a task was in same-feature collaboration `conflict`
- When the task agent resolves the conflict and later passes normal `submit` verification
- Then task collaboration control clears from `conflict`
- And the task returns to the normal completion path

### Conflict markers are resolved but normal verification still fails
- Given a task was in same-feature collaboration `conflict`
- When the task agent resolves the merge conflict but later fails ordinary `submit` verification
- Then the task leaves the collaboration-conflict case
- And it returns to the ordinary execution / verification loop rather than remaining a conflict-only incident
