# Phase 10: Re-plan Flows & Manual Edits Polish - Context

**Gathered:** 2026-05-01
**Status:** Ready for planning after research

<domain>
## Phase Boundary

Phase 10 is the planner-polish phase. Its job is to make re-invoking planning and reviewing planner output feel recoverable and explicit instead of implicit, especially now that the top-level planner, proposal approval flow, manual DAG edits, transcript surfaces, and crash-recovery UX are all already shipped.

This phase is not about inventing new planner authority or a second editing model. The existing runtime already has the core substrate for planner session reuse vs reset, top-planner prompt audit events, pending proposal detection, TUI draft snapshots, and collision metadata when top-level proposals touch live feature-planner runs. What is missing is the operator-facing glue: clear continue-vs-fresh planner UX, readable audit-log surfaces, proposal preview polish, and comprehensive collision visibility before approval.

The important scope fence is that Phase 10 should tighten planner trust and intent recovery, not rewrite planning semantics. Re-invocation remains additive-only, manual edits still win, approval still gates graph mutation, and collision resets still route through the existing proposal/apply event path.

</domain>

<decisions>
## Implementation Decisions

### Planner session UX should expose the runtime contract already shipped
- Continue-vs-fresh is already a real runtime distinction for top-planner work, not a new concept for this phase. `deriveTopPlannerSessionId(...)` in `src/orchestrator/scheduler/dispatch.ts` and rerun handling in `src/orchestrator/scheduler/events.ts` already preserve or clear `sessionId` based on `sessionMode`.
- Phase 10 should surface that distinction clearly in the TUI before planner launch or rerun instead of inventing a new state model.
- The operator-facing picker should use the existing `PlannerSessionMode = 'continue' | 'fresh'` contract and existing rerun/request wiring, not parallel flags or ad-hoc prompt text.
- Fresh mode should continue to mean discarding the persisted session transcript and starting a new planner conversation while keeping the current graph as the planning baseline.

### Audit-log reading should stay event-backed
- Planner provenance already lives in append-only event history rather than a separate goal entity, and that is the right model to preserve.
- `top_planner_requested`, `top_planner_prompt_recorded`, `proposal_applied`, `proposal_rejected`, `proposal_rerun_requested`, and `proposal_collision_resolved` are the authoritative audit trail seams for top-level planner intent and outcome.
- Phase 10 should make that event-backed audit log readable in the TUI rather than adding a second persistence silo.
- Per-feature audit-log reading should stay anchored to features touched by a planner proposal, consistent with `REQ-PLAN-06` and the earlier decision that prompts persist alongside the features they shaped.

### Proposal preview should remain read-only and draft-derived
- Proposal preview belongs in the existing proposal controller + app-state path, where draft snapshots and pending proposal runs are already derived for display.
- `ComposerProposalController.getDraftSnapshot()` and `displayedSnapshot(...)` in `src/tui/app-state.ts` are the right base seams for read-only preview rendering.
- Phase 10 should improve how the proposal is inspected and understood before approval, but it should not bypass the existing approval workflow or mutate state from the preview surface.
- TUI proposal polish should continue to treat the graph snapshot and proposal payload as authoritative, not create shadow UI state beyond transient overlay/view selection.

### Collision surfacing must be explicit before approval
- Collision data already exists in `TopPlannerProposalMetadata.collidedFeatureRuns` and is derived by `collectCollidedFeaturePlannerRuns(...)` in `src/orchestrator/proposals/index.ts`.
- The pending top-planner selection flow in `src/tui/app-state.ts` already exposes an approval hint when a proposal resets planner runs; Phase 10 should deepen that visibility into a clear collision surface instead of leaving it as a terse hint.
- Accepting a colliding proposal should continue to route through the existing approval/apply path that resets feature planner runs and emits `proposal_collision_resolved`; no hidden background planner cancellation should be introduced.
- Collision visibility belongs in the proposal-review path, not only in post-hoc events or logs.

### Manual edits remain authoritative and must compose with planner polish
- The Phase 8 command-first manual DAG edit workflow is already the authoritative user override path and should remain untouched in principle.
- Phase 10 should make planner proposals easier to understand in the presence of manual edits, not weaken the manual-wins rule.
- Proposal preview and collision wording should help operators understand when planner output would overwrite or reset planner-generated work around a manually shaped graph.

