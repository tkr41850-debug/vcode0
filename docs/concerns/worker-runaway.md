# Concern: Worker Runaway

## Concern

Baseline runtime has no wall-clock budget, no progress-idle timeout, and no cost-based cutoff on a running worker. A hung, looping, or pathologically retrying worker holds its concurrency slot and burns tokens until something external notices.

## Why to Watch

The scheduler caps parallelism but does not cap runtime per task. A single stuck worker can monopolize a slot indefinitely while spending. The existing child-exit hook catches crashes but not hangs or runaway cost.

## What to Observe

- workers with no progress events for long stretches
- high token spend on a single `agent_runs` row relative to expected task scope
- stuck provider-retry loops without forward progress
- tasks in `running` state past the 95th-percentile runtime for similar work

## Current Position

Baseline defers. Natural trigger is the budget/usage rollup work (see memory `budget_usage_rollup_architecture.md`): once `agent_runs.usd` + feature-level rollup are live, a cost cap can key off the same data. Revisit when that lands or on first observed production runaway.

## Executable coverage

- `test/integration/worker-smoke.test.ts` proves worker runtime bootstrap, faux-backed task execution, and help/approval wait-resume plumbing through the runtime harness.

Runaway mitigation itself remains deferred/no-direct-coverage: no test currently enforces wall-clock budgets, progress-idle timeout, provider retry cutoff, or cost-based cutoff. Track the central status in [Testing / Concerns-to-tests traceability](../operations/testing.md#concerns-to-tests-traceability).

## Related

- [Worker Model](../architecture/worker-model.md)
- [Distributed Runtime Candidate](../feature-candidates/distributed-runtime.md)
