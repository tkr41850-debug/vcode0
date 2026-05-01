# Phase 7: Top-Level Planner + Inbox + Pause/Resume — Research

**Researched:** 2026-04-25
**Domain:** top-level planner runtime, inbox model + routing, two-tier pause/checkpoint/respawn, planner sessioning, collisions, audit log
**Confidence:** HIGH (all findings verified from codebase and prior phase artifacts; no external library research required beyond the existing Phase 3 spike decision)

---

<user_constraints>
## User Constraints (from CONTEXT.md and carried phase decisions)

### Locked Decisions

- Research must happen before planning.
- No persistent "goal" entity; milestones are the persistent grouping and planner prompts are audit-log context.
- Top-level planning must reuse the existing proposal/apply model where possible rather than inventing a second graph-edit path.
- Re-invoking a planner is additive-only with respect to running or completed work.
- Manual edits always win over planner output.
- Inbox is the unified operator-attention model, not an ad-hoc per-surface queue.
- Two-tier pause is locked conceptually: hot window first, then checkpoint + process release.
- Phase 3's resume decision is locked: `RESUME_STRATEGY = 'persist-tool-outputs'` via `@runtime/resume`.
- Existing code is reference, not baseline; rewriting or reshaping current partial surfaces is allowed when it improves clarity and serves the requirements.

### Requirements in Scope

| ID | Canonical wording | Research support |
|----|-------------------|------------------|
| REQ-PLAN-01 | Top-level planner agent turns a prompt into a feature DAG via inline chat | `topPlanner` config role exists, proposal tools already support milestone/feature edits, but no runtime implementation exists yet |
| REQ-PLAN-03 | Re-invoking a planner is additive only | Existing proposal warnings/skips on started work are the nearest analog; Phase 7 must harden this for top-level planner edits |
| REQ-PLAN-04 | User picks continue prior chat or fresh session | Feature-phase dispatch already reuses vs clears `sessionId`; no top-level session registry exists yet |
| REQ-PLAN-06 | Planner prompts persist as an audit log alongside created features | Existing event log stores proposal/phase provenance, but no explicit top-level planner prompt log exists |
| REQ-PLAN-07 | Collision surface when top-level edits target a feature with a running feature planner | No collision detector exists yet; rerun/session-reset analog already exists for feature phases |
| REQ-INBOX-01 | Agent `await_response` / `request_help` routes to inbox | `request_help` only updates run state today; no inbox row is appended |
| REQ-INBOX-02 | Hot-window pause retains worker and worktree; then checkpoint after expiry | `pauseTimeouts.hotWindowMs` exists, but no pause orchestration or checkpoint save cadence is wired |
| REQ-INBOX-03 | Respawn replay uses the Phase 3 spike strategy | `resume(...)`, `FileSessionStore`, and `ToolOutputStore` exist, but worker/harness integration is incomplete |
| REQ-INBOX-04 | One inbox answer can unblock multiple tasks | Current help/approval response delivery is single-task only |
| REQ-TUI-02 | Inbox is the unified waiting-on-you surface | Merge-train cap parking + destructive approvals already append inbox rows; the inbox model is still missing query/resolution APIs |
| REQ-STATE-04 | Top-level planner may propose milestone splits/merges | Milestone proposal tools already exist; no top-level planner runtime exposes them yet |

### Deferred Ideas (OUT OF SCOPE)

- Rich inbox filters, full inbox UI, and TUI polish remain Phase 8+.
- Crash recovery summary inbox items and orphan-worktree triage remain Phase 9.
- Proposal preview and audit-log reader UI remain Phase 10.

</user_constraints>

<phase_requirements>
## Phase Requirements

