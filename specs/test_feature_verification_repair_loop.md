# test_feature_verification_repair_loop

## Goal

Capture the repair loop when `ci_check` or agent-level `verifying` fails before merge-queue entry. `ci_check` and `verifying` use different recovery paths: `ci_check` enqueues an orchestrator-created repair task directly; `verifying` hands off to `replanning` with persisted `VerifyIssue[]` so the replanner proposes the next task set.

## Scenarios

### Feature CI failure creates repair task on same branch
- Given all task work for a feature has landed on the feature branch
- And the feature is in `ci_check`
- When the configured heavy feature checks fail
- Then the feature does not enter `merge_queued`
- And feature work control moves to `executing_repair`
- And the orchestrator enqueues a repair task on the same feature branch

### Feature verification failure routes through replanning
- Given heavy feature CI has already passed
- And the feature is in agent-level `verifying`
- When the verify agent emits blocking or concern `VerifyIssue[]` via `raiseIssue`
- Then the accumulated issues are persisted onto `features.verify_issues`
- And feature work control moves to `replanning` (not `executing_repair`)
- And the orchestrator does not directly create a repair task for verify failures
- And the replanner consumes `verifyIssues` and proposes the next task set
- And on approved replan, `verifyIssues` clears and new/modified tasks land on the same feature branch

### Repair work must land before `ci_check` reruns
- Given a `ci_check` failure has created a repair task, or an approved replan has added new tasks
- When that work is still incomplete
- Then the feature does not re-run `ci_check` yet
- And it does not become merge-ready early

### Passing rerun is required before merge-queue entry
- Given repair or replan-driven work for a pre-queue verification failure has landed
- When the orchestrator reruns `ci_check` and then `verifying` on the feature branch
- Then the feature may enter `merge_queued` only if that full rerun path passes

### Repeated verify→replan cycles emit a warning
- Given a feature has gone through multiple `verify → replan → verify` cycles without passing
- When the failed verify count since the last `plan`/`replan` completion reaches `warnings.verifyReplanLoopThreshold`
- Then a `verify_replan_loop` `warning_emitted` event fires with `{ failedVerifyCount }`
- And the warning resets when the next replan completes
