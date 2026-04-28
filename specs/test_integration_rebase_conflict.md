# test_integration_rebase_conflict

## Goal

Capture how the in-process integration executor handles a `git rebase` conflict when the integrating feature cannot replay its commits onto the latest `main`. Failure routes to `replanning` with a typed `VerifyIssue[]` of `source: 'rebase'`, not to a repair task.

## Scenarios

### Rebase conflict ejects the feature and reroutes to replanning
- Given feature A is at `integrating`, having written the integration marker row (`expectedParentSha`, `featureBranchPreIntegrationSha`, `configSnapshot`, `intent='integrate'`)
- And `git rebase` onto the latest `main` cannot be completed cleanly
- When the executor observes the rebase conflict
- Then feature A is ejected from the merge queue (`integrating → branch_open`, `mergeTrainReentryCount` increments)
- And `features.verify_issues` is set to a typed payload with one or more entries of `source: 'rebase'` listing `conflictedFiles`
- And feature A's `workControl` moves to `replanning`
- And the integration marker row is cleared
- And no repair task is created by the executor

### Post-replan re-enqueue uses `--onto` anchor
- Given feature A has completed approved replanning with reconciliation tasks landing on the same feature branch
- And feature A returns to `awaiting_merge` then `merge_queued`
- When the executor rebases feature A onto the newer `main`
- Then the rebase uses `git rebase --onto <newMain> <featureBranchPreIntegrationSha> HEAD`
- And the stale first-rebase layer dropped from the prior eject is not replayed
- And git `rerere` is enabled so known prior resolutions apply automatically

### Cross-feature rebase conflict is not confused with integration rebase
- Given feature A merges successfully and sits `merged`
- When cross-feature overlap release produces `release.kind === 'replan_needed'` for downstream feature B
- Then the `source: 'rebase'` `VerifyIssue[]` is persisted on feature B (`release.featureId`), not on feature A
- And feature B routes to `replanning`; feature A remains `merged`
