# Phase 3: Worker Execution Loop (+ Pi-SDK Resume Spike) — CONTEXT

## Source
- Phase definition: `ROADMAP.md` § Phase 3
- Requirements: `REQ-EXEC-01`, `REQ-EXEC-02`, `REQ-EXEC-03`, `REQ-EXEC-04`, `REQ-EXEC-05` (worker-pool side), `REQ-CONFIG-01` (use)
- Depends on: Phase 1 (core FSM, typed IDs), Phase 2 (Store port, config loader) — both shipped.

## Goal (verbatim)
A single task runs end-to-end in an isolated worktree via a pi-sdk Agent child process, communicating over NDJSON IPC, with the write pre-hook enforcing safety, and with a proven answer to the pi-sdk resume/replay question.

## Success Criteria
1. A single task runs end-to-end: spawn worker → pi-sdk Agent in worktree → commit with gvc0 trailer → worker cleanup.
2. Write pre-hook rejects writes outside the task worktree directory; `push --force` / `branch -D` / `reset --hard` routed to inbox approval stub.
3. NDJSON IPC parser is line-buffered, schema-validated, survives malformed input (quarantined, not fatal), and detects worker silence via health-check.
4. Retry policy auto-retries transient errors up to configurable hard cap; semantic failures are handed to the (stub) inbox.
5. Pi-sdk Agent resume/replay spike produces a written decision: native pi-sdk replay OR persist-tool-outputs fallback, with reasoning grounded in observed behavior.

## Locked Decisions (from prior phases / PROJECT.md)
- **Process-per-task**: Each task spawns its own child process running a pi-sdk `Agent`; workers are isolated at the OS level.
- **Feature branches**: `feat-<name>-<feature-id>` (long-lived). Task worktrees: `feat-<name>-<feature-id>-<task-id>`, squash-merged back into the feature branch on completion.
- **NDJSON over stdio**: transport swappable; schema-validated frames.
- **Write pre-hook**: enforced inside the worker via a `claim_lock` IPC round-trip before every file write; cwd enforcement blocks writes outside the task worktree.
- **Destructive git ops** (`push --force`, `branch -D`, `reset --hard`) → inbox approval stub (Phase 7 will materialize the inbox; stub here must produce a persistent approval request via `Store`).
- **Retry policy** driven by typed config (from 02-03): transient auto-retry up to configurable cap, then semantic failures route to inbox.
- **Commit trailer**: every worker commit carries a `gvc0` trailer (task-id, run-id) for merge-train attribution (consumed by Phase 6).
- **Spike gate**: pi-sdk Agent resume/replay fidelity decides whether Phase 7 two-tier pause uses native replay or persist-tool-outputs fallback.

## Gray Areas — Auto-Answered (skip_discuss=true)

### A. Worker process boundary
**Decision**: One Node.js child process per task, spawned via `child_process.spawn()` with `{ stdio: ['pipe','pipe','pipe','ipc'] }`. The `ipc` FD is reserved for lifecycle; stdin/stdout carry NDJSON frames (dev-friendly & transport-swappable later). Parent-child handshake on first frame.
**Why**: Matches pi-sdk expectations; `ipc` gives us structured lifecycle (disconnect events) without framing stdin/stdout with extra protocol.

### B. Worktree manager scope
**Decision**: `WorktreeManager` owns `add / remove / prune / stale-lock sweep` with a PID registry persisted in `Store` (lives in `agent_runs.worker_pid` + a dedicated `worker_pid_registry` view that rehydrates on boot). Worktrees live at `.gvc0/worktrees/<feature-id>-<task-id>/` under the repo root.
**Why**: PID registry in `Store` makes Phase 9 crash recovery cheap (boot rehydration already exists from Phase 2); `.gvc0/worktrees/` keeps paths predictable and `.gitignore`-safe.

### C. NDJSON bridge invariants
**Decision**:
- Frame schema via Zod (`WorkerFrameSchema` discriminated union: `claim_lock`, `lock_result`, `run_event`, `health_ping`, `health_pong`, `commit_done`, `error`).
- Malformed lines go to a quarantine log (in-memory ring + `Store.appendQuarantinedFrame()`) with fatal=false.
- Health check: worker must send `health_pong` within `config.workerHealthTimeoutMs` (default 10s) of parent's `health_ping`. Missing two consecutive pongs → worker marked unresponsive → orchestrator signals retry.
**Why**: Zod already the validator of choice after 02-03; quarantine-not-fatal keeps a single bad frame from crashing the orchestrator.

