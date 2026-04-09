# test_runtime_session_contracts

## Goal

Capture the session, IPC, and worker-context contracts used by the local task runtime.

## Scenarios

### Starting a task creates a resumable session handle
- Given a task is about to execute with an assembled `WorkerContext`
- When `SessionHarness.start(task, context)` succeeds
- Then it returns a `SessionHandle` with a `sessionId`, live agent reference, and `abort()` capability
- And the returned handle can later be persisted for recovery

### Resuming work uses the persisted session id
- Given a task execution session was previously persisted
- And the orchestrator still has the authoritative `sessionId` for that run
- When `SessionHarness.resume(sessionId, task)` is called
- Then the harness reconstructs a live `SessionHandle` for the same logical task run
- And recovery continues from the persisted session pointer rather than starting unrelated new work silently

### Persist records the recovery pointer before restart recovery relies on it
- Given a live session handle exists for in-flight work
- When the runtime persists that handle
- Then the handle's recovery identity is stored before the orchestrator depends on restart-time resume behavior
- And crash recovery can treat the persisted session id as authoritative input to `resume()`

### Aborting a session stops live execution
- Given a `SessionHandle` is still active
- When `abort()` is invoked
- Then the live session is told to stop
- And the runtime can treat that handle as no longer executing normal forward progress

### IPC run messages carry both task identity and worker context
- Given the orchestrator dispatches work to a worker process
- When it sends a `run` message
- Then that message includes the `Task` payload and the assembled `WorkerContext`
- And worker execution does not need to guess its task identity or context inputs

### IPC control messages cover orchestration commands beyond initial dispatch
- Given an already-running worker may need operator or scheduler intervention
- When the orchestrator sends `abort`, `steer`, `suspend`, or `resume` messages
- Then those commands travel through the `OrchestratorMessage` contract rather than ad hoc side channels
- And the worker can distinguish cancellation, steering, suspension, and resume intent explicitly

### Worker messages cover status, progress, result, error, and cost reporting
- Given a worker needs to report execution back to the orchestrator
- When it emits runtime updates
- Then those updates use the `WorkerMessage` contract for status, progress, result, error, or cost events
- And cost reporting carries structured provider usage rather than untyped free-form text

### IPC transports provide a send, receive, and close surface
- Given a concrete transport such as NDJSON stdio or a Unix socket is in use
- When runtime messaging is wired up
- Then the transport exposes `send()`, `onMessage()`, and `close()` as the common contract
- And the runtime can swap transport implementations without changing higher-level orchestration semantics

### Worker context defaults to the configured strategy
- Given a `WorkerContextBuilder` is created with config defaults
- When `build()` is called without a more specific override
- Then the returned context uses `config.context.defaults.strategy` when present
- And otherwise defaults to `shared-summary`

### Worker context adds optional inputs only when available
- Given plan summaries, dependency outputs, or knowledge-file content may or may not exist for a task stage
- When worker context is assembled
- Then optional fields such as `planSummary`, `dependencyOutputs`, `codebaseMap`, `knowledge`, and `decisions` are included only when the relevant input exists
- And absent context inputs remain omitted rather than being fabricated with placeholder values
