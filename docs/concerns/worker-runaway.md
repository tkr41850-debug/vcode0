# Concern: Worker Runaway (Cost Cap)

## Concern

Baseline runtime has no wall-clock budget and no cost-based cutoff on a running worker. A worker stuck in a long inner loop or pathological tool-use cycle burns tokens until cost-rollup eventually trips a budget gate or an operator notices.

## Why to Watch

The scheduler caps parallelism but does not cap cost per task. The Phase 1 worker heartbeat + health timeout (`health_pong` route in `src/runtime/harness/index.ts:306-334`, with the worker-side responder in `src/runtime/worker/entry.ts`) already catches hangs and unresponsive child processes (transient `health_timeout` enters retry/escalation through the unified `RetryPolicy`), and the destructive-op guard (`beforeToolCall`) catches one class of runaway side effects. What remains uncovered is genuine cost runaway: a worker making real forward progress but spending well past the task's expected envelope.

## What to Observe

- high token spend on a single `agent_runs` row relative to expected task scope
- tasks in `running` state past the 95th-percentile runtime for similar work, despite passing health checks
- repeated transient retries that count against `retryCap` but do not look like a clean crashloop

## Current Position

Baseline defers the cost cap. Natural trigger is the budget/usage rollup work (see memory `budget_usage_rollup_architecture.md`): once `agent_runs.usd` + feature-level rollup are live, a cost cap can key off the same data. Revisit when that lands or on first observed production cost runaway.

## Related

- [Worker Model](../architecture/worker-model.md)
- [Distributed Runtime Candidate](../feature-candidates/runtime/distributed-runtime.md)
