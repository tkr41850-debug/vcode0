# test_merge_train_conflict_handling

## Goal

Capture how cross-feature conflicts are resolved during feature integration.

## Scenarios

### Cross-feature overlap is allowed until integration
- Given two feature branches both modify the same file
- When tasks complete within their own features
- Then no task-level file-lock reset to `main` occurs
- And both features may still reach `merge_queued`

### Integration conflict moves feature into conflict state
- Given a queued feature branch rebases onto the latest `main`
- When the rebase or integration checks fail because of another feature's changes
- Then feature collaboration control becomes `conflict`
- And the feature does not merge to `main`

### Conflict triggers repair work on the same feature branch first
- Given a feature hits integration rebase or merge-train verification failure
- When the orchestrator cannot resolve it mechanically
- Then the feature is removed from the merge queue and repair work is scheduled on the same feature branch
- And only repeated or structural failure escalates to `replanning`

### Successful repair returns feature to merge-ready state
- Given integration repair work lands on the same feature branch
- When feature verification passes again
- Then feature collaboration control clears from `conflict`
- And the feature may return to `work_complete` and re-enter `merge_queued`
