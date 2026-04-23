# Explicit Lock Release

## Current behavior

Worker write-prehooks claim active path locks through the
orchestrator on first write. A run only releases its locks when it
exits — the terminal `result` or `error` IPC frame triggers
`ActiveLocks.releaseByRun(agentRunId)`. A long-running task that
finishes editing a file mid-run keeps holding the lock until it
submits.

## Why it's acceptable today

Task granularity is small in the current baseline: most tasks touch
a handful of files over a few minutes before submitting. Holding
locks for the remainder of a short run rarely causes a cross-task
wait that would not also be caught by the scheduler's preventive
reservation scan.

## Possible optimization

Add a `release_lock { paths }` IPC message from worker to
orchestrator, plumbed through `IpcBridge.releaseLock(paths)`. The
write prehook would call it after the write completes successfully.
The orchestrator would remove those paths from `ActiveLocks`
without affecting other locks held by the same run.

This would let long-running tasks free paths they're done with so
other tasks can claim them without waiting for submit. The
trade-off is extra IPC traffic per write; for high-churn runs the
volume could be meaningful.

## When to consider

Only if profiling shows prolonged same-feature task suspends caused
by locks held past their useful life. The scheduler's preventive
reservation overlap scan already avoids most of this pain by
deprioritizing overlapping tasks at dispatch time, so the
optimization is most useful when planner reservations are coarser
than actual write patterns.
