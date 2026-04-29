# Feature Candidate: Proposal Editing and Toggling

## Status

Future feature candidate. Do not treat this as part of the baseline architecture yet.

## Baseline

The baseline proposal flow is approval-gated but not operator-editable. When the planner or replanner calls `submit()`, the user can review the ordered list of graph-modification operations and optionally a before/after view, then either approve the proposal as generated or rerun planning/replanning to obtain a different proposal.

Partially stale proposals may still be approved. The orchestrator evaluates each operation against current graph state and applies whichever operations are still valid in order, skipping stale ones.

## Candidate

A later version could allow the user to toggle or edit specific proposal operations before approval.

Examples:
- disable one proposed dependency edge while keeping the rest of the proposal
- edit a task description inline before approval
- drop a stale or undesirable add/remove op without rerunning the full proposal agent
- re-order non-conflicting operations when review identifies a better sequence

This would make proposal review more ergonomic, especially when only one or two operations need adjustment.

## Why Deferred

This feature is deferred because it increases:
- approval UI complexity (per-op editing and enable/disable state)
- proposal validation complexity (edited/toggled ops may change downstream applicability)
- persistence complexity (need to distinguish agent-authored ops from user-edited ops)
- audit complexity (must preserve original proposal, edited proposal, and final applied subset)
- replay/apply complexity when edited proposals diverge from the original proposal-graph snapshot

The baseline approve-or-rerun model is simpler and keeps the orchestrator's apply semantics easy to reason about.
