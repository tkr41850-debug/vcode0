# agents

Agent-driven planning, restructuring, and task-execution logic.

This directory owns:

- **Planner / replanner** — behavior, prompts, and graph-mutation tools used during planning.
- **Worker** — the task-worker agent's tool catalog and toolset factory. See [`worker/README.md`](./worker/README.md).

It does not own the live runtime infrastructure (child-process lifecycle, IPC transport, session persistence, context assembly). Those live under `@runtime/*`. The worker agent's system prompt also lives in the runtime because it's assembled from runtime-owned `WorkerContext` inputs and submitted directly to the harness.
