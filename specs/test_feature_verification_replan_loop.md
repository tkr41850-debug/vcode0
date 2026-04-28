# test_feature_verification_replan_loop

## Goal

Capture the replan loop when pre-queue `ci_check` or agent-level `verifying` fails before merge-queue entry. Both failure shapes route to `replanning` with persisted `VerifyIssue[]` so the replanner proposes the next task set.

## Scenarios

### Feature ci_check failure routes through replanning
- Given all task work for a feature has landed on the feature branch
- And the feature is in `ci_check`
- When the configured heavy feature checks fail
- Then the feature does not enter `merge_queued`
- And the accumulated issues are persisted onto `features.verify_issues` with `source: 'ci_check'`
- And feature work control moves to `replanning`
- And the orchestrator does not directly create follow-up tasks outside replanning
- And the replanner consumes `verifyIssues` and proposes the next task set

### Feature verification failure routes through replanning
- Given heavy feature CI has already passed
- And the feature is in agent-level `verifying`
- When the verify agent emits blocking or concern `VerifyIssue[]` via `raiseIssue`
- Then the accumulated issues are persisted onto `features.verify_issues`
- And feature work control moves to `replanning`
- And the orchestrator does not directly create follow-up tasks for verify failures outside replanning
- And the replanner consumes `verifyIssues` and proposes the next task set
- And on approved replan, `verifyIssues` clears and new or modified tasks land on the same feature branch

### Replan-driven work must land before ci_check reruns
- Given an approved replan has added or modified tasks after a pre-queue verification failure
- When that work is still incomplete
- Then the feature does not re-run `ci_check` yet
- And it does not become merge-ready early

### Passing rerun is required before merge-queue entry
- Given replan-driven work for a pre-queue verification failure has landed
- When the orchestrator reruns `ci_check` and then `verifying` on the feature branch
- Then the feature may enter `merge_queued` only if that full rerun path passes

### Repeated verify→replan cycles emit a warning
- Given a feature has gone through multiple `verify → replan → verify` cycles without passing
- When the failed verify count since the last `plan` or `replan` completion reaches `warnings.verifyReplanLoopThreshold`
- Then a `verify_replan_loop` `warning_emitted` event fires with `{ failedVerifyCount }`
- And the warning resets when the next replan completes
