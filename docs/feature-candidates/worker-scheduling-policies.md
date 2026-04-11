# Feature Candidate: Worker Scheduling Policies

## Status

Future feature candidate. Do not treat this as part of the baseline architecture yet.

## Baseline

The baseline uses a single global scheduling priority order for all workers. When workers are idle, the scheduler picks the highest-priority ready work and dispatches it to any available worker.

## Feature

Allow configurable per-worker (or per-worker-pool) scheduling policies that bias which kinds of work each worker prefers. Examples:

- **Verify-first pool**: one or more workers prefer `verify > execute > rest`, ensuring verification work is never starved by task execution.
- **Summarize-first pool**: one worker prefers `summarize > rest`, keeping post-merge summarization from accumulating while other workers focus on execution.
- **Plan-first pool**: one worker prefers `plan > discuss > research > rest`, ensuring new features enter execution quickly.
- **Default pool**: remaining workers use the standard global priority order.

## Motivation

- Prevents starvation of low-priority work types (summarization) when many higher-priority tasks are available.
- Allows tuning for different project shapes: a project with many small features benefits from dedicated planning workers, while a project with few large features benefits from dedicated verification workers.
- Enables experimentation with scheduling strategies without changing the core priority logic.

## Design Considerations

- Each worker still draws from the same ready frontier — the policy only changes the *sort order* applied when picking work for that worker.
- A worker with a specialized policy should fall back to the default sort when no work of its preferred type is available.
- Policy configuration could be part of `GvcConfig` (e.g., `workers: [{ count: 1, prefer: 'verify' }, { count: 3, prefer: 'default' }]`).
- Need to handle the case where all workers have specialized policies and general task work gets starved.

## Trade-offs

- Adds configuration complexity.
- Harder to reason about global scheduling behavior when different workers use different orderings.
- May interact poorly with budget pressure (a verify-first worker burning tokens on verification while cheaper task work is available).
- The baseline's single ordering is simpler and sufficient for small-to-medium workloads.
