# Feature Candidate: Graceful Integration Cancellation

## Status

Future feature candidate. Do not treat this as part of the baseline architecture yet.

## Baseline

Cancellation of a feature during `integrating` is hard:

- the orchestrator flips the integration marker `intent` to `'cancel'` in a transaction
- the active integration-worker subprocess is killed
- the feature branch is reset to `featureBranchPreIntegrationSha`
- the marker is cleared
- feature collaboration control moves to `cancelled`

Any rebase work performed during the cancelled integration cycle is discarded.

## Candidate

A graceful-cancel mode that allows the current integration step to wind down cleanly:

- rebase in progress: complete the rebase, persist it, then stop before moving to post-rebase `ci_check`
- `ci_check` in progress: let the current command finish, skip remaining, emit partial results
- merge in progress: atomic; no graceful cancel is possible here and it falls back to hard cancel

This preserves rebase work that may still be useful when re-integrating later.

## Why Deferred

Hard cancel is simpler and matches baseline hard-cancel semantics at the feature level. Graceful cancel adds:

- intermediate states (`cancelling` with in-flight work) in the marker row
- reconciler logic for partial-cancel, partial-complete scenarios
- TUI indication for graceful-cancel phase
- step-specific wind-down logic per integration sub-phase

Hard cancel is acceptable because integration cycles are expected to be short.

## Related

- [Feature Candidate: Soft Cancel](./soft-cancel.md)
- [Operations / Verification and Recovery](../operations/verification-and-recovery.md)
