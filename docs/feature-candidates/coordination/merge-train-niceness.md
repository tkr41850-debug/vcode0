# Feature Candidate: Fine-Grained Merge-Train Priority

## Status

Future feature candidate. Do not treat this as part of the baseline architecture yet.

## Baseline

Merge-train queue ordering:

1. Manual position (absolute override)
2. Re-entry count descending
3. Entry sequence ascending

Manual position is a nullable `merge_train_manual_position` field. Operators pin features ahead of automatic ordering but cannot bucket or nudge.

## Candidate

An htop-style niceness scheme where each feature carries a priority value (for example `-20..+19`). Operators adjust a feature's priority up or down from the TUI without computing absolute positions. Priority combines with automatic signals (re-entry count, entry sequence) in a weighted sort rather than a strict override chain.

Benefits:

- Relative nudges are easier to reason about than absolute positions
- Multiple features can share a priority bucket cleanly
- TUI interaction is lightweight (single-key priority increment/decrement)

## Why Deferred

The baseline absolute-override manual position covers the primary operator need of pushing one urgent feature ahead. Priority buckets add:

- TUI interaction complexity
- Queue-state persistence for priority values
- Sort weighting rules that must be intuitive and stable
- Interaction with re-entry priority (starvation potential — see related concern)

Absolute-override suffices until operator feedback indicates otherwise.

## Related

- [Feature Candidate: Arbitrary Merge-Train Manual Ordering](./arbitrary-merge-train-manual-ordering.md)
- [Concern: Merge-Train Re-entry Starvation](../../concerns/merge-train-reentry-starvation.md)
