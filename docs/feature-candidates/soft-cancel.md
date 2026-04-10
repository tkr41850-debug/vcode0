# Feature Candidate: Soft Cancel

## Status

Future feature candidate. Do not treat this as part of the baseline architecture yet.

## Baseline

The baseline cancellation behavior is a hard cancel:
- feature collaboration control moves to `cancelled`
- all in-flight task runs for that feature are killed immediately
- the feature leaves normal scheduling until it is explicitly restored
- restoring the feature returns collaboration control to `branch_open` when work remains or `merge_queued` when all feature work is already complete

This keeps cancellation semantics simple and makes the feature's scheduler visibility deterministic.

## Candidate

A later version could support a soft-cancel mode where cancellation stops new dispatch for the feature but allows already-running task work to wind down and terminate normally.

This would give operators a less disruptive pause-like option when the main goal is to stop additional work rather than immediately tear down current execution.

## Why Deferred

This feature is deferred because it increases:
- scheduler edge cases around partially cancelling active work
- runtime semantics for task ownership, shutdown, and restart
- TUI state complexity when cancelled features still have running tasks
- recovery logic after orchestrator restart

The baseline hard-cancel behavior is easier to reason about and matches the current operational expectation.