| Requirement | Current state | Gap to close in Phase 7 |
|-------------|---------------|--------------------------|
| REQ-PLAN-01 | Proposal host + planner tools already support `addMilestone`, `addFeature`, `editFeature`, `removeFeature`, task edits, and dependencies | Introduce a top-level planner runtime and approval flow that operates at prompt→milestone/feature DAG scope |
| REQ-PLAN-03 | `applyGraphProposal(...)` warns/skips stale removals of started features/tasks | Enforce additive-only semantics for top-level re-invocation and proposal apply against live work |
| REQ-PLAN-04 | Feature-phase dispatch already differentiates session reuse vs fresh rerun via `sessionId` | Add a top-level planner session registry + user choice surface |
| REQ-PLAN-06 | Events already persist proposal and phase outcomes with `sessionId` references | Persist top-level planner prompts/sessions as audit-log records associated with affected milestones/features |
| REQ-PLAN-07 | Rerun/reset mechanics exist for feature phases | Add collision detection + proposal flagging when top-level edits target a feature with an active planner run |
| REQ-INBOX-01 | Task runs already enter `await_response` / `await_approval`; inbox append exists for some producer kinds | Route help/approval/attention items through a queryable inbox model |
| REQ-INBOX-02 | `pauseTimeouts.hotWindowMs` config exists; worker emits `message_end`/`turn_end` events | Add pause timers, activity reset, transcript checkpointing, and process-release orchestration |
| REQ-INBOX-03 | `resume(...)`, `RESUME_STRATEGY`, `FileSessionStore`, and file-backed tool output store exist | Wire tool-output capture + transcript save cadence + respawn path into production worker/runtime flows |
| REQ-INBOX-04 | `compose.ts` responds to one task at a time | Add inbox-level grouping/fan-out semantics for equivalent questions/approvals |
| REQ-TUI-02 | `inbox_items` table exists with merge-train/destructive-action rows | Add list/resolve/query semantics and additional item producers so the model is ready for a unified UI surface |
| REQ-STATE-04 | Milestones already exist and proposal tools can add/edit them | Expose milestone edits through the top-level planner runtime and proposal review |

</phase_requirements>

---

## Summary

Phase 7 is mostly integration and model completion rather than brand-new primitives. The codebase already contains the majority of the hard pieces in isolated form:

1. **Draft graph editing already exists.** `GraphProposalToolHost` and `createPlannerToolset(...)` already support milestone/feature/task CRUD in a draft `InMemoryFeatureGraph`, and `applyGraphProposal(...)` already resolves aliases, skips stale ops, and warns about removing started work.
2. **Planner session reuse already exists at the feature-phase level.** `dispatchFeaturePhaseUnit(...)` reuses `sessionId` for ordinary reruns and clears it for fresh reruns, which is the exact behavioral analog for REQ-PLAN-04.
3. **Inbox persistence already exists, but only as append-only storage.** `inbox_items` has durable rows with a `resolution` column, yet the Store port and SQLite implementation expose only `appendInboxItem(...)`; there is no list/resolve/query surface.
4. **Pause/resume primitives already exist, but they are not wired end-to-end.** `FileSessionStore`, `resume(...)`, `RESUME_STRATEGY='persist-tool-outputs'`, and the file-backed tool-output store all exist, but the worker still only saves the transcript at run end and does not persist tool outputs at all.
5. **Task waits already affect run state, but not the inbox model.** `request_help` and `request_approval` correctly transition runs to `await_response` / `await_approval`, but only destructive approvals append inbox items today.
6. **There is no top-level planner runtime yet.** The config reserves the `topPlanner` role, but `src/agents/planner.ts` and `src/agents/runtime.ts` still only model feature-scoped planner phases.

**Primary recommendation:** plan Phase 7 as five slices matching the roadmap: (1) top-level planner runtime + additive-only guardrails, (2) inbox model + agent-ask routing + multi-task unblock, (3) two-tier pause/checkpoint/respawn wiring using the Phase 3 spike decision, (4) planner session registry + audit log, (5) collision detection and proposal flagging for edits against active feature planners.

---

## Architectural Responsibility Map

