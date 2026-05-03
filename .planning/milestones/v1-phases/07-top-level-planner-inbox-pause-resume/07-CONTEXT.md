# Phase 7: Top-Level Planner + Inbox + Pause/Resume - Context

**Gathered:** 2026-04-25
**Status:** Ready for planning after research

<domain>
## Phase Boundary

Phase 7 is the first user-facing orchestration phase above the feature planner. It must turn a prompt into a milestone/feature DAG through inline planner interaction, materialize a real inbox for agent asks and operator attention, and add the two-tier pause/resume model that keeps short waits hot but can checkpoint and respawn long waits without losing transcript continuity.

The key boundary is that Phase 7 does not invent a separate planning universe. The existing feature-level planner, proposal system, scheduler event queue, feature-phase session persistence, merge-train inbox parking, and Phase 3 resume spike all become inputs. The missing work is the top-level scope, unified inbox domain semantics, pause lifecycle, additive-only replan guards, and collision handling when top-level edits target live feature-planner work.

Already present from earlier phases: milestones and features are persisted, proposal tools can draft milestone/feature/task graphs, feature-phase sessions persist via `sessionId`, merge-train cap parking appends inbox rows, request-help/request-approval already pause task runs at the run-state level, and the Phase 3 spike landed the `@runtime/resume` facade plus durable tool-output store primitives. Phase 7 must connect those into a coherent operator loop.

</domain>

<decisions>
## Implementation Decisions

### Top-Level Planner Scope
- Reuse the existing proposal architecture instead of building a second graph-edit mechanism. `GraphProposalToolHost`, `createPlannerToolset(...)`, proposal approval events, and proposal warnings already establish the draft/apply pattern.
- Phase 7 extends planner scope upward to milestones + features. Feature-level planning remains task-scoped and continues to use the existing `plan` / `replan` runtime pattern.
- The top-level planner should remain proposal-first: mutate a draft graph, submit a proposal, then route acceptance through the same approval/apply event model already used for feature planning.
- Milestone edits are part of the top-level planner surface in this phase because `REQ-STATE-04` explicitly allows milestone split/merge proposals and manual edits.

### Additive Re-Invocation and Session Semantics
- Continue-vs-fresh is already an established pattern at the feature-phase level: dispatch reuses `sessionId` for ordinary reruns and explicitly clears it for fresh reruns. Phase 7 should preserve that model for top-level planner sessions rather than inventing a different session contract.
- Re-invoking the top-level planner must be additive-only with respect to running or completed work. The existing proposal warning layer (`remove_started_feature`, `remove_started_task`) is a strong analog, but Phase 7 must harden it from warning-only into a proposal-view-enforced constraint for top-level edits that touch live work.
- Manual edits remain authoritative. Top-level planner proposals should be treated the same way feature-level proposals are today: draft-only until explicit approval, with skipped/warning details preserved.
- Top-level planner sessions need a registry that is planner-scoped rather than feature-scoped so the UI can offer continue vs fresh before the agent starts mutating its draft.

### Inbox as Unified Attention Surface
- The inbox remains the durable append-first surface for operator attention. Phase 7 should extend the existing append-only stub rather than replacing it.
- `request_help` and other agent asks must become real inbox items, not only `agent_runs.runStatus='await_response'` plus `payloadJson`.
- Existing inbox producers — semantic failures, destructive approvals, merge-train cap parking — should keep their current persistence shape and be joined by richer query + resolution support.
- Phase 7 should treat the inbox as the model layer for Phase 8 UI work: durable rows, resolvable state, enough payload structure to drive a single "things waiting on you" surface.

### Two-Tier Pause / Checkpoint / Respawn
- The Phase 3 spike decision is locked: pause/resume must use `@runtime/resume` with `RESUME_STRATEGY='persist-tool-outputs'`.
- Hot window behavior should preserve the current worker process + worktree for short waits and reset on relevant operator activity.
- On hot-window expiry, the worker process is released but the worktree remains. The latest transcript and tool outputs become the checkpoint surface for respawn.
- Recovery and respawn should reuse existing primitives wherever possible: `FileSessionStore`, `ToolOutputStore`, `PiSdkHarness.resume(...)`, and `RecoveryService` patterns for resuming task-scoped runs.

### Multi-Task Single-Answer Unblock
- Phase 7 should not special-case only the original requesting task. The inbox model needs enough structure to detect "same question / same approval" cases so one operator answer can release multiple waiting tasks when appropriate.
- Existing single-run delivery methods in `compose.ts` (`respondToTaskHelp`, `decideTaskApproval`) are the narrow baseline, not the desired final design.
- Task-level run-state transitions must remain legal under the FSM. Phase 7 extends routing and fan-out, not the legality model around `await_response` / `await_approval`.

### Planner Collision Handling
- A top-level proposal that edits a feature while its feature-level planner is running must surface a collision before apply.
- Accepting the top-level proposal should cancel the running feature-level planner and let it rerun against the new feature shape, following the existing rerun/session-reset pattern rather than inventing a bespoke restart path.
- Collision handling belongs in the proposal-view / approval layer, not as a hidden background mutation.

### Audit Log Persistence
- There is still no persistent "goal" entity. Planner provenance should attach to features/milestones via audit-log entries, consistent with `REQ-PLAN-06`.
- Existing `feature_phase_completed`, `proposal_applied`, `proposal_rejected`, and `proposal_rerun_requested` events are the closest current audit-log analog. Phase 7 should extend this with top-level planner prompt/session provenance rather than bypassing the event log.
- Session identifiers are already persisted on agent runs and can anchor audit-log records. Phase 7 should reuse that persisted session identity.

