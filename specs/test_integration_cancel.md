# test_integration_cancel

## Goal

Capture hard cancellation of a feature that is mid-integration. The feature branch resets to its pre-integration state, the integration-worker subprocess is killed, and the marker row is cleared. Graceful cancellation (waiting for the current sub-step to finish) is deferred.

## Scenarios

### Hard cancel during rebase
- Given feature A is `integrating` with the marker row written
- And the integration-worker subprocess is currently running `git rebase`
- When the operator cancels feature A
- Then the marker row `intent` flips to `'cancel'` in the same DB transaction as feature-state update
- And the integration-worker subprocess is killed
- And the feature branch is reset to `featureBranchPreIntegrationSha` (no rebase commits remain)
- And the marker row is cleared
- And feature A's `collabControl` becomes `cancelled`

### Hard cancel during post-rebase ci_check
- Given feature A is `integrating` and the subprocess is running post-rebase `ci_check`
- When the operator cancels feature A
- Then the subprocess is killed mid-check
- And the feature branch is reset to `featureBranchPreIntegrationSha`
- And the marker row is cleared
- And no partial `ci_check` result is persisted as a `VerifyIssue`

### Cancel is a no-op once merge has landed
- Given feature A's executor has completed `git merge` but the clearing DB transaction has not yet committed
- When the operator cancels feature A
- Then cancel is rejected (or queued behind the reconciler completion path)
- And the feature ultimately reaches `merged` via the reconciler (or via the in-flight tx), not `cancelled`
- And `main` retains the merge commit