### D. Write pre-hook mechanism
**Decision**: Pre-hook is enforced inside the pi-sdk `Agent` host via a wrapper around the `write_file` / `edit_file` / `exec` tool calls. Every tool call emits a `claim_lock` IPC frame; parent validates path (must be `cwd + worktree dir`) and destructive-op status (`push --force` / `branch -D` / `reset --hard` are detected via arg-pattern matching on `exec` calls). Reject → worker raises tool error. Destructive op with claim-denied → parent writes an `inbox_item` row (stub schema) and returns `pending_approval`.
**Why**: Tool-wrapping means pi-sdk semantics stay intact; `claim_lock` round-trip is the single enforcement surface for both cwd and destructive-op gates.

### E. Retry policy surface
**Decision**: `RetryPolicy` lives in `src/runtime/retry-policy.ts`. Transient errors (network, rate limit, ECONNRESET, ETIMEDOUT, subset of HTTP 5xx) auto-retry with exponential backoff capped at `config.retry.maxAttempts`. Semantic errors (schema-validation failure, pre-hook denial, non-zero commit status not in transient set) immediately escalate to inbox stub via `Store.appendInboxItem()`.
**Why**: Clean split keeps config schema small (one cap + one transient-error whitelist); escalation path unified for Phase 7.

### F. Commit-with-trailer contract
**Decision**: Worker wraps `git commit` via a tool-call shim that appends a `gvc0-task-id: <task-id>\ngvc0-run-id: <run-id>` trailer. Parent verifies trailer presence on `commit_done` frame; missing trailer → commit rejected (worker must re-do).
**Why**: Phase 6 merge-train needs reliable commit attribution; enforcing it at emit-time is cheaper than mining `git log` later.

### G. Pi-sdk resume/replay spike structure
**Decision**: Plan 03-05 is explicitly a SPIKE, not an implementation. Deliverable: `docs/spikes/pi-sdk-resume.md` with:
- Scenario matrix: cold start, mid-tool pause, mid-response pause, post-commit pause, catastrophic worker crash.
- Observed pi-sdk behavior for each (measurements, not guesses).
- Decision: **native pi-sdk replay** or **persist-tool-outputs fallback**, with reasoning.
- Minimal implementation of the chosen strategy (stub if native replay works; actual tool-output persistence + replay shim if fallback).
**Why**: Phase 7 blocks on this; a bad decision here cascades. The spike has to produce concrete numbers.

### H. Existing runtime code
**Decision**: Reference, not baseline. `src/runtime/*` may be kept, rewritten, or scrapped per PROJECT.md. Expect rewrites in all 5 plans.
**Why**: Pre-existing runtime stubs from GSD-2 port are unlikely to match the Phase 3 contract; better to write to the new contract.

## Scope Fences
- **Out of scope**: scheduler tick (Phase 4), feature-level planner (Phase 5), merge train (Phase 6), TUI worker view (Phase 8), full crash recovery UX (Phase 9 — this phase only persists PIDs).
- **In scope**: worker process lifecycle + IPC + write pre-hook + retry policy + resume spike.

## Expected Plans (5)
- **03-01**: Worktree manager (add/remove/prune/stale-lock sweep) + PID registry in Store.
- **03-02**: NDJSON IPC bridge + Zod schema validation + malformed-line quarantine + health-check.
- **03-03**: Worker process lifecycle + pi-sdk Agent host + commit-with-trailer contract.
- **03-04**: Write pre-hook (`claim_lock` round-trip, cwd enforcement, destructive-op gate stubs, inbox-stub append).
- **03-05**: Pi-sdk Agent resume/replay spike — measurements + decision doc + minimal implementation.

## Cross-Phase Notes
- Phase 4 scheduler will `WorkerPool.submit(task)` — plan 03-03 must expose `WorkerPool` primitive.
- Phase 6 merge-train consumes commit trailers — plan 03-03 Task X must enforce trailer contract.
- Phase 7 pause/resume consumes spike decision — plan 03-05 output is gate.
- Phase 9 crash recovery consumes PID registry + stale-lock sweep — plan 03-01 persists PIDs via Store.

## Blockers / Concerns
- **Pi-sdk Agent API surface**: plan 03-03 + 03-05 need to understand pi-sdk's current checkpoint/resume primitives. Researcher must inventory them first.
- **Git hook vs tool-wrapping**: RESEARCH should confirm the write pre-hook is enforced via tool-wrapping inside the worker, not via filesystem-level git hooks (which can't distinguish tasks sharing a repo).
