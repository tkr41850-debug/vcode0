# test_merge_train_conflict_handling

## Goal

Capture how integration-stage rebase and merge-train verification failures are handled during feature integration. Protects the invariant that `main` never advances to a state that has not passed merge-train verification at its post-rebase tip (see `docs/architecture/graph-operations.md`).

## Wiring Status

- `integrating`-stage rebase onto latest `main` is part of the baseline merge-train flow.
- `verification.mergeTrain` is parsed in config and carries inheritance rules (falls back to `verification.feature` only when omitted entirely), but the currently wired verification executor is the feature-level `ci_check` path. Scenarios that depend on automatic merge-train verification execution are marked **[deferred]** until that path is wired (see `docs/operations/verification-and-recovery.md`).

## Scenarios

### Cross-feature work may still progress before integration-time conflict
- Given two feature branches both modify the same file
- When tasks complete within their own features
- Then no task-level file-lock reset to `main` occurs
- And both features may still reach `merge_queued`

### Rebase failure moves feature into conflict state
- Given a feature in `integrating` rebases onto the latest `main`
- When that rebase cannot be completed cleanly because of another feature's changes
- Then feature collaboration control becomes `conflict`
- And the feature is removed from the merge queue
- And the feature does not merge to `main`
- And `mergeTrainReentryCount` increments on re-queue

### Merge-train verification failure also ejects the feature [deferred]
- Given a feature in `integrating` rebases cleanly onto the latest `main`
- When the configured merge-train verification checks fail
- Then the feature is removed from the merge queue
- And `main` does not advance
- And it is no longer merge-ready until repair work lands and the normal `ci_check -> verifying` path passes again

### Conflict triggers repair work on the same feature branch first
- Given a feature hits integration rebase failure (or, once wired, merge-train verification failure)
- When the orchestrator cannot resolve it mechanically
- Then repair work is scheduled on the same feature branch
- And only repeated or structural failure escalates to `replanning`

### Successful repair re-enters under the normal queue policy
- Given integration repair work lands on the same feature branch
- When the feature passes the normal `ci_check` then `verifying` path again
- Then feature collaboration control clears from `conflict`
- And the feature returns to `awaiting_merge`
- And it re-enters `merge_queued` under the normal automatic queue policy
