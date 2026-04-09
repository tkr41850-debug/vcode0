# Warnings

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the high-level architecture index.

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

These rules are intended to be cheap to implement and easy to interpret.

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
- a merge-train verification category repeatedly runs longer than its configured absolute threshold

Stage 2 examples:
- task lint gets slower week over week
- merge-train test duration drifts upward across recent integrations

### Feature Churn Warnings

Feature churn warnings capture repeated recovery loops that indicate poor decomposition, integration hotspots, or thrashing.

Stage 1 examples:
- multiple feature-verification failures on the same feature
- multiple merge-train verification failures / queue ejections
- repeated integration repair tasks on the same feature
- a feature blocked behind another feature for more than 8 hours
- repeated stuck-task incidents or replanning on the same feature

Stage 2 examples:
- one feature repeatedly cycling between merge queue and repair
- one feature pair repeatedly triggering overlap pauses
- one feature consuming a disproportionate share of recovery work over time

## What Is Tracked

### Per Verification Check Run

For each verification run, track at least:
- verification layer (`task`, `feature`, `mergeTrain`)
- check category / description
- command
- duration
- exit status
- owning task id or feature id
- timestamp

This supports both immediate slow-check warnings and later trend analysis.

### Per Feature Churn Counters

For each feature, track at least:
- pre-queue verification failure count (`feature_ci` or agent-level `verifying`)
- merge-train verification failure count
- merge-train ejection count
- integration repair task count
- replanning count
- stuck-task incident count
- overlap-block incident count
- total time blocked behind another feature
- merge-train re-entry count

These should be available both as lifetime counts and as recent-window counts.

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

Warnings should remain advisory by default. If a warning later needs to become a policy input, that should be an explicit separate decision rather than an implicit escalation.
