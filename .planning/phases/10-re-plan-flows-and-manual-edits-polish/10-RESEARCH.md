# Phase 10: Re-plan Flows & Manual Edits Polish — Research

**Researched:** 2026-05-01
**Domain:** top-level planner session reuse, planner audit-log readability, proposal preview surfaces, and collision visibility in the TUI
**Confidence:** HIGH (all findings verified by direct codebase inspection; no external research required)

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| REQ-PLAN-04 | On planner re-invocation, user picks "continue prior chat" or "fresh session" [VERIFIED: .planning/REQUIREMENTS.md] | The runtime contract already exists through `PlannerSessionMode = 'continue' | 'fresh'`, `deriveTopPlannerSessionId(...)`, `top_planner_requested`, and `top_planner_rerun_requested`; the gap is operator-facing TUI UX [VERIFIED: src/core/types/phases.ts][VERIFIED: src/orchestrator/scheduler/dispatch.ts][VERIFIED: src/orchestrator/scheduler/events.ts][VERIFIED: src/compose.ts] |
| REQ-PLAN-06 | Planner prompts are persisted as an audit log alongside the features they created [VERIFIED: .planning/REQUIREMENTS.md] | Prompt provenance already persists in append-only events plus proposal metadata (`top_planner_requested`, `top_planner_prompt_recorded`, `proposal_applied`, `proposal_rejected`, `proposal_rerun_requested`, `proposal_collision_resolved`); the gap is readable TUI presentation [VERIFIED: src/orchestrator/scheduler/events.ts][VERIFIED: src/orchestrator/proposals/index.ts][VERIFIED: test/unit/orchestrator/scheduler-loop.test.ts] |
| REQ-PLAN-07 | When top-level planning touches a feature with a live feature-planner run, the proposal flags it and approval resets the conflicting planner run [VERIFIED: .planning/REQUIREMENTS.md] | Collision detection, pending-approval metadata, and reset-on-approval behavior already ship; the current TUI only surfaces a terse hint like `resets N planner runs` [VERIFIED: src/orchestrator/proposals/index.ts][VERIFIED: src/orchestrator/scheduler/events.ts][VERIFIED: src/tui/app-state.ts][VERIFIED: test/integration/feature-phase-agent-flow.test.ts] |

## Locked Scope and Constraints

- Phase 10 is polish on already-shipped planner/session/proposal infrastructure, not a new planning authority model [VERIFIED: .planning/phases/10-re-plan-flows-and-manual-edits-polish/10-CONTEXT.md].
- Replanning remains additive-only; proposal approval/rejection remains the only mutation gate [VERIFIED: .planning/REQUIREMENTS.md][VERIFIED: src/orchestrator/scheduler/events.ts].
- Manual DAG edits remain authoritative and must compose with planner proposals rather than being softened or bypassed [VERIFIED: .planning/REQUIREMENTS.md][VERIFIED: .planning/phases/10-re-plan-flows-and-manual-edits-polish/10-CONTEXT.md].
- TUI state should remain derived from authoritative graph/run/event state, with at most transient overlay/view selection state [VERIFIED: src/tui/app.ts][VERIFIED: src/tui/app-state.ts][VERIFIED: .planning/phases/10-re-plan-flows-and-manual-edits-polish/10-CONTEXT.md].
</phase_requirements>

## Summary

Phase 10 does not need new persistence, a new planner state machine, or a second proposal model. The codebase already has the core substrate for everything Phase 10 promises:

- persisted planner transcripts in `.gvc0/sessions/<sessionId>.json`
- explicit `continue` vs `fresh` planner-session semantics
- append-only planner prompt/audit events
- proposal metadata carrying touched features, touched milestones, and collided feature-planner runs
- TUI draft snapshots and pending-proposal derived state
- approval-time collision reset and rerun semantics

The missing work is entirely operator-facing glue. Today the runtime knows whether a top-planner rerun is reusing or replacing a session, but the TUI does not give the user a clear session picker. The runtime records enough audit data to reconstruct planner intent, but the TUI has no readable audit-log surface. The proposal path already preserves draft snapshots and collision metadata, but the review UX is sparse and only exposes collision impact as a short status hint.

**Primary research conclusion:** Phase 10 should be implemented as TUI surfaces and small compose/query helpers layered directly on the existing runtime/event/proposal seams. The clean shape is two slices, matching the roadmap:

