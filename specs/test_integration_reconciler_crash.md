# test_integration_reconciler_crash

## Goal

Capture the startup reconciler's decision tree for resuming after a crash during integration. Git refs are authoritative; the `integration_state` marker row is the two-phase-commit anchor between `git merge` and the DB transition.

## Scenarios

### No marker, main unchanged — clean resume
- Given no `integration_state` row exists
- And `main` points to the same SHA as the last known orchestrator snapshot
- When the reconciler runs at startup
- Then no recovery action is taken
- And the scheduler loop starts normally

### No marker, main moved to unknown SHA — halt
- Given no `integration_state` row exists
- And `main` points to a SHA the orchestrator did not produce (external push)
- When the reconciler runs
- Then the merge train is halted
- And a warning is emitted describing the external-push condition
- And the operator must confirm before merge-train work resumes

### Marker present, main == expectedParentSha — retry integration
- Given an `integration_state` row with `expectedParentSha = X`
- And `main` is still at `X`
- When the reconciler runs
- Then the executor infers `git merge` never ran
- And the marker row is cleared
- And the feature returns to `merge_queued` for a fresh integration attempt (marker + subprocess will restart on selection)

### Marker present, main at a valid merge commit — complete DB tx
- Given an `integration_state` row for feature A with `expectedParentSha = X` and `featureBranchPreIntegrationSha = Y`
- And `main` points to a merge commit whose parent 1 == `X` and parent 2 == the feature branch tip
- When the reconciler runs
- Then the DB transition is completed from the marker: `features.main_merge_sha` is set, `features.branch_head_sha` is set, `collabControl='merged'`, `workControl='summarizing'`
- And the marker row is cleared
- And the feature proceeds into `summarizing` on the next scheduler tick

### Marker present, ambiguous main — halt for manual intervention
- Given an `integration_state` row
- And `main` is at a SHA that is neither `expectedParentSha` nor a valid two-parent merge matching the recorded feature tip
- When the reconciler runs
- Then the merge train is halted
- And a warning is emitted describing the ambiguous state
- And no automatic recovery is attempted

### Reconciler is idempotent
- Given the reconciler has already run once on a given state
- When the reconciler runs again on the same state
- Then no additional side effects occur (no duplicate DB transitions, no duplicate warnings for the same marker row)
