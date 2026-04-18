# test_feature_verification_repair_loop

## Goal

Capture the repair loop when `ci_check` or agent-level `verifying` fails before merge-queue entry.

## Scenarios

### Feature CI failure blocks merge-queue entry
- Given all task work for a feature has landed on the feature branch
- And the feature is in `ci_check`
- When the configured heavy feature checks fail
- Then the feature does not enter `merge_queued`
- And feature work control moves to `executing_repair`

### Feature verification failure also creates repair work on the same branch
- Given heavy feature CI has already passed
- And the feature is in agent-level `verifying`
- When that spec review returns a structured repair-needed verdict
- Then the feature remains on the same feature branch
- And feature work control moves to `executing_repair`
- And repair work is created on the same branch

### Repair work must land before feature CI reruns
- Given a `ci_check` or `verifying` failure has already created repair work
- When that repair work is still incomplete
- Then the feature does not re-run `ci_check` yet
- And it does not become merge-ready early

### Passing rerun is required before merge-queue entry
- Given repair work for a pre-queue verification failure has landed
- When the orchestrator reruns `ci_check` and then `verifying` on the feature branch
- Then the feature may enter `merge_queued` only if that full rerun path passes
