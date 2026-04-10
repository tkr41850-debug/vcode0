# Feature Candidate: Distributed Runtime

## Status

Future feature candidate. Do not treat this as part of the baseline architecture yet.

## Baseline

The baseline runtime is local-machine and process-per-task. The orchestrator launches task workers locally, uses NDJSON over stdio for worker/orchestrator messaging, and treats `agent_runs.session_id` as the authoritative persisted session pointer for recovery. Runtime control remains task-scoped at the orchestrator seam, while the runtime internally maps live task execution to run/session state.

## Candidate

A later version could evolve into a distributed runtime where workers register with an orchestrator server and may host multiple live task sessions at once.

Potential capabilities:
- transport migration from local NDJSON stdio to a networked protocol such as gRPC
- persistent worker processes instead of one short-lived worker process per task
- worker registration and discovery
- worker heartbeats / liveness reporting
- explicit tracking of which worker currently owns a task or session
- orchestrator queries such as "which worker owns this task/session?"
- worker-side hosting of multiple `SessionHarness` instances
- remote resume routing based on worker/session ownership rather than only local in-memory runtime state
- more explicit worktree/git synchronization rules when task execution and orchestration are no longer on the same local machine

## Migration Questions

If this candidate is pursued later, the main design questions to resolve are:

1. **Transport migration**
   - How should the current two-sided IPC message contracts map onto gRPC or another network transport?
   - Should the system use a bidirectional stream, separate command/event streams, or unary control calls plus event streaming?

2. **Worker ownership tracking**
   - How does the orchestrator know which worker owns a live task or session?
   - Is ownership authoritative in memory, persisted, or reconstructed dynamically from worker registration?

3. **Persistent workers**
   - Should workers survive across multiple task executions and orchestrator restarts?
   - How many live sessions can one worker host concurrently?

4. **Worker registration / discovery**
   - How do workers register with the orchestrator?
   - How are reconnects, timeouts, and stale worker records handled?

5. **Git/worktree synchronization**
   - How are feature branches and task worktrees synchronized when workers may live on different machines or different local clones?
   - What becomes the authoritative source of worktree state during suspend/resume and crash recovery?

6. **Worker task/session query surface**
   - What query API lets the orchestrator ask workers whether they currently own a task, run, or `sessionId`?
   - How should that query surface distinguish live ownership, stale knowledge, and not-found cases?

## Why Deferred

This is deferred because the current baseline is intentionally local and contract-first. The system does not yet need worker registration, distributed discovery, remote session routing, or a heavier transport. Keeping the current runtime contracts transport-agnostic should make a later migration tractable without introducing distributed-system complexity into the baseline.

## Related

- [Worker Model](../worker-model.md) — baseline local process-per-task runtime and IPC
- [Feature Candidate: Advanced IPC Guarantees](./advanced-ipc-guarantees.md) — stronger transport semantics without full distributed workers
- [Feature Candidate: Claude Code Harness](./claude-code-harness.md) — future provider/backend abstraction concerns
