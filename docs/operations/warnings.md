# Warnings

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for the high-level architecture overview.

Warnings are **non-failing signals** emitted by the orchestrator to surface cost pressure, verification slowdowns, stalled coordination, and feature churn before they become hard failures. They should be visible in the TUI and emitted into the append-only event log, but they do not by themselves fail a task or feature.

Warnings are a visibility/feedback layer only. They may be useful both for operator awareness and for tool-development feedback, but they are not the source of truth for current scheduler/coordinator state and should not be used for state reconstruction.

## Two-Stage Warning Model

### Stage 1: Single-Level Rules

Start with simple threshold-based warnings:
- one check run takes too long
- one verification category exceeds its duration threshold
- a feature accumulates too many recoveries or queue ejections
- a secondary feature stays blocked too long behind a primary feature
- global budget crosses its warning threshold

These rules are intended to be cheap to implement and easy to interpret. See `emitWarningSignals` and `emitEmptyVerificationChecksWarning` in `src/orchestrator/scheduler/warnings.ts` (lines 22 and 96) for the scheduler warning emission implementation.

### Stage 2: Trend Detection

Later, add drift / trend detection using accumulated history:
- one verification category gets steadily slower over time
- one feature repeatedly dominates repair or requeue events
- one feature pair repeatedly causes overlap blocking
- a repo's warning rate increases across recent runs

Trend detection is advisory and should refine, not replace, the simpler Stage 1 rules.

## Warning Categories

### Budget Warnings

Budget warnings are emitted when configured cost thresholds are crossed, such as `budget.warnAtPercent`.

### Verification Performance Warnings

Verification warnings focus on **how long checks take**, not just whether they pass or fail.

Stage 1 examples:
- a task-level related-test run exceeds its time budget
- a feature-level full test suite exceeds its time budget
- a post-rebase `ci_check` category repeatedly runs longer than its configured absolute threshold
- a verification layer runs with an empty effective `checks[]` list because config was omitted or intentionally left empty

Stage 2 examples:
- task lint gets slower week over week
- post-rebase `ci_check` duration drifts upward across recent integrations

### Replan Loop Warnings

Repeated replan cycles without progress emit warnings. Per-source and aggregate counters both apply:

- `verify_replan_loop` — consecutive `verify` failures since the last successful `plan`/`replan` completion. Threshold `warnings.verifyReplanLoopThreshold` (default `3`).
- `ci_check_replan_loop` — consecutive `ci_check` failures (either `phase: 'feature'` or `phase: 'post_rebase'`) routed to replanning. Threshold `warnings.ciCheckReplanLoopThreshold` (default `3`).
- `rebase_replan_loop` — consecutive integration-time rebase failures routed to replanning. Threshold `warnings.rebaseReplanLoopThreshold` (default `3`).
- `total_replan_loop` — aggregate count across all three sources since last successful replan. Threshold `warnings.totalReplanLoopThreshold` (default `6`).

Each evaluator walks the feature's `feature_phase_completed` events backwards and counts matching-source failures since the last `plan`/`replan` completion. A `warning_emitted` event fires with `{ category, failedCount }` when the threshold is reached. Counters reset naturally when the next replan completes.

### Integration Config Warnings

Empty-`verification.feature` warnings dedupe per integration cycle (keyed by the integration marker row), not per invocation. One `warning_emitted` event is written when the executor runs post-rebase `ci_check` with an empty effective `checks[]` list for that integration cycle.

### Feature Churn Warnings

Feature churn warnings capture repeated recovery loops that indicate poor decomposition, integration hotspots, or thrashing.

Stage 1 examples:
- multiple `verifying` failures on the same feature
- multiple post-rebase `ci_check` failures / queue ejections
- repeated integration-driven replans on the same feature
- a feature blocked behind another feature for more than 8 hours
- repeated stuck-task incidents or replanning on the same feature

Stage 2 examples:
- one feature repeatedly cycling between the merge train and repair
- one feature pair repeatedly triggering overlap pauses
- one feature consuming a disproportionate share of recovery work over time

### Scheduling Priority Warnings

Scheduling priority warnings surface structural issues in milestone decomposition or dependency ordering that cause the scheduler to override expected priority.

Stage 1 examples:
- a feature in a higher-priority milestone is blocked by an incomplete feature in a lower-priority milestone (milestone priority inversion)
- dependency satisfaction pulls a lower-milestone feature forward, overriding the expected milestone ordering

Stage 2 examples:
- one milestone pair repeatedly causes priority inversions across runs
- a milestone's features are chronically blocked by work in later milestones

### Hierarchy Cardinality Warnings

Hierarchy cardinality warnings capture cases where graph shape exceeds the baseline assumption that milestones and features usually own relatively small sibling sets.

Stage 1 examples:
- one milestone exceeds the expected child-feature envelope (roughly `> 50` features)
- one feature exceeds the expected child-task envelope (roughly `> 50` tasks)

Stage 2 examples:
- one milestone's child-feature count drifts upward across recent runs
- one feature's child-task count repeatedly grows past the expected planning envelope

## What Is Tracked

### Per Verification Check Run

For each verification run, track at least:
- verification layer (`task`, `feature`) plus `phase` discriminator (`feature` or `post_rebase`) when the layer is `feature`
- check category / description
- command
- duration
- exit status
- owning task id or feature id
- timestamp

This supports both immediate slow-check warnings and later trend analysis.

### Per Feature Churn Counters

For each feature, track at least:
- pre-queue verification failure count (`ci_check` or agent-level `verifying`)
- post-rebase `ci_check` failure count
- merge-train ejection count
- integration-driven replan count
- replanning count (aggregate across sources)
- stuck-task incident count
- overlap-block incident count
- total time blocked behind another feature
- merge-train re-entry count

These should be available both as lifetime counts and as recent-window counts.

### Current Hierarchy Cardinality Gauges

Track current graph-shape gauges separately from churn counters:
- current child-task count per feature
- current child-feature count per milestone
- optional recent-window max counts if trend warnings later need them

These are current-size signals, not lifetime counters.

### Per Feature-Pair Overlap Signals

For cross-feature coordination, track at least:
- feature pair ids
- overlapped paths
- number of overlap incidents
- total blocked time caused by the pair
- whether overlap was reservation-only or runtime-detected

This supports later warnings about chronically colliding feature pairs.

## Surfacing

Warnings should be surfaced through:
- append-only `events` log entries
- TUI warning badges / summaries
- feature detail views showing recent warning causes

For empty verification-config warnings, emit one advisory `warning_emitted` event per entity/layer combination instead of repeating it on every scheduler tick or retry.

Warnings should remain advisory by default. If a warning later needs to become a policy input, that should be an explicit separate decision rather than an implicit escalation.
