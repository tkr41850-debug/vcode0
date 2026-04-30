# Feature-Phase Operator Attach

Design notes for Phase 6 of the TUI ↔ planner wiring (see plan in
`/home/alpine/.claude/plans/floofy-hopping-chipmunk.md`). **Scope: plan and
replan feature-phase runs only.** Discuss/research/verify/ci_check/summarize
are short-lived, do not call `request_help` today, and are out of scope.

## Why

Today operator interaction with running plan/replan feature-phase runs is
limited to the read-only/light-touch plumbing landed in earlier phases:

- **Phase 2** mirrors the running planner's proposal graph in the DAG.
- **Phase 3** registers feature-phase live sessions on `LocalWorkerPool` and
  exposes `sendInput`/`abort` on the handle backed by `Agent.followUp` /
  `Agent.abort`.
- **Phase 4** ships the plain-text composer planner-chat surface (queues a
  follow-up turn on the running planner).
- **Phase 5** ships planner `request_help` blocking + the `/reply` extension
  routing operator answers back through `respondToFeaturePhaseHelp`, plus
  persisted `await_response` state.

`docs/operations/verification-and-recovery.md:200-212` describes the richer
manual-ownership lifecycle that Phase 6 implements for plan/replan:

> 4. User may attach directly, moving the run to `running` with `owner = "manual"`
> 5. If the user exits without finishing, the run becomes `await_response` with `owner = "manual"`
> 6. The operator may later trigger `release_to_scheduler` to return the run to scheduler-owned execution once manual intervention is complete.

Phase 6 wires `/attach` and `/release-to-scheduler` for plan/replan runs and
makes the lifecycle visible/recoverable.

## Architecture: don't use scheduler event queue

A naive design would route attach/release through `SchedulerEvent` (like
`feature_phase_attach_requested`). **This is a trap**: the scheduler tick is
parked inside `await dispatchFeaturePhaseRun(...)` for the entire planner
run (see `src/orchestrator/scheduler/dispatch.ts:521-535` and
`src/runtime/worker-pool.ts:139-169`). Events queued during a live planner
would not be processed until the run's outcome resolves — defeating the
purpose of mid-run attach.

Phase 6 instead uses **direct compose-lambda mutations** that update
`agent_runs` synchronously and call `ui.refresh()`, mirroring how Phase 5's
`onHelpRequested` / `onHelpResolved` lambdas already handle in-process
mid-flight state changes. No new scheduler events.

## States

`agent_runs` for plan/replan feature-phase runs participates in the existing
state machine from `src/core/types/runs.ts`:

- `runStatus`: `ready | running | retry_await | await_response | await_approval | completed | failed | cancelled`
- `owner`: `system | manual`
- `attention`: `none | crashloop_backoff`

Phase 6 adds one new `attention` value:

- `operator` — the run is currently driven by an attached operator. The
  scheduler treats this as a hold marker: it never reclaims the run, never
  fires its own dispatch, and never advances feature workControl based on
  it until `attention` returns to `none`.

### Transitions

The plan/replan run lifecycle gains the following operator-driven
transitions. `attach` and `release` are direct compose-lambda mutations on
the store + `ui.refresh()`; planner resume + outcome events still flow
through the existing dispatch path.