1. **10-01** — planner session picker + continue/fresh UX + readable audit-log reader
2. **10-02** — read-only proposal preview + explicit collision review before approval

That keeps the work additive, preserves the manual-wins contract, and avoids inventing any new planner persistence model.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| Continue-vs-fresh session semantics | Orchestrator / runtime | TUI | The real contract already lives in dispatch/event handling; the TUI should only expose and route that choice [VERIFIED: src/orchestrator/scheduler/dispatch.ts][VERIFIED: src/orchestrator/scheduler/events.ts][VERIFIED: src/compose.ts] |
| Planner audit-log storage | Store events | Proposal metadata | Prompt provenance already persists as events and top-planner proposal metadata payloads, so a reader should derive from those sources rather than duplicating them [VERIFIED: src/orchestrator/scheduler/events.ts][VERIFIED: src/orchestrator/proposals/index.ts] |
| Proposal preview | TUI | Proposal controller / app-state | Current preview data already flows through `displayedSnapshot(...)` and `ComposerProposalController.getDraftSnapshot()`; Phase 10 should extend that presentation path [VERIFIED: src/tui/app-state.ts][VERIFIED: src/tui/proposal-controller.ts][VERIFIED: src/tui/app.ts] |
| Collision detection and reset | Orchestrator | TUI | Collision truth comes from proposal metadata and scheduler approval handling; the TUI should make it readable before approval, not re-derive different semantics [VERIFIED: src/orchestrator/proposals/index.ts][VERIFIED: src/orchestrator/scheduler/events.ts] |
| Session transcript persistence | Runtime | Orchestrator | The session store already owns save/load/delete; Phase 10 should surface its semantics, not alter the storage layer [VERIFIED: src/runtime/sessions/index.ts][VERIFIED: src/runtime/worker/index.ts] |

## Current Implementation Inventory

### 1. Session semantics already exist and are explicit

Top-level planner dispatch already requires a `PlannerSessionMode` and derives a session ID accordingly:

- `dispatchTopPlannerUnit(...)` accepts `sessionMode: PlannerSessionMode`
- `deriveTopPlannerSessionId(...)` reuses `run.sessionId` only for `continue`
- `fresh` produces a new session ID and therefore a new transcript file

[VERIFIED: src/orchestrator/scheduler/dispatch.ts][VERIFIED: src/core/types/phases.ts]

Top-level reruns already preserve or clear sessions based on that mode:

- rerun reads the latest stored prompt via `findLatestTopPlannerPrompt(...)`
- rerun in `fresh` mode deletes the prior session from the session store and clears `sessionId`
- rerun in `continue` mode keeps the prior `sessionId`
- both paths append `proposal_rerun_requested` and a fresh `top_planner_prompt_recorded` event

[VERIFIED: src/orchestrator/scheduler/events.ts][VERIFIED: test/unit/orchestrator/scheduler-loop.test.ts]

### 2. Session transcripts are already durable

`FileSessionStore` persists planner/worker transcripts to `.gvc0/sessions/<sessionId>.json` and supports `save(...)`, `load(...)`, and `delete(...)`.

That means Phase 10 does not need to invent a concept of “prior planner conversation”; it already exists as the persisted session identified by `sessionId`.

[VERIFIED: src/runtime/sessions/index.ts][VERIFIED: src/runtime/worker/index.ts][VERIFIED: src/compose.ts]

### 3. Top-planner prompt provenance is already event-backed

The top-level planner path already appends these events:

- `top_planner_requested`
- `top_planner_prompt_recorded`
- `proposal_rerun_requested`
- `proposal_applied`
- `proposal_rejected`
- `proposal_collision_resolved`

`findLatestTopPlannerPrompt(...)` already reconstructs the current rerun baseline by scanning those top-planner events in reverse. `topPlannerMetadataPayload(...)` already stores prompt, session mode, run/session IDs, touched feature IDs, touched milestone IDs, and collided feature runs.

[VERIFIED: src/orchestrator/scheduler/events.ts][VERIFIED: test/unit/orchestrator/scheduler-loop.test.ts][VERIFIED: test/integration/feature-phase-agent-flow.test.ts]

### 4. Collision detection is already canonicalized in proposal metadata

