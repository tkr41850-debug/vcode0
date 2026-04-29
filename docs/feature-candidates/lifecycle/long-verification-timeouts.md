# Feature Candidate: Long Verification Timeouts

## Status

Future feature candidate. Do not treat this as part of the baseline architecture yet.

## Baseline

Verification timeout values are configurable per layer in `.gvc0/config.json`. The baseline examples use short local-machine windows such as 60 seconds for task checks and 600 seconds for feature / merge-train checks.

## Candidate

A later version could add first-class support for substantially longer-running verification workflows, such as:
- special timeout profiles for slow projects
- different timeout classes for local vs CI-backed checks
- richer progress / heartbeat handling during long verification runs
- more explicit operator controls for extending or resuming long checks

## Why Deferred

This is deferred because the baseline architecture is optimized for local-machine development loops with practical default timeouts that remain editable in config. Longer-running verification is valid, but it adds extra operational and UX complexity that is not needed in the baseline.

## Related

- [Operations / Verification and Recovery](../../operations/verification-and-recovery.md) — configurable verification command lists and timeout settings