| Capability | Primary tier | Secondary tier | Verified basis |
|------------|--------------|----------------|----------------|
| Draft top-level graph editing | `@agents/tools` proposal host/toolset | `@core/proposals` | Existing milestone/feature/task proposal tools already support the needed draft graph mutations |
| Top-level planner runtime | new or extended `@agents` runtime surface | `@orchestrator/scheduler/dispatch` | No implementation exists yet; feature-phase runtime is the nearest analog |
| Additive-only proposal apply | `@core/proposals` + orchestrator approval layer | proposal-view/UI layer | Existing warnings/skips on started work are the starting point |
| Continue-vs-fresh sessioning | scheduler dispatch / run registry | session store | Existing feature-phase `sessionId` reuse vs reset pattern is already implemented |
| Inbox persistence/query/resolution | Store port + SQLite store | scheduler event producers | Table exists; port/query methods do not |
| Agent ask routing | scheduler event handler | compose/UI response surface | `request_help` / `request_approval` already hit run state; help still lacks inbox item append |
| Hot-window pause timers | orchestrator/runtime coordination | config + worker events | `pauseTimeouts.hotWindowMs` exists, but no pause controller exists |
| Transcript checkpointing | worker runtime + session store | harness/recovery service | worker emits `message_end` / `turn_end` but only saves transcript at final completion |
| Respawn replay | runtime harness + `@runtime/resume` | recovery service | spike-decision primitives exist; not wired into worker/harness production flow |
| Collision detection | proposal-view / approval layer | scheduler run lookup | no current implementation, but feature-phase runs and run-state queries exist |
| Planner audit log | event log + session records | features/milestones | current closest analog is `feature_phase_completed` + proposal events |

---

## Standard Stack

No new dependencies are required for Phase 7.

| Component | Location | Purpose |
|-----------|----------|---------|
| `GraphProposalToolHost` | `src/agents/tools/proposal-host.ts` | Draft milestone/feature/task graph mutation |
| `createPlannerToolset(...)` | `src/agents/tools/planner-toolset.ts` | Typed planner tool surface |
| `applyGraphProposal(...)` | `src/core/proposals/index.ts` | Alias resolution, stale-op skipping, warning generation, apply summary |
| `dispatchFeaturePhaseUnit(...)` | `src/orchestrator/scheduler/dispatch.ts` | Existing session reuse vs fresh rerun semantics |
| `handleSchedulerEvent(...)` | `src/orchestrator/scheduler/events.ts` | Proposal approval/rejection/rerun handling; task wait routing |
| `FileSessionStore` | `src/runtime/sessions/index.ts` | Durable transcript persistence |
| `resume(...)` / `RESUME_STRATEGY` | `src/runtime/resume/index.ts` | Phase 3 spike decision surface for replay |
| `createFileToolOutputStore(...)` | `src/runtime/resume/tool-output-store.ts` | Durable tool-output persistence for replay |
| `RecoveryService` | `src/orchestrator/services/recovery-service.ts` | Current resumable-run boot recovery |
| `pauseTimeouts.hotWindowMs` | `src/config/schema.ts` | Existing hot-window config knob |
| `inbox_items` table | `src/persistence/migrations/0005_inbox_items.sql` | Durable inbox storage with nullable `resolution` |
| `ComposerProposalController` | `src/tui/proposal-controller.ts` | Closest existing UI-side draft + submit pattern |

---

## Verified Findings

### 1. Top-level planner role exists only in config today

`src/config/schema.ts` includes `topPlanner` in `AgentRoleEnum`, so model routing already reserves the role. But `src/agents/planner.ts` exposes only feature-scoped methods (`discussFeature`, `researchFeature`, `planFeature`, `verifyFeature`, `summarizeFeature`), and `PiFeatureAgentRuntime` in `src/agents/runtime.ts` is likewise feature-scoped.

**Implication:** Phase 7 does not need a new model-routing concept; it needs a new runtime/orchestrator surface that actually uses the reserved role.

### 2. Proposal infrastructure already supports milestone/feature scope

`GraphProposalToolHost` supports `addMilestone`, `addFeature`, `editFeature`, `removeFeature`, `addTask`, `editTask`, dependency edits, and `submit()`. `applyGraphProposal(...)` already warns on removing started features/tasks and skips stale ops.

**Implication:** The top-level planner should reuse this draft/apply mechanism rather than hand-rolling another graph mutation path.

### 3. Continue-vs-fresh already has a concrete analog

In `dispatchFeaturePhaseUnit(...)`, completed proposal phases effectively rerun fresh by clearing `sessionId`, while ordinary reruns reuse it. The scheduler also handles explicit `feature_phase_rerun_requested` by deleting the existing session and resetting the run to `ready`.

**Implication:** Phase 7 can build planner-session choice on top of existing `sessionId` semantics instead of inventing a new persistence model.

### 4. Audit-log analogs already exist, but prompt provenance does not

