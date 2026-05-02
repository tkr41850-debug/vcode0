# Concern: Verification and Repair Churn

## Concern

The baseline execution path includes several expensive gates: task submit checks, feature CI, agent-level spec review in `verifying`, and merge-train verification after rebase. Failures can loop back into repair work and rerun those gates.

## Why to Watch

This may dominate runtime and token/cpu cost before the DAG scheduler's parallelism benefits fully pay off. The system could spend a large amount of effort repeatedly re-verifying nearly the same feature branch state.

## What to Observe

- repeated repair-task creation on the same feature
- frequent ejection/re-entry from the merge train
- long time spent in `ci_check`, `verifying`, or `executing_repair`
- repeated feature churn warnings
- high verification-to-implementation time ratio

## Current Position

This is acceptable for the baseline, but it should be watched in real usage before adding reuse/caching complexity.

## Executable coverage

- `test/unit/orchestrator/verify-repairs.test.ts` covers verify repair task creation, issue fan-out, reservation mapping, and repair-cap escalation.
- `test/integration/feature-lifecycle-e2e.test.ts` covers the execute → `ci_check` → verify rerun after a verify repair task lands.
- `test/unit/core/warnings.test.ts` covers warning signals adjacent to churn, including feature churn and empty verification checks.
- `specs/test_feature_verification_repair_loop.md` records the broader verify/replan loop scenarios and warning expectations.

Verification reuse and caching remain deferred optimization work. Track the central status in [Testing / Concerns-to-tests traceability](../operations/testing.md#concerns-to-tests-traceability).

## Related

- [Operations / Verification and Recovery](../operations/verification-and-recovery.md)
- [Optimization Candidate: Verification Reuse](../optimization-candidates/verification-and-recovery.md)
