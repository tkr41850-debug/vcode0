# Concern: Summarize Retry Loop

## Concern

Summarize-phase failures route through the generic `feature_phase_error` handler which schedules a retry with a flat 1-second backoff. There is no replan-loop counter, no escalation, and no fallback to manual intervention. A summarize phase that fails deterministically (e.g. prompt issue, missing context) retries forever and leaves the feature stuck in `summarizing`.

## Why to Watch

Other verify-shaped phases (`ci_check`, `verify`, rebase, post-rebase `ci_check`) route failures through replanning with per-source and aggregate replan-loop counters. Summarize is intentionally excluded from that routing because summary failure does not indicate a code problem. The current handler offers no upper bound, so deterministic failures run forever.

## What to Observe

- Features stuck in `summarizing` with repeated `feature_phase_error` events
- Flat 1-second retry cadence on the same feature
- Token spend on repeated summarize attempts of the same feature

## Current Position

Baseline keeps the flat 1-second retry. A proper fix adds exponential backoff plus a retry cap that escalates to `manual_intervention` or marks the feature as `merged_without_summary`. Treat as follow-up after the core executor work lands.

## Executable coverage

- `test/unit/orchestrator/summaries.test.ts` covers summarize start, budget-mode skip, completion persistence, and empty-summary rejection.
- `test/unit/orchestrator/scheduler-loop.test.ts` covers retry-eligible feature-phase redispatch through the generic scheduler path.

Summarize-specific exponential backoff, retry cap, and escalation remain deferred/no-direct-coverage. Track the central status in [Testing / Concerns-to-tests traceability](../operations/testing.md#concerns-to-tests-traceability).

## Related

- [Feature Candidate: Generalized Phase Timeouts](../feature-candidates/phase-timeouts.md)
- [Operations / Verification and Recovery](../operations/verification-and-recovery.md)
