# Phase 4 — Project-planner agent + dispatch

## Goal

Introduce the project-planner agent role, the dispatch path that runs project-scope sessions, and the persistence/lifecycle plumbing that makes sessions resumable. After this phase, a project-planner session can be started programmatically (TUI wiring lands in Phase 6, bootstrap rewrite lands in Phase 5).

## Scope

**In:** new `projectPlannerTools` agent construction in `src/agents/runtime.ts`; project-scope `dispatchProjectRunUnit` invoked event-driven from coordinator and recovery service (no `SchedulableUnit` extension, no `prioritizeReadyWork` change); `RunScope` / `RuntimePort.dispatchRun` / `WorkerPool` typing extension for the project arm; session create / resume / cancel orchestrator surface; recovery-service rehydrate of orphaned project sessions on boot; agent prompt for project planner; conversation history persistence reuses the per-session file path; `await_approval` and apply CAS for project proposals; `ProposalRebaseReason` shape exported for Phase 6 to render; milestone-reassignment patch field on `PlannerFeatureEditPatch` (or sibling `moveFeatureToMilestone` op).

**Out:** TUI mode and chat surface (Phase 6); bootstrap auto-spawn (Phase 5); escalation prompt guidance (Phase 7); submit-compliance prompt and tool_choice work (Phase 8); any change to `SchedulableUnit` or `prioritizeReadyWork` (project runs are intentionally not graph-driven).

## Background

Verified state on `main`:

- `src/orchestrator/scheduler/dispatch.ts` has `dispatchFeaturePhaseUnit` and `dispatchTaskUnit`. No project-scope dispatch path exists.
- `prioritizeReadyWork` (`src/core/scheduling/index.ts`, not `dispatch.ts`) collects feature-phase units from `graph.readyFeatures()` and tasks from `graph.readyTasks()`. `SchedulableUnit` is currently `task | feature_phase` only. Project sessions are not in the graph and **are not scheduler-tick-driven** — see "Dispatch model" below.
- `featurePhaseRequiresFeatureWorktree` (`src/orchestrator/scheduler/dispatch.ts`) returns true only for `execute | verify | ci_check | summarize` — i.e. false for `discuss | research | plan | replan`. Project runs need the same negative answer (no feature worktree).
- `agent_runs.scope_type='project'` is **introduced by Phase 2**, not present on `main`. Today `RunScope` only models `task | feature_phase`; `RuntimePort.dispatchRun(scope, dispatch, payload)` accepts only those two arms (`src/runtime/contracts.ts`, `src/runtime/worker-pool.ts`). Phase 4 owns extending `RunScope`, `RuntimePort.dispatchRun`, and `WorkerPool` to accept the project arm; Phase 4 hard-depends on Phase 2 having landed.
- `projectPlannerTools` is **introduced by Phase 3**, not present on `main`. Current planner tooling is `createPlannerToolset` in `src/agents/tools/planner-toolset.ts`; the prompt registry in `src/agents/prompts/index.ts` has no project-planner prompt yet.
- The `plan`/`replan` phases today use `startPlanFeature` (and `startReplanFeature`) in `src/agents/runtime.ts` → `createProposalPhaseSessionHandle` in `src/runtime/harness/feature-phase/index.ts`. The project-planner agent reuses the same proposal-host / submit / await_approval shape, just with a different toolset and different scope on the agent_run.
- Conversation/session persistence is **file-per-session** under `.gvc0/sessions/<sessionId>.json` via `src/runtime/sessions/index.ts`, with `agent_runs.session_id` linking to the file. It is **not** an event log keyed on `run_id`. Project sessions reuse the same per-session file path; Phase 4 only adds the new `agent_runs` row and the session id linkage.
- **Milestone-reassignment gap.** Today's `PlannerFeatureEditPatch` (`src/core/graph/types.ts:65-75`) has no `milestoneId` field, so `editFeature` cannot move a feature between milestones. There is a graph-level `changeMilestone(...)` but no proposal op or tool exposing it. Project-planner authority requires either extending the patch shape or adding a sibling `moveFeatureToMilestone` tool, plus routing it through the existing apply path. Pick whichever lands more cleanly with the proposal-host validation contract; Step 4.1 owns the call.
- **Two-scope assumptions to update.** Adding the `'project'` arm requires touching `src/orchestrator/scheduler/dispatch.ts`, `src/orchestrator/services/recovery-service.ts`, `src/orchestrator/services/budget-service.ts`, `src/runtime/error-log/index.ts`, `src/persistence/codecs.ts`, `src/compose.ts`, and `src/tui/view-model/index.ts`. Phase 2's Step 2.3 lists most of these; confirm none have regressed when Phase 4 lands.

