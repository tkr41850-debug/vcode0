---
phase: 07-top-level-planner-inbox-pause-resume
plan: 03
subsystem: pause-resume
stags: [pause-resume, inbox, replay, worker-runtime, recovery]
requirements-completed: [REQ-INBOX-02, REQ-INBOX-03, REQ-STATE-03]
completed: 2026-04-28
---

# Phase 07 Plan 03: Two-Tier Waits, Transcript Checkpoints, and Respawn-with-Replay Summary

**Made the Phase 7 pause/resume promise real: help and approval waits now have explicit checkpointed run states, worker transcripts are checkpointed during the run, real tool outputs are persisted by tool-call id, hot-window expiry releases the worker without losing the worktree, and delayed replies resume through the existing replay path instead of faking transcript state.**

## Performance

- **Completed:** 2026-04-28
- **Scope closed:** checkpointed wait run-state model, mid-run transcript persistence, persisted tool outputs, hot-window release, inbox-triggered respawn, and recovery/state-model parity
- **Commits created in this slice:** none
- **Verification result:** full repo `npm run check` green at completion

## Accomplishments

- Added explicit persisted checkpointed wait statuses instead of overloading live `await_response` / `await_approval`.
- Extended blocked-state and recovery logic so checkpointed waits remain visible, durable, and resumable.
- Moved transcript durability from terminal-only save to in-run checkpoints on `message_end` and `turn_end`.
- Threaded `toolCallId` through blocking wait payloads so replay can attach the real tool result to the original tool invocation.
- Added a production file-backed tool-output path under `.gvc0/tool-outputs/<sessionId>`.
- Implemented hot-window timers in the worker pool so long waits release the worker process but keep the session/worktree state intact.
- Extended inbox resolution so delayed help/approval answers respawn the task through replay before the operator response is consumed.

## Final Persisted Run-State Shape

Task waits now distinguish live versus checkpointed blocked states directly on `AgentRunStatus`:

```ts
export type AgentRunStatus =
  | 'ready'
  | 'running'
  | 'retry_await'
  | 'await_response'
  | 'await_approval'
  | 'checkpointed_await_response'
  | 'checkpointed_await_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';
```

The important runtime rule is:

- `await_response` / `await_approval` = live worker still held in the hot window
- `checkpointed_await_response` / `checkpointed_await_approval` = worker released, session persisted, worktree retained, answer must respawn first

That status is now respected consistently across:

- `src/core/types/runs.ts`
- `src/core/state/index.ts`
- `src/orchestrator/services/recovery-service.ts`
- store open-run queries / rehydrate logic
- TUI blocked-state rendering and task composer hints

## Transcript Checkpoint Cadence

`src/runtime/worker/index.ts` now checkpoints the current session during the run instead of only after terminal completion.

The production cadence is:

- `message_end` -> save current `agent.state.messages`
- `turn_end` -> save current `agent.state.messages`
- terminal completion/error -> wait for the checkpoint chain, then save the final transcript once more

Implementation details that matter:

- checkpoint saves are serialized through `checkpointSaveChain` so overlapping agent events cannot race each other
- the worker persists under the active `sessionId` for both fresh runs and resumed runs
- `RecoveryService` can now trust that a released or interrupted run has a recent persisted transcript snapshot available

## Blocking Wait Payload and Tool-Output Persistence

Blocking waits now persist the tool-call identity instead of only the human-facing prompt text.

### Help wait payload

```ts
{
  query: string;
  toolCallId: string;
}
```

### Approval wait payload

```ts
ApprovalPayload & {
  toolCallId: string;
}
```

The worker runtime now exposes `recordToolOutput(...)` through the IPC bridge, and tool outputs are stored via a per-session `ToolOutputStore`.

The production file-backed path used for replay is:

```text
.gvc0/tool-outputs/<sessionId>
```

The exact blocking tools now grounded in persisted tool outputs are:

- `request_help`
- `request_approval`

For delayed operator responses, compose records the real tool result payload before respawn:

- help -> `toolName: 'request_help'`
- approval -> `toolName: 'request_approval'`

No synthetic "pretend tool already returned" state is invented without a persisted tool output.

## Hot-Window Expiry and Respawn Sequence

`src/runtime/worker-pool.ts` now arms a wait timer whenever a task emits:

- `request_help` -> `await_response`
- `request_approval` -> `await_approval`