`collectCollidedFeaturePlannerRuns(...)` already derives the exact feature-phase runs touched by a top-level proposal by:

- collecting the proposal’s touched feature IDs
- filtering live feature-phase proposal runs for those features
- storing `featureId`, `runId`, `phase`, `runStatus`, and optional `sessionId`

That result is persisted inside `TopPlannerProposalMetadata.collidedFeatureRuns`.

[VERIFIED: src/orchestrator/proposals/index.ts][VERIFIED: src/orchestrator/scheduler/dispatch.ts]

### 5. Approval already resolves collisions deterministically

On top-planner approval, the scheduler already:

- reads `collidedFeatureRuns` from metadata
- resets each affected feature proposal run to `ready`
- deletes its prior session file when applicable
- emits `proposal_collision_resolved`
- applies the top-level proposal with additive-only semantics

On rejection, it leaves the affected feature proposal runs and sessions untouched.

[VERIFIED: src/orchestrator/scheduler/events.ts][VERIFIED: test/integration/feature-phase-agent-flow.test.ts]

### 6. TUI already has the draft/pending-proposal substrate, but not the review UX

The TUI already:

- computes `displayedSnapshot(liveSnapshot, draftSnapshot)`
- carries current draft state through `ComposerProposalController`
- derives a pending proposal via `pendingProposalForSelection(...)`
- shows approval mode in the composer/status bar
- exposes `/approve`, `/reject`, and `/rerun`

What it does **not** have yet:

- a dedicated planner session picker surface
- an audit-log reader overlay/pane
- a dedicated proposal review overlay or structured read-only diff surface
- a full collision list in the approval UX

[VERIFIED: src/tui/app-state.ts][VERIFIED: src/tui/proposal-controller.ts][VERIFIED: src/tui/app.ts][VERIFIED: src/tui/app-composer.ts][VERIFIED: src/tui/components/index.ts][VERIFIED: src/tui/commands/index.ts]

## Gaps vs Roadmap

| Roadmap Success Criterion | Current State | Gap to Close |
|---------------------------|---------------|--------------|
| Clear continue-vs-fresh planner UX | Runtime contract exists and compose can enqueue `sessionMode`, but freeform prompt submission defaults to `fresh` and there is no session picker [VERIFIED: src/compose.ts][VERIFIED: src/orchestrator/scheduler/dispatch.ts] | Add an operator-facing TUI decision point for initial top-level plan requests and reruns [VERIFIED: .planning/ROADMAP.md] |
| Readable per-feature planner audit log in the TUI | Prompt provenance exists in events and metadata, but there is no audit-log reader overlay or command [VERIFIED: src/orchestrator/scheduler/events.ts][VERIFIED: src/tui/components/index.ts] | Add a derived reader surface that summarizes prompt, session mode, touched scope, and outcomes from existing events [VERIFIED: .planning/ROADMAP.md] |
| Collision visibility in proposal view | Pending top-planner proposals only show an approval hint like `resets N planner runs` [VERIFIED: src/tui/app-state.ts][VERIFIED: test/unit/tui/view-model.test.ts] | Add a full list of collided planner runs and their reset effect before approval [VERIFIED: .planning/ROADMAP.md] |
| Read-only proposal preview before approval/rejection | Draft and proposal payload data exist, but there is no dedicated proposal preview overlay or richer review pane [VERIFIED: src/tui/proposal-controller.ts][VERIFIED: src/tui/app.ts][VERIFIED: src/tui/components/index.ts] | Add a dedicated review surface driven by authoritative snapshot + pending proposal payload, not shadow UI state [VERIFIED: .planning/ROADMAP.md] |

## Likely Risks