### Claude's Discretion
- Exact inbox item kinds, payload JSON shapes, and event names for new top-level-planner / pause / collision flows are at Claude's discretion as long as they are consistent with the existing append-only store/event patterns.
- Whether the top-level planner is implemented as a separate runtime interface or as an extension of the existing planner runtime is at Claude's discretion, provided model routing still respects the reserved `topPlanner` role and the proposal/apply path remains explicit.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/agents/tools/proposal-host.ts` and `src/agents/tools/planner-toolset.ts` already provide draft-graph mutation over milestones, features, tasks, and dependencies.
- `src/core/proposals/index.ts` already resolves aliases, applies graph proposals, skips stale ops, and warns on removing started features/tasks.
- `src/orchestrator/scheduler/events.ts` already owns proposal approval, rejection, rerun, and feature-phase completion events.
- `src/orchestrator/scheduler/dispatch.ts` already shows the current continue-vs-fresh session behavior through `sessionId` reuse vs reset for feature phases.
- `src/runtime/sessions/index.ts`, `src/runtime/resume/index.ts`, and `src/runtime/resume/tool-output-store.ts` already define the transcript + replay primitives Phase 7 needs.
- `src/orchestrator/services/recovery-service.ts` already resumes task runs with `runStatus` in `running | await_response | await_approval` when a resumable session exists.
- `src/persistence/migrations/0005_inbox_items.sql`, `src/orchestrator/ports/index.ts`, and `src/persistence/sqlite-store.ts` already provide durable inbox append storage with a `resolution` column.
- `src/tui/proposal-controller.ts` already exercises the proposal-host flow in a manual TUI draft context and is the closest UI-side analog for top-level proposal editing.

### Established Patterns
- Graph mutations happen through the serial scheduler event queue; planner proposals are draft-only until explicit approval applies them.
- Session reuse is explicit: ordinary reruns keep `sessionId`, fresh reruns clear it.
- Audit/provenance currently lives in append-only events (`feature_phase_completed`, `proposal_applied`, `proposal_rejected`, `proposal_rerun_requested`).
- Worker help/approval waits are run-state transitions today; routing side effects are additive and should preserve the existing FSM.
- Existing append-only inbox producers use `appendInboxItem(...)` with flexible `kind` + JSON `payload`, leaving resolution for later phases.

### Verified Gaps
- No top-level planner runtime implementation exists in `src/`; only the reserved `topPlanner` model role exists in config.
- `request_help` updates the task run to `await_response` in `src/orchestrator/scheduler/events.ts` but does not append an inbox row.
- Store/query surface remains append-only: there is no `listInboxItems()` / resolve API in `src/orchestrator/ports/index.ts` or `src/persistence/sqlite-store.ts`.
- `compose.ts` help/approval response delivery is single-task only.
- `AgentRunStatus` in `src/core/types/runs.ts` has no paused/checkpointed states yet.
- Worker transcript persistence currently happens at run end (`sessionStore.save(...)` after prompt/continue settles), not at `message_end` or `turn_end`.
- No `afterToolCall` wiring persists tool outputs in the worker runtime yet.
- No planner session registry or collision detector exists beyond feature-phase session reuse and rerun handling.

### Integration Points
- `src/config/schema.ts` for `topPlanner` role and `pauseTimeouts.hotWindowMs`.
- `src/compose.ts` for project bootstrap, help/approval response delivery, and runtime wiring.
- `src/orchestrator/scheduler/dispatch.ts` and `src/orchestrator/scheduler/events.ts` for planner sessions, proposal approval, reruns, and task wait routing.
- `src/runtime/worker/index.ts`, `src/runtime/harness/index.ts`, and `src/orchestrator/services/recovery-service.ts` for pause/checkpoint/respawn integration.
- `src/orchestrator/ports/index.ts`, `src/persistence/sqlite-store.ts`, and `src/persistence/migrations/0005_inbox_items.sql` for inbox persistence expansion.
- `src/tui/proposal-controller.ts` and view-model tests for the nearest current proposal-view workflow.

</code_context>

<specifics>
## Specific Ideas

- Top-level planning should likely mirror the feature-phase proposal contract closely enough that approval/apply continues to go through `proposal_applied` / `proposal_rejected` style events rather than a separate mutation path.
- The additive-only constraint is partly present today through proposal warnings/skips on started work; Phase 7 should strengthen that into a first-class top-level planner contract instead of relying on passive warnings alone.
- Inbox resolution likely belongs in the Store port before UI work: Phase 7 can ship the model/query/resolution layer and let Phase 8 bind the visual surface.
- The worker already emits `message_end` and `turn_end` events, but they are currently only streamed outward. Phase 7 can use those same hooks to save checkpoints without changing the worker's overall execution model.
- Recovery currently resumes `await_response` / `await_approval` runs as if they were resumable running tasks. Phase 7 should keep that reuse path but add an explicit paused/checkpointed branch rather than overloading existing statuses forever.
- The current TUI proposal controller already pauses auto-execution while a draft is active and restores it on submit/discard. That is a useful analog for top-level planner session ownership and collision visibility.

</specifics>

<deferred>
## Deferred Ideas

- Rich inbox filtering and polished inbox UI remain Phase 8+ work.
- Crash-recovery UX for orphan worktrees and recovery-summary items remains Phase 9 scope, though Phase 7 must prepare the inbox model for those item kinds.
- Proposal preview polish and audit-log reader UI remain Phase 10 scope.
- Full TUI-driven config editing remains Phase 8 scope; Phase 7 only consumes the existing `pauseTimeouts.hotWindowMs` and role-model config.

</deferred>
