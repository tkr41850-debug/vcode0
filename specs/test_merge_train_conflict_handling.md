# test_merge_train_conflict_handling

## Goal

Capture high-level merge-queue framing for integration-stage failures. The executor protects `main` by ejecting and rerouting any failing feature to `replanning` with a typed `VerifyIssue[]`. Specific executor scenarios live in dedicated specs:

- Rebase conflict — [test_integration_rebase_conflict](./test_integration_rebase_conflict.md)
- Post-rebase `ci_check` failure — [test_integration_post_rebase_ci_fail](./test_integration_post_rebase_ci_fail.md)
- Cross-feature blocked reroute — [test_integration_cross_feature_blocked_reroute](./test_integration_cross_feature_blocked_reroute.md)
- Reconciler after crash — [test_integration_reconciler_crash](./test_integration_reconciler_crash.md)
- Hard cancellation — [test_integration_cancel](./test_integration_cancel.md)

## Scenarios

### Cross-feature work may still progress before integration-time conflict
- Given two feature branches both modify the same file
- When tasks complete within their own features
- Then no task-level file-lock reset to `main` occurs
- And both features may still reach `merge_queued`

### Any integration-stage failure reroutes to replanning, not repair
- Given a feature in `integrating` hits any executor failure (rebase conflict, post-rebase `ci_check` fail)
- When the executor observes the failure
- Then the feature is ejected from the merge queue
- And `features.verify_issues` is set with a typed payload keyed by `source`
- And `workControl` moves to `replanning`
- And `mergeTrainReentryCount` increments on re-queue
- And no repair task is created directly by the executor

### Successful replan re-enters under the normal queue policy
- Given approved replan tasks land on the same feature branch
- When the feature passes the normal `ci_check` then `verifying` path again
- Then the feature returns to `awaiting_merge`
- And it re-enters `merge_queued` under the normal automatic queue policy
