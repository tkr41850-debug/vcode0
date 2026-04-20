# Feature Candidate: Advanced IPC Guarantees

## Status

Future feature candidate. Do not treat this as part of the baseline architecture yet.

## Baseline

The baseline worker/orchestrator transport uses local NDJSON over stdio. For the current local-machine architecture, this is sufficient without adding explicit acknowledgments, backpressure management, or stronger delivery guarantees.

## Candidate

A later version could add a more formal IPC contract with:
- explicit message acknowledgments
- bounded queues / backpressure behavior
- stronger ordering and delivery guarantees
- clearer pause/resume/abort durability semantics
- transport-specific health reporting

## Why Deferred

This is deferred because the baseline system runs on one local machine and does not currently need the complexity of a heavier transport contract. If the orchestrator later grows into a more distributed or higher-throughput runtime, these guarantees may become worth standardizing.

## Related

- [Worker Model](../architecture/worker-model.md) — baseline NDJSON stdio transport
