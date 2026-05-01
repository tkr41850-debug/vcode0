---
phase: 09-crash-recovery-ux
plan: 02
subsystem: startup-respawn-and-replay-hookup
stags: [recovery, startup, replay, runtime, scheduler, inbox]
requirements-completed: [REQ-STATE-02]
completed: 2026-05-01
---

# Phase 09 Plan 02: Startup Respawn + Transcript Replay Hookup Summary

**Phase 9 now truthfully resumes in-flight work after boot: startup immediately fresh-starts runs whose saved sessions are not resumable, replay-incomplete resumes surface structured recovery diagnostics, and the scheduler parks those cases with readable inbox visibility instead of retry churn.**

## Performance

- **Completed:** 2026-05-01
- **Scope closed:** startup `not_resumable` fallback, structured replay-incomplete error metadata, parked recovery diagnostics, and readable inbox recovery wording
- **Commits created in this slice:** none
- **Verification result:** focused verification green for `npm run typecheck`, `test/unit/orchestrator/recovery.test.ts`, `test/unit/orchestrator/scheduler-loop.test.ts`, `test/unit/runtime/worker-runtime.test.ts`, `test/unit/tui/view-model.test.ts`, `test/unit/ipc/frame-schema.test.ts`, and `test/unit/compose.test.ts`

## Accomplishments

- Extended `src/orchestrator/services/recovery-service.ts` so startup recovery still attempts replay-backed resume first, but immediately dispatches a fresh `start` when the runtime reports `kind: 'not_resumable'`.
- Expanded the startup recovery report with `resumedRuns`, `restartedRuns`, and `attentionRuns` so later Phase 9 UX can distinguish replay success from fallback restarts and operator-attention cases.
- Added structured recovery diagnostics to worker error frames via `src/runtime/contracts.ts`, `src/runtime/ipc/frame-schema.ts`, and `src/runtime/worker/index.ts` while preserving the human-readable `error` string.
- Updated `src/runtime/worker-pool.ts` so replay-incomplete recovery errors bypass retry-policy inbox escalation and reach the scheduler unchanged.
- Updated `src/orchestrator/scheduler/events.ts` so replay-incomplete worker errors no longer churn through `retry_await`; they now park the task as `stuck`, fail the run, and append an operator-visible inbox diagnostic.
- Added readable recovery wording in `src/tui/view-model/index.ts` so the existing inbox surface shows concrete recovery detail instead of bare `semantic_failure`.
- Added focused regression coverage for resumed-vs-restarted startup runs, replay-incomplete scheduler parking, retry-bypass behavior, IPC recovery validation, and TUI inbox wording.

## Exact Runtime Behavior That Landed

### Startup resume fallback

Startup recovery now behaves as follows for `running` task runs:

1. If the run has a `sessionId`, recovery attempts `resume` first.
2. If resume succeeds, the run stays on the replay-backed path and the startup report records the run under `resumedRuns`.
3. If resume returns `kind: 'not_resumable'`, startup immediately dispatches a fresh `start` for the same task/run/payload during the same recovery pass.
4. The restarted run persists the new `sessionId`, increments `restartCount`, and is recorded under `restartedRuns`.

This closes the old gap where boot dropped such runs back to generic `ready` state and waited for a later scheduler tick to relaunch them.

### Structured replay-incomplete recovery errors

Replay outcomes that are already terminal now emit worker `error` frames with both:

- the existing human-readable string, e.g. `resume_incomplete: assistant-text-terminal`
- structured recovery metadata:
  - `recovery.kind = 'resume_incomplete'`
  - `recovery.reason = <specific replay reason>`

This preserves log readability while letting orchestrator code classify recovery facts without brittle string parsing.

### Parked recovery diagnostics instead of retry churn

Scheduler worker-error handling now distinguishes replay-incomplete recovery from ordinary worker failures:

- **replay-incomplete recovery errors**
  - task transitions to `stuck`
  - run transitions to `failed`
  - inbox diagnostic is appended with `kind: 'semantic_failure'` and structured recovery reason payload
  - no `retry_await` churn

- **ordinary transient worker errors**
  - existing behavior remains intact
  - task returns to `ready`
  - run moves to `retry_await`

### Readable inbox wording

The current TUI inbox overlay now summarizes recovery diagnostics as readable strings such as:

- `recovery assistant text terminal`
- `recovery missing tool outputs tool-a,tool-b`

This keeps 09-02 operator-visible even before 09-03 lands the richer recovery summary surface.

## Files Created/Modified

Primary implementation files:
- `src/orchestrator/services/recovery-service.ts`
- `src/runtime/contracts.ts`
- `src/runtime/ipc/frame-schema.ts`
- `src/runtime/worker/index.ts`
- `src/runtime/worker-pool.ts`
- `src/orchestrator/scheduler/events.ts`
- `src/tui/view-model/index.ts`

Coverage files:
- `test/unit/orchestrator/recovery.test.ts`
- `test/unit/orchestrator/scheduler-loop.test.ts`
- `test/unit/runtime/worker-runtime.test.ts`
- `test/unit/tui/view-model.test.ts`
- `test/unit/ipc/frame-schema.test.ts`
- `test/unit/compose.test.ts`

Phase artifact files added during sync:
- `.planning/phases/09-crash-recovery-ux/09-02-SUMMARY.md`

## Decisions Made

1. **Startup recovery keeps replay-first semantics, not a second boot-only path.**
   - Recovery still routes through session-backed dispatch and the shipped replay stack before considering a fresh start.

2. **Synchronous `not_resumable` is a recovery truth, not a reason to idle.**
   - Startup immediately relaunches the task rather than deferring to a later generic scheduler path.

3. **Replay-incomplete outcomes are operator-visible recovery facts, not transient execution failures.**
   - They bypass retry-policy churn and are surfaced as parked diagnostics.

4. **Readable recovery detail belongs in the existing inbox now, even before 09-03.**
   - Minimal wording landed in the view-model layer so operators can see concrete replay reasons immediately.

## Verification

Focused verification completed successfully:
- `npm run typecheck`
- `npx vitest run test/unit/orchestrator/recovery.test.ts test/unit/orchestrator/scheduler-loop.test.ts test/unit/runtime/worker-runtime.test.ts test/unit/tui/view-model.test.ts test/unit/ipc/frame-schema.test.ts test/unit/compose.test.ts`

## Phase 09 Handoff

09-02 is complete.

What shipped in this slice:
- immediate startup fallback from synchronous `not_resumable` replay attempts to fresh worker start
- structured replay-incomplete recovery diagnostics on worker error frames
- retry-bypass for replay-incomplete errors in the worker pool
- scheduler parking and inbox surfacing for replay-incomplete recovery failures
- readable inbox recovery summaries in the current TUI surface

The next slice is 09-03: recovery-summary inbox item + crash fault-injection integration test, building on the substrate from 09-01 and the truthful restart/parking behavior from 09-02.

## Outcome

Plan 09-02 is complete:
- startup no longer waits for a later tick to relaunch synchronously non-resumable in-flight runs
- replay-backed startup resumes still work when the saved session is valid
- replay-incomplete outcomes are machine-classifiable and operator-visible
- replay-incomplete recovery errors no longer churn through `retry_await`
- focused verification is green