### Claude's Discretion
- Exact TUI affordances for session picking, audit-log browsing, and proposal preview layout are at Claude's discretion as long as they remain derived from authoritative state and preserve the existing approval/rerun semantics.
- Whether the audit-log reader appears as an overlay, detail pane, or command-routed surface is at Claude's discretion provided it stays event-backed and does not introduce a new persistence model.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/orchestrator/scheduler/dispatch.ts` already derives top-planner session reuse vs reset through `deriveTopPlannerSessionId(...)` and dispatches the planner with `sessionMode`.
- `src/orchestrator/scheduler/events.ts` already records top-planner prompt provenance via `top_planner_requested` and `top_planner_prompt_recorded`, finds the latest prompt with `findLatestTopPlannerPrompt(...)`, and emits `proposal_collision_resolved` when approval resets collided planner runs.
- `src/orchestrator/proposals/index.ts` already parses/stores `TopPlannerProposalMetadata` and derives touched/collided feature planner runs through `collectCollidedFeaturePlannerRuns(...)`.
- `src/runtime/sessions/index.ts` already persists planner/worker transcripts durably in `.gvc0/sessions/` through `FileSessionStore`.
- `src/tui/proposal-controller.ts` already owns draft proposal editing, submission, approval, rejection, and top-planner rerun enqueueing through `enqueueTopPlannerRerun(...)` with optional `sessionMode`.
- `src/tui/app-state.ts` already derives pending proposal selection and exposes collision approval hints from top-planner proposal metadata.
- `src/tui/app.ts`, `src/tui/app-overlays.ts`, and `src/tui/view-model/index.ts` already provide the refresh-driven, derived-state TUI pattern that Phase 10 should reuse for new reader/review surfaces.

### Established Patterns
- Session reuse vs fresh-start is explicit, typed, and event-driven rather than inferred from prompt text.
- Planner provenance and operator decisions are append-only events, not mutable narrative records.
- Proposal review happens before graph mutation, and approval/rejection is the sole path that applies or discards planner output.
- TUI state remains derived from authoritative graph/run/event data, with transient overlay visibility but no long-lived shadow workflow state.
- Collision handling already favors explicit operator review followed by deterministic reset/rerun semantics.

### Verified Gaps
- No operator-facing session picker exists yet for top-planner continue-vs-fresh decisions.
- No readable audit-log surface exists yet for planner prompts that produced current feature state.
- Proposal preview remains functional but sparse; it lacks a dedicated read-only review surface that makes planner intent and collisions easy to inspect.
- Collision surfacing is currently partial: metadata and hints exist, but there is no comprehensive operator view of which planner runs will be reset and why.
- The autonomous workflow has no dedicated Phase 10 planning artifacts yet; this context is the first Phase 10 file.

### Integration Points
- `src/compose.ts` for top-planner request entrypoints and TUI dependency wiring.
- `src/orchestrator/scheduler/dispatch.ts` and `src/orchestrator/scheduler/events.ts` for session-mode flow, prompt recording, rerun behavior, and collision-resolution events.
- `src/orchestrator/proposals/index.ts` for proposal metadata parsing and collision derivation.
- `src/runtime/sessions/index.ts` for persisted session transcript semantics.
- `src/tui/proposal-controller.ts`, `src/tui/app-state.ts`, `src/tui/app.ts`, and `src/tui/app-overlays.ts` for proposal review and any new reader/picker surfaces.
- `src/tui/commands/index.ts` and `src/tui/app-composer.ts` for any new command-path affordances needed to open session-picker, audit-log, or proposal-review flows.

</code_context>

<specifics>
## Specific Ideas

- A good Phase 10 shape is likely two slices matching the roadmap: first, session picker plus audit-log reader; second, proposal preview plus collision surfacing polish.
- The session picker should probably appear at the top-planner invocation seam, where operators can intentionally choose whether to continue the last conversation or fork a fresh one against the same live graph.
- The audit-log reader should likely summarize prompt text, session mode, touched feature IDs, and collision/reset outcomes from existing events instead of dumping raw JSON.
- Collision preview should likely enumerate the exact feature planner runs that will be reset, reusing `collidedFeatureRuns` metadata already persisted on pending proposals.
- Proposal preview should stay graph-centric and approval-centric: show what changes, what planner context produced it, and what side effects approval will trigger.

</specifics>

<deferred>
## Deferred Ideas

- Any redesign of planner authority, additive-only semantics, or manual-edit precedence remains out of scope.
- Rich historical analytics for planner usage beyond readable audit-log viewing remain out of scope for this phase.
- New persistence entities for goals, proposal history, or planner conversations remain out of scope.
- Broader diagnostic and docs-facing explain surfaces belong to Phase 11, not this phase.

</deferred>