**Dispatch model.** Project-run dispatch is **event-driven from the coordinator and recovery service**, not scheduler-tick-driven. The scheduler tick stays graph-driven (feature phases + tasks) and `SchedulableUnit` does **not** gain a `project_run` arm. Two consequences:

- The architecture boundary holds: `core/scheduling/` does not need to import `Store` or query the persistence layer. Project runs are dispatched inline by the coordinator (Step 4.3) at session create / resume time, and rehydrated by the recovery service (Step 4.3) at orchestrator boot.
- `Store.listProjectSessions(...)` (Phase 2) is consumed by (a) the recovery service for boot-time rehydrate and (b) the TUI session-list view (Phase 6). It is not consumed by `prioritizeReadyWork`.

Project sessions live in `runStatus='running'` from the moment the coordinator creates them (no new `'ready'` status — the existing `AgentRunStatus` union is unchanged). The coordinator dispatches once at create-time; the existing `running`-skip predicate in `prioritizeReadyWork` is irrelevant because project runs never enter that collection.

## Steps

Ships as **4 commits**, in order.

---

### Step 4.1 — Project-planner agent construction

**What:** add `startProjectPlannerSession` (or analogous helper) to `src/agents/runtime.ts` that constructs an `Agent` with `projectPlannerTools` and the project-planner system prompt. The agent is created against a `proposalToolHost` whose draft graph is the current authoritative graph snapshot. The session is keyed on a project run id.

**Files:**

- `src/agents/runtime.ts` — add the helper. Reuse the existing proposal-host construction pattern. The agent receives the project-planner prompt (defined in this same step, below) and the project-planner toolset (via `createProjectPlannerToolset(host)` from Phase 3).
- `src/agents/prompts/project-planner.ts` (new) — prompt scaffold; minimal at this phase. Final wording lands in Phase 8. (Live prompt source is `.ts` under `src/agents/prompts/`; `docs/agent-prompts/project-planner.md` is the doc mirror added by the docs-update sweep, not the live source.)
- `src/agents/prompts/index.ts` — register the new prompt file in the prompt registry. **Extend** the `PromptTemplateName` union (`:7-13`) with `'project-planner'`; add the corresponding entry in the prompt registry record.
- **Milestone-reassignment patch.** Extend `PlannerFeatureEditPatch` with `milestoneId` (or add a sibling `moveFeatureToMilestone` op to `proposal-host.ts` and `schemas.ts`). Step 4.1 owns this so the project-planner toolset has full topology authority on first dispatch (Step 4.2). The graph-level `changeMilestone(...)` already exists; this just exposes it through the proposal layer.
- `test/unit/agents/runtime.test.ts` — coverage that the helper attaches `projectPlannerTools` and the project prompt to the agent.
- `test/unit/agents/tools/proposal-host.test.ts` (or sibling) — coverage that the milestone-reassignment op routes through `applyGraphProposal` correctly.

**Tests:**

- Helper returns an agent whose tool list matches the project-planner catalog (from `createProjectPlannerToolset`).
- Helper rejects construction when called with a non-project scope (defensive — the agent_run row passed in must have `scope_type='project'`).
- `editFeatureSpec` rejects `{ milestoneId }` patches (deferred from Phase 3 Step 3.1; this commit lands the assertion now that `milestoneId` exists on `PlannerFeatureEditPatch`).
- Existing `startPlanFeature` / `startReplanFeature` paths are unchanged.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify project agent construction: (1) helper exists in `src/agents/runtime.ts`; (2) toolset is `projectPlannerTools`; (3) prompt file is loaded; (4) feature-scope helpers are not affected. Under 250 words.

**Commit:** `feat(agents/project-planner): agent construction`

---

### Step 4.2 — Project-run dispatch path

**What:** add a project-scope `dispatchProjectRunUnit` invoked event-driven from the coordinator (Step 4.3) and from the recovery service (rehydrate orphaned sessions on boot). Routes through `RuntimePort.dispatchRun(...)` the same way feature-phase runs go today, but skips any feature-worktree provisioning and any feature-graph readiness check. **Does not** integrate with `prioritizeReadyWork` — project runs are not in the graph and are not scheduler-tick-driven (see Background "Dispatch model").

**Files:**

