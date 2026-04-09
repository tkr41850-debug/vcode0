# test_merge_train_ordering

## Goal

Capture serialized feature-branch integration into `main`.

## Scenarios

### Only one feature integrates at a time
- Given two completed features are ready for integration
- When they enter the integration queue
- Then only one feature may have collaboration control `integrating` at a time
- And the other remains `merge_queued`

### Queue respects dependency legality first
- Given feature B depends on feature A
- When both features are otherwise ready to integrate
- Then feature A must integrate before feature B

### Queue stays serialized after dependencies are satisfied
- Given two independent features are ready to integrate
- When they both enter the integration queue
- Then exactly one feature is selected first according to the merge-train queue policy
- And the other remains queued until the first finishes

### Milestone steering uses ordered queue position before queueing, not merge ordering
- Given a user queues milestones M1 then M2 while ready work exists in M1, M2, and an unqueued milestone
- When the scheduler chooses new work before a feature reaches `awaiting_merge`
- Then ready work in M1 sorts ahead of ready work in M2
- And unqueued work falls behind both in the effective `∞` bucket
- And merge-train ordering remains a separate policy once features are queued

### Feature finishes integration before next begins
- Given one feature is at the head of the merge train
- When it rebases, verifies, and merges successfully
- Then the next queued feature may enter `integrating`
- And not before
