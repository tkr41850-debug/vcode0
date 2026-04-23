# Optimization Candidate: Abort In-Flight Scheduler Tick

## Status

Future optimization candidate. Not part of current baseline.

## Baseline

`SchedulerLoop` runs as a daemon loop (`src/orchestrator/scheduler/index.ts`):

```
while (running) {
  await sleep(1000);
  if (!running) break;
  await tick(now);
}
```

`stop()` aborts an in-flight `sleep()` immediately via a stored `wakeSleep` callback. However, if `stop()` is called while `tick()` itself is running, the stop awaits `tick()` completion before resolving. A slow tick — for example, one executing a synchronous git rebase inside cross-feature overlap coordination — delays shutdown by that tick's duration.

This is acceptable because ticks are expected to be short and shutdown is rare. Correctness (no half-applied scheduler state) wins over fast shutdown.

## Possible Future Optimization

Pass an `AbortSignal` from the scheduler down into tick substeps that perform long blocking work (overlap coordination, git ops in `src/orchestrator/conflicts/*`). On `stop()`, abort the signal; the in-flight tick unwinds at the next cooperative checkpoint rather than running to completion.

## Caveat

Introduce only if observed shutdown latency becomes a real problem. Adds plumbing through several layers; correctness of partial-tick rollback must be verified (leaving the graph in a consistent state when a tick is aborted mid-way).
