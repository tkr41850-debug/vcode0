# test_conflict_steering

## Goal

Capture the sync recommendation ladder and conflict steering behavior before and after automatic reconciliation attempts.

## Scenarios

### Upstream update is recorded without immediate interruption
- Given another task lands on the same feature branch
- And the changed files do not intersect this task's reserved or actively edited paths
- When the orchestrator observes the upstream update
- Then it records an informational update signal
- And it does not interrupt the running task immediately

### Reserved-path overlap recommends sync at the next checkpoint
- Given upstream changes intersect a task's reserved write paths
- And no active edited-path overlap is known yet
- When the task reaches a stable checkpoint such as end-of-turn or pre-submit
- Then the orchestrator injects a `sync_recommended` steering directive
- And the task may choose to sync before continuing

### Active-path overlap requires sync before continued execution
- Given upstream changes intersect paths the task has already edited or currently locks
- When the orchestrator reaches the next enforcement checkpoint
- Then it pauses or redirects the task into sync work before normal execution continues
- And the runtime steering boundary represents that intent as `sync_required`

### Same-feature rebase conflict steers the existing task in the conflicted worktree
- Given a same-feature rebase cannot be auto-resolved with `ort` merge or similar
- When the orchestrator escalates from required sync to conflict steering
- Then it preserves the conflicted worktree state
- And it steers the existing task agent with concrete git conflict context
- And it does not destructively reset files

### Cross-feature runtime overlap coordinates execution before repair
- Given two active features have only reservation-level overlap before either has landed
- When the orchestrator evaluates scheduler and coordination state
- Then reservation overlap remains a scheduling penalty only
- And active coordination waits until runtime overlap is actually detected

### Cross-feature runtime overlap pauses whole secondary feature before repair
- Given two active features overlap on runtime write paths before either has landed
- When the orchestrator detects a runtime overlap that requires coordination
- Then it pauses the secondary feature's running tasks as one unit
- And later repair still happens on the feature branch if post-primary rebase cannot be resolved cleanly

### Cross-feature repair removes feature from merge queue
- Given a feature reaches the merge train and rebase or verification fails after updating from `main`
- When the orchestrator cannot resolve the failure mechanically
- Then it removes the feature from the merge queue
- And creates or steers repair work on the same feature branch
- And only re-adds the feature after repair plus the normal `feature_ci -> verifying` path succeeds again