- **Accidentally inventing a second session model.** The repo already standardized on `PlannerSessionMode` and `sessionId`; adding ad-hoc prompt flags or UI-only state would drift from the real runtime behavior [VERIFIED: src/core/types/phases.ts][VERIFIED: src/orchestrator/scheduler/dispatch.ts].
- **Building an audit reader that bypasses event history.** Prompt provenance is already append-only event data. A second persistence track would violate the existing design and create drift [VERIFIED: src/orchestrator/scheduler/events.ts][VERIFIED: .planning/phases/10-re-plan-flows-and-manual-edits-polish/10-CONTEXT.md].
- **Making proposal preview mutable.** `displayedSnapshot(...)` already swaps live vs draft views; a Phase 10 preview surface should inspect, not mutate, so approval remains the only graph mutation gate [VERIFIED: src/tui/app-state.ts][VERIFIED: src/tui/proposal-controller.ts].
- **Surfacing collision data only after approval.** The scheduler already emits `proposal_collision_resolved`, but Phase 10’s user promise is explicit visibility before acceptance [VERIFIED: src/orchestrator/scheduler/events.ts][VERIFIED: .planning/ROADMAP.md].
- **Weakening manual-wins semantics.** Proposal preview and audit wording should explain planner intent around a manually-shaped graph, not imply the planner owns the graph [VERIFIED: .planning/REQUIREMENTS.md][VERIFIED: .planning/phases/10-re-plan-flows-and-manual-edits-polish/10-CONTEXT.md].

## Relevant Existing Abstractions to Reuse

| Abstraction | Where | Why Reuse It |
|-------------|-------|--------------|
| `PlannerSessionMode` | `src/core/types/phases.ts` [VERIFIED: src/core/types/phases.ts] | This is the authoritative continue/fresh contract already threaded through top-planner dispatch and rerun flows [VERIFIED: src/orchestrator/scheduler/dispatch.ts][VERIFIED: src/orchestrator/scheduler/events.ts] |
| `FileSessionStore` | `src/runtime/sessions/index.ts` [VERIFIED: src/runtime/sessions/index.ts] | Persisted planner transcripts already live here, so UI copy about continuing or starting fresh should match this behavior [VERIFIED: src/runtime/sessions/index.ts] |
| `TopPlannerProposalMetadata` and collision helpers | `src/orchestrator/proposals/index.ts` [VERIFIED: src/orchestrator/proposals/index.ts] | Touched feature IDs, milestone IDs, session IDs, and collided runs are already preserved here for review surfaces [VERIFIED: src/orchestrator/proposals/index.ts][VERIFIED: src/orchestrator/scheduler/dispatch.ts] |
| Event log queries | `src/orchestrator/scheduler/events.ts` [VERIFIED: src/orchestrator/scheduler/events.ts] | Existing append-only planner events already represent the full audit trail needed by Phase 10 [VERIFIED: src/orchestrator/scheduler/events.ts] |
| `ComposerProposalController` | `src/tui/proposal-controller.ts` [VERIFIED: src/tui/proposal-controller.ts] | Draft snapshots, pending approval actions, and rerun routing already live here; preview work should extend this controller, not fork around it [VERIFIED: src/tui/proposal-controller.ts] |
| `displayedSnapshot(...)` + `pendingProposalForSelection(...)` | `src/tui/app-state.ts` [VERIFIED: src/tui/app-state.ts] | These are the current derived-state seams for live-vs-draft snapshot display and pending proposal selection [VERIFIED: src/tui/app-state.ts] |
| Overlay lifecycle helpers | `src/tui/app-overlays.ts` [VERIFIED: src/tui/app-overlays.ts] | New planner-reader/review surfaces should follow the existing overlay model used by inbox, merge-train, transcript, and config surfaces [VERIFIED: src/tui/app-overlays.ts][VERIFIED: src/tui/components/index.ts] |

## Recommended Architecture Shape

### Slice 10-01: session picker + audit-log reader

**Session picker**
- Add a small TUI affordance at the top-planner invocation seam and the `/rerun` seam.
- Reuse the authoritative `sessionMode?: PlannerSessionMode` parameter already accepted by:
  - `requestTopLevelPlan(prompt, options?)`
  - `rerunTopPlannerProposal(event?)`
  - scheduler `top_planner_requested`
  - scheduler `top_planner_rerun_requested`
- Default behavior should become explicit to the operator rather than silently relying on `fresh`.

**Audit-log reader**
- Add a derived reader surface that summarizes existing event history instead of dumping raw JSON.
- The minimum useful row shape is likely:
  - prompt text
  - session mode (`continue` / `fresh`)
  - session ID / previous session ID when relevant
  - touched features / milestones
  - proposal outcome (`applied`, `rejected`, `rerun requested`, `collision resolved`)
- The source of truth should remain `store.listEvents(...)` on top-planner plus feature IDs touched by metadata.

### Slice 10-02: proposal preview + comprehensive collision surface

