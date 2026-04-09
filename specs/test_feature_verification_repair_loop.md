# test_feature_verification_repair_loop

## Goal

Capture the repair loop when feature-level verification fails before merge-queue entry.

## Scenarios

### Feature verification failure blocks merge-queue entry
- Given all task work for a feature has landed on the feature branch
- And the feature is at the queue-entry verification boundary on that branch
- When the configured feature verification checks fail
- Then the feature does not enter `merge_queued`
- And the feature remains on the same feature branch

### Feature verification failure creates repair work on the same branch
- Given feature verification fails before queueing
- When the orchestrator processes that failure
- Then it creates repair work on the same feature branch
- And returns the feature to normal execution on that branch

### Repair work must land before feature verification reruns
- Given a feature verification failure has already created repair work
- When that repair work is still incomplete
- Then the feature does not re-run final queue-entry verification yet
- And it does not become merge-ready early

### Passing rerun is required before merge-queue entry
- Given repair work for a feature-verification failure has landed
- When the orchestrator reruns feature verification on the feature branch
- Then the feature may enter `merge_queued` only if that rerun passes
