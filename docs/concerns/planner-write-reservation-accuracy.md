# Concern: Planner Write-Reservation Accuracy

## Concern

Reserved write paths are planner-predicted metadata. They influence prompt scoping, scheduling penalties, and early overlap detection, but they are still guesses made before execution begins.

## Why to Watch

If reservations are too broad, parallelism drops because unrelated work is penalized or appears riskier than it really is. If reservations are too narrow, overlap may still be detected late by runtime hooks after expensive work has already happened.

## What to Observe

- frequent mismatch between reserved paths and actual changed files
- repeated late overlap detection despite reservations
- large numbers of glob/directory reservations instead of exact paths
- scheduler underutilization caused by over-conservative reservation overlap

## Current Position

This is acceptable for the baseline because reservations are advisory and runtime overlap handling remains authoritative. Still, the predictive quality of planner reservations should be observed before leaning on them more heavily.

## Executable coverage

- `test/unit/orchestrator/verify-repairs.test.ts` covers mapping file-like verification issue locations into `reservedWritePaths` and leaving non-path locations unset.
- `test/unit/core/proposals.test.ts` covers proposal preservation of `reservedWritePaths` metadata.
- `test/unit/orchestrator/scheduler-loop.test.ts` covers runtime overlap handling that remains authoritative when predicted reservations are incomplete.

Prediction accuracy against actual changed files remains deferred/no-direct-coverage. Track the central status in [Testing / Concerns-to-tests traceability](../operations/testing.md#concerns-to-tests-traceability).

## Related

- [Architecture / Planner](../architecture/planner.md)
- [Operations / Conflict Coordination](../operations/conflict-coordination.md)