**Proposal preview**
- Keep it read-only and approval-centric.
- Use existing draft snapshot / authoritative snapshot / pending proposal payloads to show what changes before the user decides.
- The preview does not need a new mutation path; it only needs a clearer presentation model.

**Collision surface**
- Expand the current composer/status-bar hint into a readable list.
- Reuse `collidedFeatureRuns` metadata directly.
- Show:
  - feature ID
  - proposal phase (`plan` or `replan`)
  - run status
  - whether approval will delete/reset its prior planner session
- Keep the actual reset behavior unchanged; approval should still route through existing scheduler handling.

## Recommended Project Structure

```text
src/
├── tui/app.ts                     # wire new overlay/pane refreshes
├── tui/app-overlays.ts            # register/toggle new session-picker/audit/review overlays
├── tui/app-composer.ts            # route any new slash commands or review actions
├── tui/commands/index.ts          # discoverable slash commands/keybinds
├── tui/components/index.ts        # audit-log / proposal-review overlay rendering
├── tui/view-model/index.ts        # derived session/audit/review/collision view models
├── tui/proposal-controller.ts     # preview / rerun plumbing reuse
├── tui/app-state.ts               # pending proposal + displayed snapshot helpers
├── compose.ts                     # expose list/query helpers through TuiAppDeps as needed
└── orchestrator/                  # event/query helpers only if TUI needs normalized planner history
```

Phase 10 should remain TUI-heavy with only narrow query/helper additions below it.

## Concrete File and Test Targets

### Primary implementation files

| File | Why it matters | Likely Phase 10 use |
|------|----------------|---------------------|
| `src/compose.ts` | Already exposes `requestTopLevelPlan(...)`, `rerunTopPlannerProposal(...)`, top-planner run lookup, and unresolved inbox/config deps [VERIFIED: src/compose.ts] | Thread any audit-log query helpers or session-picker entrypoints into `TuiAppDeps` [ASSUMED] |
| `src/tui/app.ts` | Central refresh loop and overlay-model update point [VERIFIED: src/tui/app.ts] | Refresh new planner audit/review/session-picker models from authoritative state |
| `src/tui/app-overlays.ts` | Existing show/hide lifecycle for overlays [VERIFIED: src/tui/app-overlays.ts] | Add planner-specific overlays without changing the overall TUI focus model |
| `src/tui/components/index.ts` | Generic boxed overlay rendering helpers already used everywhere else [VERIFIED: src/tui/components/index.ts] | Add readable planner session/audit/review components |
| `src/tui/view-model/index.ts` | Current home for inbox/config/merge-train/task-transcript summaries [VERIFIED: src/tui/view-model/index.ts] | Add derived audit-log, proposal-preview, and collision summary models |
| `src/tui/app-state.ts` | Already derives pending proposal hints and displayed snapshot [VERIFIED: src/tui/app-state.ts] | Extend pending proposal derivation with richer collision/review data |
| `src/tui/proposal-controller.ts` | Owns draft lifecycle, submit, approve/reject, and rerun [VERIFIED: src/tui/proposal-controller.ts] | Reuse existing approval/rerun control flow while improving read-only review |
| `src/orchestrator/scheduler/events.ts` | Canonical planner audit trail and collision-resolution events [VERIFIED: src/orchestrator/scheduler/events.ts] | Add normalized helper(s) only if the TUI needs a cleaner event summary source |
| `src/orchestrator/proposals/index.ts` | Canonical collision metadata shape [VERIFIED: src/orchestrator/proposals/index.ts] | Reuse directly for review surfaces and tests |

### Existing tests to extend first

| Test file | Existing coverage | Phase 10 extension |
|-----------|-------------------|--------------------|
| `test/unit/tui/view-model.test.ts` | Already covers approval composer status and collision hint derivation [VERIFIED: test/unit/tui/view-model.test.ts] | Add view-model tests for session-mode labels, audit summary rows, proposal preview rows, and explicit collision lists |
| `test/unit/orchestrator/scheduler-loop.test.ts` | Already covers top-planner rerun semantics, prompt-recorded events, and fresh-vs-continue session behavior [VERIFIED: test/unit/orchestrator/scheduler-loop.test.ts] | Keep as the contract test for session semantics; extend only if new helper queries are added |
| `test/integration/feature-phase-agent-flow.test.ts` | Already covers collision resolution and non-reset-on-reject behavior [VERIFIED: test/integration/feature-phase-agent-flow.test.ts] | Add integration assertions only if TUI-facing metadata/query behavior changes |
| `test/unit/tui/commands.test.ts` | Current home for slash-command routing coverage [VERIFIED: repo pattern][ASSUMED] | Add any new audit/review/session-picker command coverage |
| `test/unit/compose.test.ts` | Current home for TUI deps/compose wiring [VERIFIED: repo pattern][ASSUMED] | Add coverage if `compose.ts` exposes new planner-history query helpers |