`PiFeatureAgentRuntime.recordPhaseCompletion(...)` appends `feature_phase_completed` events with `{ phase, summary, sessionId, extra }`. Scheduler approval handling appends `proposal_applied`, `proposal_rejected`, and `proposal_rerun_requested` events.

**Implication:** Phase 7 should extend the existing append-only event/audit pattern with top-level planner prompt/session records rather than adding a separate persistence silo.

### 5. Inbox persistence exists but cannot yet be queried or resolved through the Store port

`inbox_items` has `id`, `ts`, `task_id`, `agent_run_id`, `feature_id`, `kind`, `payload`, and nullable `resolution`. `SqliteStore` prepares only an insert statement and exposes only `appendInboxItem(...)`.

**Implication:** Phase 7 likely needs a Store-port expansion plus SQLite queries/updates before UI work can treat the inbox as a first-class surface.

### 6. `request_help` is not yet an inbox item

In `handleSchedulerEvent(...)`, `request_help` sets the run to `await_response`, assigns manual ownership, and stores `{ query }` in `payloadJson`, but it returns without calling `appendInboxItem(...)`. `request_approval` similarly sets `await_approval`, but only `destructive_action` approvals append an inbox row.

**Implication:** REQ-INBOX-01 is only partially satisfied today; Phase 7 must materialize help/approval waits into inbox rows.

### 7. Operator responses are single-task only today

`compose.ts` implements `respondToTaskHelp(taskId, response)` and `decideTaskApproval(taskId, decision)` for one task/run at a time.

**Implication:** REQ-INBOX-04 requires a model above these APIs — likely grouped inbox items with fan-out resolution.

### 8. Pause timeout config exists, but pause orchestration does not

`pauseTimeouts.hotWindowMs` is already part of the config schema and covered by config tests. There is no orchestrator/controller that tracks hot-window expiry, resets on activity, or releases the process after timeout.

**Implication:** The configuration contract is ready; the lifecycle machinery is not.

### 9. Worker transcript persistence is still too late for checkpointed pause

The worker emits `message_end` and `turn_end` events in `handleAgentEvent(...)`, but only sends UI/progress output. The transcript is saved with `sessionStore.save(sessionId, finalMessages)` only after the prompt/continue call settles.

**Implication:** Phase 7 must start saving at `message_end` and/or `turn_end` to support hot-window expiry and crash-safe checkpointing before run completion.

### 10. Tool-output replay primitives exist, but the worker never records tool outputs

The Phase 3 spike landed `createFileToolOutputStore(...)` and `resume(...)`. A repo-wide search shows no production `afterToolCall` hook or `ToolOutputStore.record(...)` wiring in `src/`.

**Implication:** REQ-INBOX-03 is blocked on production capture of tool results, not on replay algorithm design.

### 11. Recovery resumes running/help/approval waits, but there is no paused/checkpointed state yet

`RecoveryService.shouldResumeTaskRun(...)` returns true only for `running`, `await_response`, and `await_approval`. `AgentRunStatus` has no `paused` or `checkpointed` value.

**Implication:** Phase 7 must decide whether to extend run statuses or encode paused/checkpoint metadata elsewhere; either way the current recovery path is insufficient for two-tier pause.

### 12. TUI proposal controller is the closest current top-level-draft analog

`ComposerProposalController` already builds a draft host, pauses auto-execution while a draft is active, submits into `await_approval`, and restores auto mode on submit/discard.

**Implication:** Phase 7 can likely reuse or align with this controller for top-level proposal review and future collision/proposal-view work.

---

## Architecture Patterns

### Recommended Phase 7 slice map

1. **07-01 — Top-level planner runtime + additive-only guardrails**
   - Introduce a top-level planner runtime using the existing proposal host/toolset.
   - Reuse proposal approval/apply events.
   - Harden started-work edits from warnings into a visible top-level planner constraint.

2. **07-02 — Inbox domain model + agent-ask routing + grouped resolution**
   - Expand the Store port with inbox list/query/resolve APIs.
   - Append inbox rows for `request_help` and non-destructive approvals too.
   - Add grouping/fan-out semantics so one answer can unblock equivalent waits.