On expiry of `config.pauseTimeouts.hotWindowMs`:

1. the pool clears the live wait timer entry
2. removes the task from the live-run map
3. calls `handle.release()` instead of aborting the worktree/session state
4. emits `wait_checkpointed`
5. the scheduler updates the run to `checkpointed_await_response` or `checkpointed_await_approval`

When the operator answers after checkpointing, `src/compose.ts` now performs this sequence:

1. parse the persisted wait payload and recover the original `toolCallId`
2. write the actual help/approval tool result into `.gvc0/tool-outputs/<sessionId>`
3. dispatch the task via `taskDispatchForRun(run)` in resume mode
4. update the run back to `running` / `owner: 'manual'`
5. let the resumed worker consume the stored tool output through `@runtime/resume`

This keeps the worktree alive and the transcript truthful while still releasing the worker process during AFK waits.

## Recovery Semantics

`src/orchestrator/services/recovery-service.ts` now treats paused waits as first-class persisted states:

- orphaned live `await_response` -> `checkpointed_await_response`
- orphaned live `await_approval` -> `checkpointed_await_approval`
- already-checkpointed waits remain checkpointed
- running tasks still attempt resume on boot when they still have a resumable session id

So Phase 7 no longer loses blocked waits simply because the live worker disappeared.

## Files Created/Modified

Primary implementation files:

- `src/core/types/runs.ts`
- `src/core/state/index.ts`
- `src/orchestrator/services/recovery-service.ts`
- `src/runtime/worker/index.ts`
- `src/runtime/worker-pool.ts`
- `src/runtime/resume/tool-output-store.ts`
- `src/compose.ts`
- `src/persistence/queries/index.ts`
- `src/persistence/sqlite-store.ts`

Primary regression coverage files:

- `test/unit/core/state.test.ts`
- `test/unit/compose.test.ts`
- `test/unit/orchestrator/recovery.test.ts`
- `test/unit/orchestrator/scheduler-loop.test.ts`
- `test/unit/runtime/worker-runtime.test.ts`
- `test/integration/worker-smoke.test.ts`
- `test/integration/persistence/rehydration.test.ts`

## Decisions Made

1. **Checkpointed waits are explicit statuses, not hidden payload metadata.**
   - The rest of the system already keys blocked-state behavior off `runStatus`, so the durable state model now does the same.

2. **Replay remains grounded in real persisted tool outputs.**
   - The system stores actual tool results keyed by the original `toolCallId` instead of synthesizing missing results during resume.

3. **Hot-window expiry releases the process, not the worktree.**
   - This is a pause/resume lifecycle, not cancellation or cleanup.

4. **Inbox resolution stays delivery-truthful.**
   - A checkpointed wait is marked resolved only after the respawn path successfully accepts the answer.

## Deviations from Plan

### Recovery scope stayed intentionally narrow

Checkpointed waits became visible, durable, and operator-resumable in Phase 7, but boot-time recovery still only auto-resumes `running` runs. Checkpointed waits remain intentionally paused until a real operator answer arrives.

That is a deliberate correctness choice: the system now preserves enough state for replay, but it does not pretend an answer exists when none has been provided.

## Verification

Focused verification during the slice included:

- `npx vitest run test/unit/core/state.test.ts`
- `npx vitest run test/unit/orchestrator/scheduler-loop.test.ts`
- `npx vitest run test/unit/compose.test.ts`
- `npx vitest run test/unit/runtime/worker-runtime.test.ts`
- `npx vitest run test/integration/worker-smoke.test.ts`
- `npm run typecheck`

Final repo-wide verification:

- `npm run check`

## Phase 09 Handoff

Phase 9 now gets several crash-recovery building blocks “for free” from this slice:

- persisted transcript checkpoints during the run
- persisted tool outputs keyed by the original wait tool call
- checkpointed wait statuses that survive rehydrate
- resume plumbing that can restart a delayed-answer task on demand

What still remains Phase 9 work is UX and boot orchestration, not core replay truthfulness:

- stale-lock sweep summary surface
- orphan-worktree triage inbox items
- recovery-summary UX
- broader crash-path end-to-end polish

## Outcome

Plan 07-03 is complete:

- delayed waits now checkpoint instead of silently evaporating
- transcripts and tool outputs persist early enough for replay
- checkpointed waits are durable and visible across persistence/recovery/TUI surfaces
- delayed answers respawn through the replay path before they are consumed
- verification is green
