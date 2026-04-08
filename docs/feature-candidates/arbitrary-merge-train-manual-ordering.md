# Feature Candidate: Arbitrary Merge-Train Manual Ordering

## Status

Future feature candidate. Do not treat this as part of the baseline architecture yet.

## Baseline

The baseline merge-train policy allows a limited manual override bucket:
- users may manually pin an ordered set of queued features ahead of automatic ordering
- queued features outside that manual block still use the automatic queue policy
- repair ejection / re-entry returns a feature to automatic ordering unless the user reorders again

This keeps the operator model simple while avoiding more complex persistence rules.

## Candidate

A later version could support fully arbitrary persistent manual ordering across the entire queued set, including repeated edits, drag-reorder behavior in the TUI, and explicit persistence of user order as the primary queue authority.

This would let operators treat the merge train more like a manually curated list rather than a mostly automatic queue with a manual override block.

## Short Note on Persistence

A simple nullable `merge_train_manual_position` field is enough for the baseline override bucket.

A fully arbitrary persistent ordering model likely needs more careful queue-state persistence. One possible implementation sketch is a linked-list style structure in SQLite (for example `prev_feature_id` / `next_feature_id` pointers or equivalent queue-link records), but that feels like premature optimization for now.

## Why Deferred

This feature is deferred because it increases:
- persistence complexity
- reorder/update edge cases during repair ejection and re-entry
- TUI interaction complexity
- recovery logic after orchestrator restart

The baseline bucketed override captures the main operator need without taking on the full complexity cost yet.