3. **07-03 — Two-tier pause + checkpoint + respawn-with-replay**
   - Persist transcripts during the run, not only at the end.
   - Wire `afterToolCall` to a per-run file-backed tool-output store.
   - On expiry: release the worker process, retain worktree, respawn later via `resume(...)`.

4. **07-04 — Planner session registry + audit log**
   - Add top-level planner session bookkeeping with continue vs fresh choice.
   - Persist prompt/session provenance as audit-log entries associated with affected features/milestones.

5. **07-05 — Collision detection and proposal-view flagging**
   - Detect top-level edits that target features with active feature-planner runs.
   - Surface collisions in proposal review; on accept, cancel/reset the running feature planner and rerun on the new shape.

### Existing analogs to copy

| New need | Closest analog |
|----------|----------------|
| Top-level proposal draft lifecycle | `ComposerProposalController` + proposal approval in scheduler events |
| Continue vs fresh session behavior | `dispatchFeaturePhaseUnit(...)` session reuse/reset |
| Audit trail append shape | `feature_phase_completed`, `proposal_applied`, `proposal_rejected`, `proposal_rerun_requested` events |
| Queryable unresolved items | `inbox_items` schema with `resolution IS NULL` index |
| Replay strategy | `@runtime/resume` + spike checklist in `docs/spikes/pi-sdk-resume.md` |
| Recovery respawn baseline | `RecoveryService.resumeTaskRun(...)` + `PiSdkHarness.resume(...)` |

---

## Don’t Hand-Roll

| Problem | Don’t build | Use instead | Why |
|---------|-------------|-------------|-----|
| Draft graph editing | Custom ad-hoc graph mutation commands | `GraphProposalToolHost` + `createPlannerToolset(...)` | Already typed, draft-only, and approval-ready |
| Proposal apply semantics | New top-level apply engine | `applyGraphProposal(...)` + existing approval event flow | Already handles aliases, stale ops, warnings, and summary |
| Session persistence | New planner transcript store | existing `sessionId` + `FileSessionStore` | Already used by feature phases and task runtime |
| Replay algorithm | Native `Agent.continue()` guessing | `resume(...)` from `@runtime/resume` | Phase 3 spike already chose the stable strategy |
| Inbox durability | Separate ad-hoc table or JSON blob | `inbox_items` + Store-port expansion | Schema already exists and is indexed |
| Worker respawn primitive | New custom resume harness | `PiSdkHarness.resume(...)` | Already resumes task runs when a session exists |

---

## Common Pitfalls

### Pitfall 1: Treating warning-only proposal skips as sufficient additive-only enforcement
The current proposal layer warns/skips some invalid edits, but REQ-PLAN-03 is stronger: top-level planner re-invocation must never silently mutate running or completed work. Phase 7 should surface this explicitly in proposal review instead of assuming warnings alone are enough.

### Pitfall 2: Building inbox UI semantics before inbox query semantics
The DB already has a `resolution` column, but the Store port exposes only append. If Phase 7 tries to solve UI/interaction first, it will end up tunneling around the persistence boundary.

### Pitfall 3: Reusing `await_response` / `await_approval` as the final pause model
Those run statuses represent operator waits, not checkpointed/offline pause state. Two-tier pause needs either new run statuses or clearly separated persisted pause metadata, or recovery logic will remain ambiguous.

### Pitfall 4: Assuming transcripts are already checkpoint-safe mid-run
They are not. Today the worker only saves `finalMessages` after the run settles. Hot-window expiry requires mid-run persistence wired from `message_end` / `turn_end`.

### Pitfall 5: Wiring replay without tool-output persistence
`resume(...)` depends on stored tool results for assistant-terminal transcripts with tool calls. Without `afterToolCall` persistence, the replay path remains incomplete even if the session transcript is saved.

### Pitfall 6: Implementing top-level planner sessions without collision awareness
Top-level edits can target a feature whose own planner is active. Without collision detection at proposal review time, Phase 7 would violate REQ-PLAN-07 by allowing silent planner overwrites.

---

## Test Surface Map

### Strong existing analog tests