## Common Pitfalls

### Pitfall 1: treating `fresh` as “same session but cleared UI state”
**What goes wrong:** the TUI suggests a fresh review flow but the runtime still reuses the previous persisted transcript.
**Why it happens:** `sessionMode` is not a cosmetic label — it controls `sessionId` reuse and session-file deletion on rerun [VERIFIED: src/orchestrator/scheduler/dispatch.ts][VERIFIED: src/orchestrator/scheduler/events.ts].
**How to avoid:** route every continue/fresh choice through the existing `sessionMode` parameter and keep UI wording aligned to real transcript behavior.

### Pitfall 2: reconstructing collisions from current graph state instead of metadata
**What goes wrong:** proposal review shows collision data that no longer matches the proposal under review.
**Why it happens:** live graph/runs can drift after the proposal was created, while the pending proposal already carries the authoritative collision metadata [VERIFIED: src/orchestrator/proposals/index.ts][VERIFIED: src/orchestrator/scheduler/dispatch.ts].
**How to avoid:** show the persisted `collidedFeatureRuns` from proposal metadata in review surfaces; use live state only where the runtime already revalidates on approval.

### Pitfall 3: making audit-log reading a raw event dump
**What goes wrong:** the operator gets unreadable JSON-like history instead of intent recovery.
**Why it happens:** the event log is low-level but complete.
**How to avoid:** build a derived audit row model in the TUI that summarizes prompt/session/scope/outcome while staying event-backed.

### Pitfall 4: previewing a shadow graph unrelated to the current proposal controller
**What goes wrong:** proposal review drifts from the actual approval payload.
**Why it happens:** Phase 10 introduces a separate preview model instead of reusing `displayedSnapshot(...)` and controller state.
**How to avoid:** derive preview directly from authoritative snapshot + draft snapshot + pending proposal payload.

## Suggested Slice Breakdown

| Slice | Scope | Primary Files | Exit Signal |
|------|-------|---------------|-------------|
| 10-01 | Explicit planner session picker and readable audit-log reader | `src/tui/app.ts`, `src/tui/app-overlays.ts`, `src/tui/components/index.ts`, `src/tui/view-model/index.ts`, `src/compose.ts` | User can intentionally choose continue/fresh and can inspect planner prompt history from the TUI without reading raw events |
| 10-02 | Read-only proposal preview and comprehensive collision surfacing | `src/tui/proposal-controller.ts`, `src/tui/app-state.ts`, `src/tui/app.ts`, `src/tui/view-model/index.ts`, `src/tui/components/index.ts` | Pending proposal review clearly shows what will change and which live planner runs approval will reset |

## Validation Architecture

### Focused verification

- `npm run typecheck`
- `npx vitest run test/unit/tui/view-model.test.ts test/unit/tui/commands.test.ts test/unit/compose.test.ts`
- `npx vitest run test/unit/orchestrator/scheduler-loop.test.ts test/integration/feature-phase-agent-flow.test.ts`

### What to prove

| Behavior | Test surface | Why |
|----------|--------------|-----|
| Continue vs fresh rerun semantics remain unchanged | `test/unit/orchestrator/scheduler-loop.test.ts` | This is the contract Phase 10 is surfacing, not reinventing [VERIFIED: test/unit/orchestrator/scheduler-loop.test.ts] |
| Pending proposal collision hints remain correct and grow into richer review models | `test/unit/tui/view-model.test.ts` | The current minimal hint already lives here [VERIFIED: test/unit/tui/view-model.test.ts] |
| Collision approval still resets only on approve, not reject | `test/integration/feature-phase-agent-flow.test.ts` | This is the operator-facing promise under the new review UX [VERIFIED: test/integration/feature-phase-agent-flow.test.ts] |
| New audit/review commands route correctly | `test/unit/tui/commands.test.ts` | Slash-command routing already lives there by repo pattern [ASSUMED] |