- `src/runtime/contracts.ts` — extend `RunScope` with `{ kind: 'project' }`. The arm carries no scope-id beyond the singleton; the run id rides on `RuntimeDispatch.agentRunId` (existing pattern), **not** on `RunScope`. This matches the today-existing `task` and `feature_phase` arms which also don't carry the run id in `RunScope`.
- `src/runtime/worker-pool.ts` — extend the dispatch typing with the `'project'` arm. Specifically: `LocalWorkerPool.dispatchRun` and any internal `switch (scope.kind)` site must handle `'project'`. Use TypeScript's exhaustiveness check (`assertNever`) to flag any remaining sites at compile time.
- `src/orchestrator/scheduler/dispatch.ts` — add `dispatchProjectRunUnit`. No worktree provisioning, no graph-readiness gate. `RuntimePort.dispatchRun({ kind: 'project' }, dispatch, payload)` — the run id rides on `dispatch.agentRunId` (existing shape). Exported for invocation from the coordinator (Step 4.3) and recovery service (Step 4.3).
- `src/runtime/harness/project-planner/index.ts` (new) — harness backend for project-scope dispatch. Reuse the existing proposal-phase session handle pattern; only difference is the agent helper called and the absence of a feature worktree.
- `src/orchestrator/scheduler/events.ts` — extend the existing `feature_phase_*` event handlers' analogues for project scope, or generalize event names to `agent_run_*` if cleaner. Decide based on how much shared shape exists; document the choice in the commit message. **No `prioritizeReadyWork` change** — project runs do not flow through the tick collector.
- `test/unit/orchestrator/scheduler-dispatch.test.ts` (or sibling) — coverage that `dispatchProjectRunUnit` skips worktree provisioning and routes through `RuntimePort.dispatchRun({ kind: 'project', runId })`.

**Tests:**

