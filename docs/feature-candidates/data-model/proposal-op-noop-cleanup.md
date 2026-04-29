# Feature Candidate: Proposal Operation No-Op Cleanup

## Status

Future feature candidate. Do not treat this as part of the baseline architecture yet.

## Baseline

The baseline proposal system preserves the agent-authored ordered operation list as submitted. Approval review may show stale operations, and apply-time execution may skip operations that no longer take effect against current graph state, but the proposal itself is not rewritten for UX polish.

Examples of effective no-ops that may remain visible in the baseline:
- multiple edits on the same entity that could be collapsed into one summary
- add-then-remove of the same feature/task within one proposal
- add dependency followed by remove dependency of the same edge
- edits that are later overwritten by a subsequent edit in the same proposal

## Candidate

A later version could clean up effective no-ops and redundant operations before presenting the proposal for review.

Examples:
- collapse a chain of edits into a single effective edit preview
- hide or annotate add-then-delete pairs as cancelled-out work
- compress repeated dependency toggles into their net effect
- group related operations by entity and show both raw log and simplified view

This would improve proposal readability without changing the underlying authored order unless the user explicitly chooses to edit the proposal.

## Why Deferred

This feature is deferred because it increases:
- proposal-rendering complexity (raw log vs simplified effective view)
- audit complexity (must preserve the original authored log while presenting a cleaned-up view)
- implementation complexity around proving that simplification preserves semantics
- debugging complexity when the displayed simplified plan differs from the literal op sequence the agent produced

The baseline raw ordered log is easier to reason about and gives the user the most faithful view of what the agent actually proposed.