| Trigger | Pre-state | Post-state | Notes |
|---------|-----------|------------|-------|
| `attachFeaturePhaseRun` | `ready, system, none` | unchanged + notice `not_running` | Reject: nothing live to attach to. Operator should wait for scheduler dispatch. |
| `attachFeaturePhaseRun` | `running, system, none` | `running, manual, operator` | Live agent keeps running; ownership flips. Live mirror still shows incremental ops. |
| `attachFeaturePhaseRun` | `await_response, system, none` | `await_response, manual, operator` | Pending `request_help` carries over; operator can answer via `/reply`. |
| `attachFeaturePhaseRun` | `*, manual, *` (already attached) | unchanged + notice `already_manual` | Single-operator semantics. |
| Planner calls `request_help` while attached | `running, manual, operator` | `await_response, manual, operator` | Existing Phase 5 onHelpRequested lambda updates `runStatus` only; preserves `manual/operator`. |
| `respondToFeaturePhaseHelp` while attached | `await_response, manual, operator` | `running, manual, operator` | Phase 5 onHelpResolved preserves owner/attention; only flips `runStatus`. |
| `releaseFeaturePhaseToScheduler` | `running, manual, operator` AND no pending help | `running, system, none` | Returns ownership to scheduler. Agent continues without interruption. |
| `releaseFeaturePhaseToScheduler` | `await_response, manual, operator` | unchanged + notice `pending_help` | Forbidden: cannot release while help is pending; gated on persisted `runStatus='await_response'`. |
| `releaseFeaturePhaseToScheduler` | `*, system, *` (not attached) | unchanged + notice `not_attached` | |
| Outcome resolves while attached (proposal phase) | `running, manual, operator` | `await_approval, manual, none` | Existing post-dispatch persist runs; **attachment auto-ends** (`attention` reset to `none`) because the agent is gone. Late `/release-to-scheduler` then rejects as `not_attached`. |
| `agent.abort()` from operator | `running, manual, operator` | `cancelled, manual, none` | Abort path mirrors task `abortRun`; attention auto-resets. |
| Planner failure (uncaught error / never-submitted) | `*, manual, operator` | `failed, system, none` | The agent is gone; `attention='operator'` is meaningless. Existing post-dispatch persist + scheduler error handling clears manual ownership and resets `attention`. |
| Feature cancellation | `*, manual, operator` | `cancelled, system, none` | Cancellation flow takes the run terminal; attachment auto-ends. |
| Transient retry-backoff entered | `running, manual, operator` | `retry_await, system, none` | The agent has stopped; ownership returns to scheduler so backoff/retry can fire. |

**General rule**: any transition that takes the run out of a live state
(`running` or `await_response`) MUST also clear `attention='operator'` and
return `owner` to `system` (or to the terminal `manual` only when reached
via explicit operator abort). The agent is gone in those states — leaving
`attention='operator'` would create a phantom hold marker.

States not affected by Phase 6:

- `await_approval` (plan/replan terminal pending state) is operator-driven
  through the existing `/approve | /reject | /rerun` flow. Attach during
  `await_approval` is rejected with `not_running`.
- `completed | failed | cancelled` are terminal; attach is rejected.
- `retry_await` is a backoff state for transient provider errors; attach is
  rejected with `not_running` (operator should wait for retry to fire).

## Race resolutions

### Mid-tool-call attach

Operator triggers `/attach` while planner is mid-tool-call (e.g. inside an
`addTask` or LLM call):

- Compose lambda reads agent_run, validates `runStatus ∈ {running, await_response}` and `owner=system, attention=none`.
- If valid: atomically updates to `owner=manual, attention=operator`,
  calls `ui.refresh()`. The agent itself is unaffected — `Agent.followUp`
  and `Agent.abort` still work the same. The flip is an orchestrator-side
  hold marker.

### Release while help pending

Operator triggers `/release-to-scheduler` while `await_response`:

