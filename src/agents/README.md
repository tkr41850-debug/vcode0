# agents

Agent-driven planning, restructuring, and task-execution logic.

This directory owns:

- **Planner / replanner** — behavior, prompts, and proposal-graph tools used during planning. Tooling surface now splits across typed hosts, schemas, and builder modules under [`tools/`](./tools/README.md).
- **Worker** — the task-worker agent's tool catalog and toolset factory. See [`worker/README.md`](./worker/README.md).

It does not own the live runtime infrastructure (child-process lifecycle, IPC transport, session persistence, payload assembly). Those live under `@runtime/*`. The worker agent's system prompt also lives in the runtime because it's rendered from the planner-baked `TaskPayload` at dispatch and submitted directly to the harness.
