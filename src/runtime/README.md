# runtime

Local execution runtime for task workers and resumable sessions.

This directory owns worker lifecycle management, runtime-owned context assembly, model routing, IPC transport, session persistence, and the worker system prompt.
It does not own the worker tool catalog; that lives under [Worker Agent](../agents/worker/README.md).

## Layout

- `context/` — builds `WorkerContext` from task plans, dependency outputs, and knowledge files.
- `harness/` — `SessionHarness` plus the pi-sdk child-process harness that forks `worker/entry.ts` in task worktrees.
- `ipc/` and `contracts.ts` — NDJSON transport and orchestrator↔worker message contracts.
- `routing/` — routing tiers plus provider/model resolution bridges.
- `sessions/` — persisted conversation history for resumable runs under `.gvc0/sessions`.
- `worker/` — `WorkerRuntime`, child entrypoint, and runtime-owned worker system prompt.
- `worker-pool.ts` — orchestrator-facing pool for dispatch, resume, and worker message fan-in.

## Sharp edges

- `worker/system-prompt.ts` stays here because runtime assembles it from `WorkerContext`; tool behavior stays in [Worker Agent](../agents/worker/README.md).
- Child workers speak NDJSON over stdin/stdout. `worker/entry.ts` redirects normal console output to stderr so stdout stays clean for IPC.
- Harness and pool code are orchestrator-facing; `worker/` code is child-runtime-facing. Keep cross-boundary logic narrow and explicit.

## See also

- [Worker Model](../../docs/worker-model.md)
- [Operations / Verification and Recovery](../../docs/operations/verification-and-recovery.md)
- [Worker Agent](../agents/worker/README.md)
