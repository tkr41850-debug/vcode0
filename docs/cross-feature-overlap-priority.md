# Cross-Feature Overlap Priority

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the high-level architecture index.

## Purpose

This document isolates the baseline policy for choosing the **primary** and **secondary** feature when cross-feature runtime overlap is detected. Keeping it separate makes it easier to tune the ranking policy later without rewriting the main conflict-resolution flow.

## Baseline Ranking Policy

Choose **primary** and **secondary** once per feature pair, not per file, to avoid split-brain ownership.

Ranking order:
1. explicit dependency predecessor wins
2. higher derived merge-proximity tuple wins: compare `collabRank(feature.collabControl)` first, then `workRank(feature.workControl)`
3. older feature request / branch-open time wins
4. feature blocking more downstream dependents wins
5. larger changed-line count wins
6. lexical feature id is the final tie-breaker

Baseline derived ranks:
- `collabRank`: `integrating=3`, `merge_queued=2`, `branch_open=1`, `none=0`, `conflict=-1`
- `workRank`: `awaiting_merge=5`, `verifying=4`, `feature_ci=3`, `executing_repair=2`, `executing=1`, `planning|researching|discussing=0`, `replanning=-1`, `summarizing|work_complete=-1`

## Notes

- The policy is derived from existing work-control and collaboration-control axes rather than introducing a third persisted priority state machine.
- This ranking is baseline policy, not an immutable contract. If real behavior proves surprising, this document is the intended place to tune the priority rules.

## Related

- [File-Lock Conflict Resolution](./file-lock-conflict-resolution.md)
