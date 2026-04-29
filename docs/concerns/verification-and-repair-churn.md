# Concern: Verification and Replan Churn

## Concern

The baseline execution path includes several expensive gates: task submit checks, feature CI, agent-level spec review in `verifying`, and merge-train verification after rebase. Failures can loop back into replanning and rerun those gates.

## Why to Watch

This may dominate runtime and token/cpu cost before the DAG scheduler's parallelism benefits fully pay off. The system could spend a large amount of effort repeatedly re-verifying nearly the same feature branch state.

## What to Observe

- repeated replan cycles on the same feature
- frequent ejection/re-entry from the merge train
- long time spent in `ci_check`, `verifying`, or `replanning`
- repeated feature churn warnings
- high verification-to-implementation time ratio

## Current Position

This is acceptable for the baseline, but it should be watched in real usage before adding reuse/caching complexity.

## Related

- [Operations / Verification and Recovery](../operations/verification-and-recovery.md)
- [Optimization Candidate: Verification Reuse](../optimization-candidates/verification-reuse.md)
