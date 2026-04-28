# test_integration_cross_feature_blocked_reroute

## Goal

Capture that after feature A merges successfully, a downstream feature B that now conflicts with the new `main` is the one routed to `replanning` — not feature A. The blocked feature in `release.featureId` receives the synthesized `source: 'rebase'` `VerifyIssue[]`.

## Scenarios

### Blocked downstream feature reroutes to replanning
- Given feature A and feature B both modify the same file on different feature branches
- And feature A is `integrating`, feature B is `branch_open` or `merge_queued`
- When feature A integrates successfully and reaches `merged`
- And cross-feature overlap release computes `release.kind === 'replan_needed' | 'blocked'` with `release.featureId === B`
- Then feature B's `workControl` moves to `replanning`
- And `features.verify_issues` for B is set with one or more `source: 'rebase'` entries referencing the overlapping files
- And if B was already `merge_queued`, it is ejected
- And feature A stays `merged` with no change to its state

### Feature A receives no replan from its own successful merge
- Given feature A merges successfully
- When the release loop fires for downstream blocked features
- Then feature A is not added to the replanning pool
- And feature A's `verifyIssues` is not modified by the release loop

### Multiple downstream features each reroute independently
- Given features B and C both overlap with feature A's changes
- When feature A merges
- Then both B and C receive synthesized `source: 'rebase'` `VerifyIssue[]` on their own rows
- And each routes to `replanning` independently
- And each may re-enter the queue independently once approved replan tasks land
