# test_integration_post_rebase_ci_fail

## Goal

Capture how the integration executor handles a clean rebase followed by a failing post-rebase `ci_check`. Failure routes to `replanning` with `source: 'ci_check', phase: 'post_rebase'`, not to a repair task.

## Scenarios

### Post-rebase ci_check failure ejects and reroutes
- Given feature A is at `integrating` with the integration marker written (including `configSnapshot` of `verification.feature`)
- And `git rebase` onto latest `main` completes cleanly
- When the executor runs post-rebase `ci_check` using the snapshotted `verification.feature` commands
- And one or more configured checks exit non-zero
- Then feature A is ejected from the merge queue
- And `features.verify_issues` is set with `source: 'ci_check', phase: 'post_rebase'` entries carrying `checkName`, `command`, optional `exitCode`, and truncated `output` (4KB cap)
- And feature A's `workControl` moves to `replanning`
- And the integration marker row is cleared

### Config snapshot shields post-rebase from mid-cycle config edits
- Given the marker row captured `verification.feature` at integration begin
- When `verification.feature` in `.gvc0/config.json` is edited mid-integration
- Then the post-rebase `ci_check` uses the snapshotted commands, not the live config
- And pre-verify `ci_check` and post-rebase `ci_check` within the same integration cycle run identical commands

### Empty verification.feature emits a single cycle warning
- Given `verification.feature.checks` is empty at integration begin
- When the executor runs post-rebase `ci_check`
- Then the phase passes (empty checks are advisory, not blocking)
- And exactly one `warning_emitted` event is written for the `integration_config` empty-checks warning, deduped by the marker row for this cycle
