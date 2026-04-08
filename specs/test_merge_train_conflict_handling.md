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

### Conflict triggers follow-up work or replanning
- Given a feature is in integration conflict
- When the orchestrator cannot auto-resolve the issue
- Then feature work control moves to `replanning`
- And follow-up work may be scheduled on the feature branch before requeueing
