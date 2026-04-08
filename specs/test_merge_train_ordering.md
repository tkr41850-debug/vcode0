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

### Queue uses priority and FIFO after dependencies
- Given two independent features are ready to integrate
- When one belongs to a higher-priority milestone
- Then the higher-priority feature is selected first
- And ties fall back to queue order

### Feature finishes integration before next begins
- Given one feature is at the head of the merge train
- When it rebases, verifies, and merges successfully
- Then the next queued feature may enter `integrating`
- And not before