- Compose lambda checks persisted `runStatus === 'await_response'`. If so,
  reject with notice `pending_help` and the toolCallId/query from
  `payloadJson` (Phase 5's onHelpRequested wrote it there). Operator must
  answer via `/reply` first.
- Persisted state is the source of truth; `listPendingFeaturePhaseHelp` is
  consulted only to enrich the notice text with the live query, not to
  decide gating.

### Operator session gone (TUI exit while attached)

Operator closes TUI without releasing:

- TUI dispose hook does NOT auto-release. Run stays `manual, operator` in
  the persisted store.
- gvc0 runs as a single in-process orchestrator — when the process exits,
  any feature-phase live session is gone. Therefore at next boot, **any
  manual/operator feature-phase run from a previous boot is always stale**
  (the workerBootEpoch predicate used for task subprocess runs does not
  apply because feature-phase runs are in-process and don't carry a
  reliable per-run boot epoch).
- `RecoveryService.recoverFeaturePhaseRun` (real path
  `src/orchestrator/services/recovery-service.ts`, NOT
  `src/runtime/recovery-service.ts`) extends to handle this case:
  - If `attention === 'operator'`: reset to `runStatus='ready', owner='system', attention='none'`. Preserve `sessionId` if a session file exists (resumable); clear `sessionId` if it does not (fresh start). Append `feature_phase_orphaned_reclaim` audit event with previous state.
- Scheduler then re-dispatches the run normally; planner resumes from
  session if available.

This force-reclaim policy means the operator cannot accidentally lock a
feature in `manual/operator` indefinitely. Worst-case: a closed-without-
release attach is reclaimed at next boot and the planner re-runs from the
last persisted message (or starts fresh). The reclaim event lets ops audit
how often this happens.

### Concurrent attach attempts

Two operators trying to `/attach` the same run:

- Compose lambda's check-and-update is synchronous in the orchestrator
  process. First wins; second sees `owner=manual` and the lambda returns
  the `already_manual` notice without mutating state.

## TUI surface

Slash commands added to `src/tui/app-composer.ts:executeSlashCommand`:

- `/attach` — when selected feature has a running plan/replan run with
  `runStatus ∈ {running, await_response}`, `owner=system, attention=none`,
  dispatches `attachFeaturePhaseRun` (TuiAppDeps method).
- `/release-to-scheduler` — when selected feature has a plan/replan run
  with `owner=manual, attention=operator`, dispatches
  `releaseFeaturePhaseToScheduler`.

Composer mode precedence (extends the chain from Phases 2–5):

1. pending approval (`await_approval`)
2. pending task (task `await_response`/`await_approval`/manual)
3. manual draft
4. **attached feature-phase run (`owner=manual, attention=operator`)** — new
5. live planner (running observation)
6. idle command

Detail strings:

- attached + `await_response`: `attached f-1 plan await_response /reply --text "..." /release-to-scheduler`
- attached + `running`: `attached f-1 plan running [type to chat] /release-to-scheduler`

While attached, plain-text composer input (the existing Phase 4 chat surface)
continues to route through `sendPlannerChatInput` to the running planner as
a follow-up turn. There is no `/input` extension for feature-phase: that's
task-only and remains so.

DAG title additions:

- `gvc0 progress [attached]` when the selected feature is attached.

## Audit events

Compose lambdas append the following entries to the project event log
(`store.appendEvent`) immediately after the corresponding mutation
(success or rejection):

- `feature_phase_attached` — successful attach
- `feature_phase_attach_rejected` (reason: `not_running` | `already_manual`)
- `feature_phase_released` — successful release
- `feature_phase_release_rejected` (reason: `pending_help` | `not_attached`)
- `feature_phase_orphaned_reclaim` — recovery-driven reclaim on boot

These are audit/observability entries appended to the global event log;
they are NOT `SchedulerEvent` variants and do not drive control flow.

## Recovery service

`src/orchestrator/services/recovery-service.ts:recoverFeaturePhaseRun`
extends with a new branch.

**Placement matters**: the existing `running` and `await_response` branches
return early after their own handling, so the orphan/operator-attached
case must run BEFORE those branches (a dedicated pre-pass at the top of
`recoverFeaturePhaseRun` for plan/replan runs). Otherwise the existing
`if (run.runStatus === 'running')` early-return on line 217 (and the
plan/replan `await_response` reset added in Phase 5) would intercept the
run before the operator-attached check runs.

Pre-pass logic:

- For plan/replan runs where `attention='operator'` and `owner='manual'`:
  treat as orphaned. (Single in-process orchestrator; previous-boot attach
  is always stale because the agent + session-resolver are gone with the
  process.)
- Read `payloadJson`; check whether the session file exists in
  `sessionStore`:
  - Resumable: `runStatus='ready', owner='system', attention='none'`,
    keep `sessionId`. Clear `payloadJson` (any pending-help payload from
    Phase 5 is stale; planner will re-issue if it re-blocks).
  - Not resumable: same status flip, clear `sessionId` so dispatch starts
    fresh.
- Append `feature_phase_orphaned_reclaim` event to the project event log
  with previous state.
- Return early so the existing branches (which would otherwise try to
  re-dispatch a `running` run, or reset an `await_response` run with stale
  `payloadJson`) don't run.

## Test plan

Unit tests in `test/unit/orchestrator/feature-phase-attach.test.ts` (new):

- Compose lambda `attachFeaturePhaseRun` from `running, system, none` →
  `running, manual, operator`; appends `feature_phase_attached` event;
  `ui.refresh()` called.
- `attachFeaturePhaseRun` from `ready, system, none` → unchanged + notice
  `not_running`.
- `attachFeaturePhaseRun` from `*, manual, *` → unchanged + notice
  `already_manual`.
- `releaseFeaturePhaseToScheduler` from `running, manual, operator` (no
  pending help) → `running, system, none`; appends `feature_phase_released`.
- `releaseFeaturePhaseToScheduler` from `await_response, manual, operator`
  → unchanged + notice `pending_help`.
- `releaseFeaturePhaseToScheduler` from `*, system, *` → unchanged + notice
  `not_attached`.

Unit tests in `test/unit/orchestrator/recovery.test.ts`:

- Orphaned manual feature-phase run with session reclaimed to
  `ready, system, none` keeping `sessionId`.
- Orphaned manual feature-phase run without session reclaimed to
  `ready, system, none` with `sessionId` cleared.
- `feature_phase_orphaned_reclaim` event appended with previous state.

Unit tests in `test/unit/tui/commands.test.ts` / new `test/unit/tui/app-composer.test.ts`:

- `/attach` on running plan/replan calls `attachFeaturePhaseRun(featureId, phase)`.
- `/release-to-scheduler` on attached run calls `releaseFeaturePhaseToScheduler(featureId, phase)`.
- `/attach` rejected when run not in valid state (notice surfaced).

Integration test in `test/integration/feature-phase-agent-flow.test.ts`:

- Planner running → operator `/attach` (post-bind) → operator `/reply --text "..."` to a request_help → `/release-to-scheduler` → planner resumes → submits → `await_approval`.
- Verify `attachFeaturePhaseRun` does not block the dispatch (no scheduler
  queue lag).

Race-coverage tests:

- `attach` while `request_help` fires concurrently: end state stable at
  `await_response, manual, operator`.
- `release` after outcome auto-end: late release rejects as `not_attached`.

## Out of scope

- Attach for non-proposal feature phases (discuss / research / verify /
  summarize / ci_check). Those phases are short-lived and don't call
  `request_help` today; attach during them adds little. Defer to a future
  phase if needed.
- Attach for task runs. Already exists at the runtime port level; the TUI
  command surface for task attach (parallel to feature-phase) is tracked
  separately as `docs/reference/tui.md` notes.
- `/discuss` decision variant on operator approval responses. Phase 6.2
  scope is plan/replan only.
- Multi-operator concurrent attach. Single-operator semantics; second
  attempt rejected with notice.
- Feature-phase `/input` slash command. Plain-text composer chat (Phase 4)
  already covers this for attached planner runs; no separate `/input` for
  feature-phase.

## Update plan

- `docs/reference/tui.md:225-226` deferred-bullet for operator attach is
  removed by Phase 6.2 implementation.
- This file is the canonical design reference for the lifecycle work in
  Phase 6.2.
