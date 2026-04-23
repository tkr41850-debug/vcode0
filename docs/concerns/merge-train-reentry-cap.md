# Concern: Merge-Train Re-entry Cap

## Concern

`mergeTrainReentryCount` increments on every eject from the integration queue but is not capped. A feature that fails integration repeatedly (rebase conflicts, post-rebase `ci_check` failures, or persistent verify issues) can re-enter the queue indefinitely.

## Why to Watch

Feature churn warnings fire on re-entry but do not gate. Combined with replan-loop counters (per-source and aggregate), most stuck scenarios should trip a replan-loop threshold before re-entry becomes excessive. Pathological cases where different failure sources alternate may evade per-source thresholds and accumulate re-entries while still completing short replan cycles.

## What to Observe

- `mergeTrainReentryCount` growing past ~10 for any feature
- Feature churn warning frequency per feature
- Re-entry rate relative to successful merges across the fleet

## Current Position

Replan-loop counters are the primary cap for stuck features. Re-entry stays uncapped as a secondary signal. Add a hard cap that escalates to `manual_intervention` after N re-entries if observation shows the primary cap is insufficient.

## Related

- [Operations / Verification and Recovery](../operations/verification-and-recovery.md)
- [Operations / Warnings](../operations/warnings.md)
- [Concern: Merge-Train Re-entry Starvation](./merge-train-reentry-starvation.md)