| Area | Existing tests |
|------|----------------|
| Proposal apply / warnings / alias resolution | `test/unit/core/proposals.test.ts`, `test/unit/orchestrator/proposals.test.ts` |
| Feature-phase approval / rerun flow | `test/unit/orchestrator/scheduler-loop.test.ts`, `test/integration/feature-phase-agent-flow.test.ts` |
| TUI proposal draft/submit flow | `test/unit/tui/proposal-controller.test.ts` |
| Help/approval wait routing | `test/unit/orchestrator/scheduler-loop.test.ts`, `test/integration/worker-smoke.test.ts` |
| Inbox producers already present | `test/integration/destructive-op-approval.test.ts`, merge-train tests |
| Resume strategy and tool-output store | `test/integration/spike/pi-sdk-resume.test.ts`, `test/unit/runtime/resume/tool-output-store.test.ts` |
| Recovery/session resume | `test/unit/orchestrator/recovery.test.ts`, `test/unit/runtime/pi-sdk-harness.test.ts` |

### Likely new tests needed in Phase 7

- top-level planner runtime happy path: prompt → proposal → await_approval
- additive-only top-level re-invocation against running/completed features
- continue prior chat vs fresh session selection for top-level planner
- `request_help` / generic approval inbox item creation and resolution
- multi-task single-answer unblock behavior
- hot-window expiry with transcript checkpoint + worker release
- respawn replay using saved session + tool outputs
- collision flagging when top-level proposal targets a feature with active planner run
- planner audit-log persistence and retrieval semantics

---

## Proposed Planning Order

1. **07-01 first** because top-level planner runtime and additive-only constraints define the main phase skeleton.
2. **07-02 second** because inbox routing and resolution semantics are prerequisites for pause UX and operator handling.
3. **07-03 third** because it builds on inbox/pause semantics and the Phase 3 spike decision.
4. **07-04 fourth** because session registry and audit log refine planner continuity once the runtime exists.
5. **07-05 last** because collision handling depends on both planner sessions and proposal-view semantics.

This order matches the roadmap and minimizes rework: runtime scope -> attention model -> checkpointing -> continuity -> collision polish.

---

## Sources

### Primary (HIGH confidence — verified from codebase)
- `.planning/REQUIREMENTS.md`
- `.planning/phases/06-merge-train/06-CONTEXT.md`
- `.planning/phases/06-merge-train/06-RESEARCH.md`
- `.planning/phases/06-merge-train/VERIFICATION.md`
- `docs/spikes/pi-sdk-resume.md`
- `src/config/schema.ts`
- `src/compose.ts`
- `src/agents/planner.ts`
- `src/agents/runtime.ts`
- `src/agents/tools/planner-toolset.ts`
- `src/agents/tools/proposal-host.ts`
- `src/core/proposals/index.ts`
- `src/core/types/runs.ts`
- `src/orchestrator/ports/index.ts`
- `src/orchestrator/scheduler/dispatch.ts`
- `src/orchestrator/scheduler/events.ts`
- `src/orchestrator/services/recovery-service.ts`
- `src/persistence/migrations/0005_inbox_items.sql`
- `src/persistence/sqlite-store.ts`
- `src/runtime/harness/index.ts`
- `src/runtime/resume/index.ts`
- `src/runtime/resume/tool-output-store.ts`
- `src/runtime/sessions/index.ts`
- `src/runtime/worker/index.ts`
- `src/tui/proposal-controller.ts`

### Test evidence scanned
- `test/unit/core/proposals.test.ts`
- `test/unit/orchestrator/proposals.test.ts`
- `test/unit/orchestrator/scheduler-loop.test.ts`
- `test/unit/tui/proposal-controller.test.ts`
- `test/unit/orchestrator/recovery.test.ts`
- `test/unit/runtime/pi-sdk-harness.test.ts`
- `test/unit/runtime/resume/tool-output-store.test.ts`
- `test/integration/feature-phase-agent-flow.test.ts`
- `test/integration/worker-smoke.test.ts`
- `test/integration/destructive-op-approval.test.ts`
- `test/integration/merge-train.test.ts`
- `test/integration/spike/pi-sdk-resume.test.ts`

---

## Metadata

**Confidence breakdown:**
- Top-level planner/runtime gap: HIGH
- Inbox model/routing gap: HIGH
- Pause/replay integration gap: HIGH
- Collision/session/audit-log gap: HIGH

**Research date:** 2026-04-25
**Valid until:** 2026-05-25 (or until scheduler/runtime/session contracts change materially)