- `dispatchProjectRunUnit` invocation: no call to `ports.worktree.ensureFeatureWorktree` or `ensureFeatureBranch`; one call to `RuntimePort.dispatchRun({ kind: 'project' }, dispatch, payload)` with the run id on `dispatch.agentRunId`.
- `prioritizeReadyWork` does not return any `project_run` entries (existing test scope: confirm `SchedulableUnit` enumeration is unchanged from `task | feature_phase`).
- Existing feature-phase and task dispatch tests stay green. (Note: `test/unit/orchestrator/scheduler-loop.test.ts` is shared with Phase 1's `failed`-filter regression — Phase 4 must not break that test.)

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify project dispatch: (1) `RunScope` and `RuntimePort.dispatchRun` typings accept the project arm; (2) `dispatchProjectRunUnit` is invoked event-driven from coordinator/recovery, not from `prioritizeReadyWork`; (3) `SchedulableUnit` is unchanged from `task | feature_phase` — no `project_run` arm added; (4) no feature-worktree provisioning is triggered; (5) feature-phase and task dispatch behavior is byte-for-byte unchanged; (6) the architecture boundary holds — `core/scheduling/` still imports nothing from `runtime/` or `persistence/`. Under 350 words.

**Commit:** `feat(scheduler/dispatch): project-run dispatch path (event-driven)`

---

### Step 4.3 — Session lifecycle: create, resume, cancel + recovery rehydrate

**What:** orchestrator surface for managing project-planner sessions. `ProjectPlannerCoordinator` exposes:

- `startProjectPlannerSession(): Promise<string>` — creates a new `agent_runs` row with `scope_type='project'`, `scope_id=ProjectScopeId` (singleton const exported from Phase 2's `src/core/types/runs.ts`), `runStatus='running'`, then immediately invokes `dispatchProjectRunUnit(runId)` from Step 4.2. Returns the new session uid (the `agent_runs.id` column). No new `'ready'` status is introduced; the existing `AgentRunStatus` union is unchanged. (Rationale: project runs are event-driven; "exists in the row but not yet dispatched" is not a state we need.)
- `resumeProjectPlannerSession(id): Promise<void>` — re-dispatches an existing session via `dispatchProjectRunUnit(id)`. If `runStatus='await_approval'` or `'await_response'`, this is a no-op; the approval/help handler drives state.
- `cancelProjectPlannerSession(id): Promise<void>` — moves the run to `cancelled`, evicts any in-flight worker, leaves the proposal draft discarded.
- **Recovery rehydrate.** On orchestrator boot, the recovery service (`src/orchestrator/services/recovery-service.ts`, already touched in Phase 2 Step 2.3) queries `Store.listProjectSessions({ status: ['running'] })` and re-invokes `dispatchProjectRunUnit(id)` for each — same shape as today's feature-phase rehydrate.

Conversation/checkpoint persistence reuses the existing per-session file path (`.gvc0/sessions/<sessionId>.json` via `src/runtime/sessions/index.ts`) with `agent_runs.session_id` linking; no new persistence infrastructure.

**Files:**

- `src/orchestrator/services/project-planner-coordinator.ts` (new) — the coordinator surface; calls `dispatchProjectRunUnit` from Step 4.2.
- `src/orchestrator/services/recovery-service.ts` — extend the existing `recoverOrphanedRuns` sweep with a project-arm rehydrate that calls `dispatchProjectRunUnit` for `runStatus='running'` project rows. (Phase 2 Step 2.3 added an exhaustive branch with a "Phase 4 wires this" placeholder; Phase 4 fills it in.)
- `src/compose.ts` — wire the coordinator into the composition root alongside the existing `FeatureLifecycleCoordinator`.
- `src/orchestrator/ports/index.ts` — if the coordinator needs new ports beyond Phase 2's Store helpers, extend here. Aim for none new.
- `test/unit/orchestrator/project-planner.test.ts` (new) — coverage for create / resume / cancel state transitions.
- `test/unit/orchestrator/recovery-service.test.ts` — extend with a project-rehydrate fixture.

**Tests:**

- Create writes an `agent_runs` row with `scope_type='project'`, `scope_id=ProjectScopeId`, `runStatus='running'`, and triggers exactly one `dispatchProjectRunUnit` call.
- Resume on a `running` session re-dispatches (worker may have died); resume on `await_approval` / `await_response` is a no-op.
- Resume on a `cancelled` session rejects with a clear error.
- Cancel from any non-terminal state moves to `cancelled` and dispatches no further work.
- Recovery service on boot finds `running` project rows and re-invokes dispatch.
- Conversation persistence: per-session file is created at `.gvc0/sessions/<sessionId>.json`.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify session lifecycle: (1) coordinator exposes create / resume / cancel; (2) state transitions are correct and idempotent where appropriate; (3) conversation history is keyed on run id; (4) no leakage of feature-coordinator state into project sessions. Under 300 words.

**Commit:** `feat(orchestrator/project-planner): session coordinator`

---

### Step 4.4 — Approval and apply path for project proposals

**What:** when a project-planner session calls `submit`, the run enters `await_approval`. On approval, the proposal applies to the authoritative graph via the existing proposal-application pipeline (today: `src/orchestrator/scheduler/events.ts` → `approveFeatureProposal` in `src/orchestrator/proposals/index.ts` → `applyGraphProposal` in `src/core/proposals/index.ts`). That path already does per-op stale/validation checks and skips bad ops, but it is **not** CAS-style baseline validation: it does not reject the whole apply with a typed rebase reason or reopen the session when individual ops fail. Step 4.4 adds that mode.

**Baseline mechanism: graph snapshot version.** Add a monotonic `graphVersion: number` field on the persistent feature graph (incremented exactly once per applied proposal — feature-scope and project-scope alike). At proposal-build time, the proposal records the `graphVersion` it was constructed against. At apply time, the path compares the current `graphVersion` to the recorded one; if they differ, the apply is rejected as a whole with `ProposalRebaseReason` of kind `stale-baseline` and the session re-opens against the new snapshot. Per-op stale-skip behavior for **feature-scope** proposals is preserved — Step 4.4 adds the CAS mode only on the project-scope path. Storage: extend the existing graph metadata row in `.gvc0/state.db` (or wherever the persistent graph lives — confirm at Step 4.4 implementation).

**Files:**

- `src/orchestrator/proposals/index.ts` — extend the apply path to handle project-scope proposals. Project proposals can include topology mutations that feature-scope proposals cannot. Reuse the existing op-replay shape; add a baseline-CAS check that compares recorded `graphVersion` to current. Define and export a typed `ProposalRebaseReason` (e.g. `{ kind: 'stale-baseline' | 'running-tasks-affected', details: ... }`) from this file — Phase 6 Step 6.4 consumes this shape to render the operator-facing system message.
- `src/core/graph/types.ts` — add `graphVersion: number` to the persistent graph metadata. Bump in the existing `applyGraphProposal` success path so feature-scope applies also advance the version (project-scope CAS sees feature-scope applies as a stale baseline).
- `src/orchestrator/proposals/running-tasks-affected.ts` (new) — shared helper that detects whether a proposal's removed/edited features have running task or feature-phase runs. Used by both Phase 4's apply-time check (rejects with `running-tasks-affected`) and Phase 6's TUI pre-flight (renders cancel-approval block before the operator hits approve). Single source of truth — avoid drift.
- `src/orchestrator/scheduler/events.ts` — extend the approval-decision handler to route to project-scope apply when the run is project-scope.
- `src/runtime/harness/project-planner/index.ts` — handle the rebase signal: re-open the agent with a refreshed snapshot, drop the rejected proposal, attach the typed `ProposalRebaseReason` to the session payload so the TUI surface (Phase 6) can render it.
- `test/integration/project-planner-flow.test.ts` (new) — integration coverage for an end-to-end project-planner session with faux model. Project-flow integration tests do not naturally fit into `feature-phase-agent-flow.test.ts`; add a dedicated file.
- `test/unit/orchestrator/proposals/project-apply.test.ts` (new) — unit coverage for the CAS gate and rebase-reason shape.

**Tests:**

- Approved project proposal applies all ops to the authoritative graph and advances `graphVersion`.
- Apply against a stale baseline (graph `graphVersion` advanced between propose and apply) rejects the whole apply with a typed `ProposalRebaseReason` of kind `stale-baseline`; session re-opens against the new baseline.
- Feature-scope apply also bumps `graphVersion` so a subsequent project apply against the now-stale baseline is correctly rejected.
- Apply with running tasks affected by topology change rejects with `ProposalRebaseReason` of kind `running-tasks-affected`; the apply itself does not silently kill running work. Phase 4 enforces the rejection and exports the reason shape; Phase 6 Step 6.4 renders the cancellation-approval UX that operators use to escalate.
- Approved feature-scope proposals continue to apply through the existing path unchanged (per-op stale-skip behavior preserved).

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify project apply: (1) approved project proposals apply via the existing op-replay pipeline plus CAS checks; (2) stale apply rejects with a structured reason and re-opens the session; (3) topology change against running tasks is rejected (not silently applied) until explicit cancel approval; (4) feature-scope apply path is unchanged; (5) no recursive locking against the project session itself during apply. Under 400 words.

**Commit:** `feat(orchestrator/proposals): project proposal approval and apply path`

---

## Phase exit criteria

- All four commits land in order.
- `npm run verify` passes.
- A project-planner session can be started, dispatched, observed reaching `await_approval` after `submit`, approved, and applied.
- A stale apply rejects cleanly and re-opens the session.
- No production code path actually creates a project-scope run yet — that lands in Phase 5 (bootstrap auto-spawn) and Phase 6 (TUI mode).
- Run a final review subagent across all four commits to confirm dispatch, lifecycle, and apply paths are coherent and the feature-phase paths are untouched.

## Notes

- **Re-using infrastructure.** The proposal-host, submit/await_approval shape, and per-session file persistence are reused as-is. The new code is roughly: agent helper, prompt scaffold, milestone-reassignment patch field, dispatch helper, harness backend, coordinator, apply CAS arm, recovery rehydrate.
- **Failed runs.** Project runs share the same `failed`-not-redispatched discipline. Because project runs are event-driven (not collected by `prioritizeReadyWork`), Phase 1's filter does not apply directly — instead, the coordinator and recovery service must skip dispatch for `runStatus='failed'` rows. Add explicit coverage for that.
- **Concurrent sessions.** No lock at run start. Two sessions may apply in parallel; the second's CAS validation handles the rebase. See [docs/concerns/concurrent-project-planner-sessions.md](../../concerns/concurrent-project-planner-sessions.md).
- **Worktree audit.** Confirm the new dispatch path agrees that project runs do not need a feature worktree at any step. Add an assertion or test that explicitly fails if `ensureFeatureWorktree` is called during a project run.
- **Session uid terminology.** The `agent_runs.id` column is the per-session uid throughout this track. Helpers return it as a `string` (no dedicated `ProjectRunId` brand); the `session_id` column links to the per-session file path. Earlier drafts of this doc called it `ProjectRunId` — that name has been retired. Phase 5 and Phase 6 docs refer to it as `sessionId`; treat the names as interchangeable when reading older sweep entries.
- **Phase ordering.** Phase 4 hard-depends on Phase 2 (`scope_type='project'`, codec branches, `Store.listProjectSessions(...)`) and Phase 3 (`projectPlannerTools`, `editFeatureSpec`). The milestone-reassignment patch field on `PlannerFeatureEditPatch` is owned by Phase 4 Step 4.1, not Phase 3 — Phase 3 leaves the rejection assertion deferred. Phases 2 and 3 are independent of each other and can ship in either order before Phase 4.
