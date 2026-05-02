# Concern: Merge-Train Re-entry Cap

## Concern

`mergeTrainReentryCount` now has a hard cap, but a feature can still churn through repeated integration failures until that cap is reached. Alternating failure sources (rebase conflict, post-rebase `ci_check` failure, persistent verify issues) may consume multiple merge-train turns before the system parks the feature for manual intervention.

## Why to Watch

Feature churn warnings still fire on re-entry, and the hard cap now prevents infinite cycling. Replan-loop counters remain the earlier-warning signal, but pathological cases where different failure sources alternate may evade per-source thresholds and accumulate enough re-entries to consume queue bandwidth before the cap escalates the feature.

## What to Observe

- `mergeTrainReentryCount` growing past ~10 for any feature
- Feature churn warning frequency per feature
- Re-entry rate relative to successful merges across the fleet

## Current Position

**Enforced as of Phase 6.** A configurable hard cap (`reentryCap`, default 10) is now enforced in `failIntegration`: when `mergeTrainReentryCount` reaches the cap, the feature is parked in the inbox with a `merge_train_cap_reached` item rather than receiving a repair task. Replan-loop counters remain the primary early-warning signal for stuck features; the re-entry cap is the hard backstop that escalates to human intervention after N failures.

## Executable coverage

- `test/unit/core/merge-train.test.ts` covers re-entry count increments, queue ordering, cap-reached results, and enqueue rejection once the cap is already reached.
- `test/integration/merge-train.test.ts` covers scheduler integration for cap-reached inbox escalation and secondary-feature progress.
- `test/unit/core/warnings.test.ts` covers `feature_churn` warnings around re-entry count thresholds.

The remaining watchpoint is operational: alternating failure sources can still spend turns before the hard cap parks the feature. Track the central status in [Testing / Concerns-to-tests traceability](../operations/testing.md#concerns-to-tests-traceability).

## Related

- [Operations / Verification and Recovery](../operations/verification-and-recovery.md)
- [Operations / Warnings](../operations/warnings.md)
- [Concern: Merge-Train Re-entry Starvation](./merge-train-reentry-starvation.md)