## Sources

### Primary (HIGH confidence)
- `.planning/ROADMAP.md` — Phase 10 goal, plans, and success criteria [VERIFIED: .planning/ROADMAP.md]
- `.planning/REQUIREMENTS.md` — REQ-PLAN-04, REQ-PLAN-06, REQ-PLAN-07 [VERIFIED: .planning/REQUIREMENTS.md]
- `.planning/STATE.md` — current milestone position and phase focus [VERIFIED: .planning/STATE.md]
- `.planning/phases/10-re-plan-flows-and-manual-edits-polish/10-CONTEXT.md` — locked scope and prior decisions [VERIFIED: .planning/phases/10-re-plan-flows-and-manual-edits-polish/10-CONTEXT.md]
- `src/core/types/phases.ts` — `PlannerSessionMode` contract [VERIFIED: src/core/types/phases.ts]
- `src/runtime/sessions/index.ts` — persisted planner transcript storage [VERIFIED: src/runtime/sessions/index.ts]
- `src/orchestrator/scheduler/dispatch.ts` — top-planner session reuse/reset and proposal metadata creation [VERIFIED: src/orchestrator/scheduler/dispatch.ts]
- `src/orchestrator/scheduler/events.ts` — planner audit events, rerun behavior, collision resolution, approval/rejection flows [VERIFIED: src/orchestrator/scheduler/events.ts]
- `src/orchestrator/proposals/index.ts` — collision metadata parsing and derivation [VERIFIED: src/orchestrator/proposals/index.ts]
- `src/orchestrator/ports/index.ts` — store event/inbox/query surfaces [VERIFIED: src/orchestrator/ports/index.ts]
- `src/compose.ts` — top-planner TUI deps wiring and session-mode request entrypoints [VERIFIED: src/compose.ts]
- `src/tui/app-state.ts` — displayed snapshot and pending proposal selection [VERIFIED: src/tui/app-state.ts]
- `src/tui/proposal-controller.ts` — draft lifecycle, pending approval actions, rerun plumbing [VERIFIED: src/tui/proposal-controller.ts]
- `src/tui/app.ts` — TUI refresh loop and overlay model wiring [VERIFIED: src/tui/app.ts]
- `src/tui/app-overlays.ts` — overlay lifecycle pattern [VERIFIED: src/tui/app-overlays.ts]
- `src/tui/app-composer.ts` — slash command routing and proposal approval path [VERIFIED: src/tui/app-composer.ts]
- `src/tui/commands/index.ts` — discoverable slash commands and keybinds [VERIFIED: src/tui/commands/index.ts]
- `src/tui/components/index.ts` — existing overlay rendering patterns [VERIFIED: src/tui/components/index.ts]
- `src/tui/view-model/index.ts` — current composer/inbox summary logic and collision hint wording [VERIFIED: src/tui/view-model/index.ts]
- `test/unit/tui/view-model.test.ts` — current collision-hint view-model coverage [VERIFIED: test/unit/tui/view-model.test.ts]
- `test/unit/orchestrator/scheduler-loop.test.ts` — current continue/fresh session and planner event coverage [VERIFIED: test/unit/orchestrator/scheduler-loop.test.ts]
- `test/integration/feature-phase-agent-flow.test.ts` — current collision approval/rejection integration behavior [VERIFIED: test/integration/feature-phase-agent-flow.test.ts]

### Secondary (MEDIUM confidence)
- None — this research relied on current repo code, tests, and planning artifacts only.

### Tertiary (LOW confidence)
- Exact choice of overlay vs side pane vs command-routed planner reader/review surface remains an implementation discretion point to settle in planning [ASSUMED].

## Metadata

**Confidence breakdown:**
- Session semantics: HIGH
- Audit-log source-of-truth analysis: HIGH
- Collision/review path analysis: HIGH
- TUI implementation seam fit: HIGH
- Verification shape: HIGH

**Research date:** 2026-05-01
**Valid until:** Phase 10 implementation begins; if planner/TUI proposal wiring changes first, re-check compose/app/proposal-controller seams before coding
