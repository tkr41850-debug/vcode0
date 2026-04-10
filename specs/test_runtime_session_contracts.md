# test_runtime_session_contracts

## Goal

Capture the session, IPC, and worker-context contracts used by the local task runtime.

## Scenarios

### Starting a task creates a resumable live session handle
- Given a task is about to execute with an assembled `WorkerContext`
- When `SessionHarness.start(task, context)` succeeds
- Then it returns a `SessionHandle` with a `sessionId`, `abort()`, and `sendInput(text)`
- And the public handle stays provider-neutral rather than exposing a provider agent object

### Resuming work uses the authoritative run session pointer
- Given a task execution run has an authoritative `agent_runs.session_id`
- And the runtime derives a resumable task-execution run reference from persisted run state
- When `SessionHarness.resume(task, run)` is called
- Then the harness returns either `resumed` with a live `SessionHandle` or `not_resumable` with a typed reason
- And recovery continues from the persisted session pointer rather than silently starting unrelated new work

### Aborting and manual input act on the live session handle
- Given a `SessionHandle` is still active
- When `abort()` is invoked
- Then the live session is told to stop
- And when `sendInput(text)` is invoked the live session receives manual/operator input through the same provider-neutral handle

### IPC run messages carry task identity, run identity, dispatch mode, and worker context
- Given the orchestrator dispatches work to a worker process
- When it sends a `run` message
- Then that message includes `taskId`, `agentRunId`, `dispatch`, `Task`, and the assembled `WorkerContext`
- And worker execution does not need to guess task identity, run identity, or recovery mode

### IPC control messages cover steering, suspension, resume, abort, and human responses
- Given an already-running worker may need operator or scheduler intervention
- When the orchestrator sends `steer`, `suspend`, `resume`, `abort`, `help_response`, `approval_decision`, or `manual_input`
- Then those commands travel through the typed orchestrator-to-worker runtime contract rather than ad hoc side channels
- And the worker can distinguish structured steering from human follow-up or manual drop-in input

### Worker messages cover progress, terminal result or error, and waiting requests
- Given a worker needs to report execution back to the orchestrator
- When it emits runtime updates
- Then those updates use the worker-to-orchestrator runtime contract for `progress`, `result`, `error`, `request_help`, `request_approval`, and `assistant_output`
- And terminal `result` / `error` messages may carry normalized runtime usage without reusing aggregate accounting types

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
