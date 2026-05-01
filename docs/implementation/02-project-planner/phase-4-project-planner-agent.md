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

**Approach:** TDD for the deterministic slice (helper construction + milestone-reassignment patch routing); prompt content tuning is not test-first and lands as a non-TDD addendum.

**What:** add `startProjectPlannerSession` (or analogous helper) to `src/agents/runtime.ts` that constructs an `Agent` with `projectPlannerTools` and the project-planner system prompt. The agent is created against a `proposalToolHost` whose draft graph is the current authoritative graph snapshot. The session is keyed on a project run id.

**Test (write first, expect red):**

- `test/unit/agents/runtime.test.ts` — assert the helper returns an agent whose tool list matches the `createProjectPlannerToolset` catalog and whose prompt is `'project-planner'`. RED (helper does not exist).
- Same file — assert the helper rejects construction when the agent_run row has a non-project `scope_type`. RED.
- `test/unit/agents/tools/proposal-host.test.ts` (or sibling) — assert a milestone-reassignment patch via the **full `editFeature`** surface routes through `applyGraphProposal` and lands as a `changeMilestone(...)` mutation. RED (`milestoneId` not yet on `PlannerFeatureEditPatch`).
- Same file — assert the **subset `editFeatureSpec`** still rejects `{ milestoneId }` patches even after the patch-extension lands (deferred from Phase 3 Step 3.1, now landable). The two surfaces stay distinct: full `editFeature` accepts milestone reassignment (project scope only); `editFeatureSpec` is a runtime-validated spec-only subset that rejects rename / milestoneId regardless of the underlying patch shape. RED.
- Confirm existing `startPlanFeature` / `startReplanFeature` tests still pass — these stay green throughout.

**Implementation (drive to GREEN):**

- `src/agents/runtime.ts` — add the helper. Reuse the existing proposal-host construction pattern. The agent receives the project-planner prompt and the project-planner toolset (via `createProjectPlannerToolset(host)` from Phase 3).
- `src/agents/prompts/index.ts` — register the new prompt file. **Extend** the `PromptTemplateName` union (`:7-13`) with `'project-planner'`; add the corresponding registry entry.
- **Milestone-reassignment patch.** Pin the patch-extension route: extend `PlannerFeatureEditPatch` (`src/core/graph/types.ts:65-75`) with `milestoneId?: MilestoneId`. The full `editFeature` surface accepts it; `editFeatureSpec` keeps its existing runtime guard that rejects rename / milestoneId. Step 4.1 owns this so the project-planner toolset has full topology authority on first dispatch (Step 4.2). The graph-level `changeMilestone(...)` already exists; this just exposes it through the proposal layer. (No sibling `moveFeatureToMilestone` tool — the patch route stays uniform.)

**Non-TDD addendum:**

- `src/agents/prompts/project-planner.ts` (new) — prompt scaffold; minimal at this phase. Final wording lands in Phase 8. (Live prompt source is `.ts` under `src/agents/prompts/`; `docs/agent-prompts/project-planner.md` is the doc mirror, not the live source.)

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify project agent construction: (1) helper exists in `src/agents/runtime.ts`; (2) toolset is `projectPlannerTools`; (3) prompt file is loaded; (4) feature-scope helpers are not affected; (5) `PlannerFeatureEditPatch` carries the new `milestoneId` field and milestone-reassignment via the **full `editFeature`** surface routes through `applyGraphProposal` to the existing `changeMilestone(...)` graph mutation; (6) the **subset `editFeatureSpec`** still rejects `{ milestoneId }` patches. Under 300 words.

**Commit:** `feat(agents/project-planner): agent construction`

---

### Step 4.2 — Project-run dispatch path

**Approach:** TDD (test-first).

**What:** add a project-scope `dispatchProjectRunUnit` invoked event-driven from the coordinator (Step 4.3) and from the recovery service (rehydrate orphaned sessions on boot). Routes through `RuntimePort.dispatchRun(...)` the same way feature-phase runs go today, but skips any feature-worktree provisioning and any feature-graph readiness check. **Does not** integrate with `prioritizeReadyWork` — project runs are not in the graph and are not scheduler-tick-driven (see Background "Dispatch model").

**Test (write first, expect red):**

- `test/unit/orchestrator/scheduler-dispatch.test.ts` (or sibling) — write test asserting `dispatchProjectRunUnit` calls `RuntimePort.dispatchRun({ kind: 'project' }, dispatch, payload)` with the run id on `dispatch.agentRunId`, and **never** invokes `ports.worktree.ensureFeatureWorktree` or `ensureFeatureBranch`. **Compile-RED** initially (`dispatchProjectRunUnit` does not exist; `RunScope` has no project arm); transitions to assertion-RED once the type lands and only behavior remains to verify.
- Same file — assert `prioritizeReadyWork` does not return any `project_run` entries; `SchedulableUnit` enumeration stays `task | feature_phase`. RED until typing locks down (or already passing — this is a regression guard).
- Confirm existing feature-phase and task dispatch tests stay green. (Note: `test/unit/orchestrator/scheduler-loop.test.ts` is shared with Phase 1's `failed`-filter regression — Phase 4 must not break that test.)

**Implementation (drive to GREEN):**

- `src/runtime/contracts.ts` — extend `RunScope` with `{ kind: 'project' }`. The arm carries no scope-id beyond the singleton; the run id rides on `RuntimeDispatch.agentRunId` (existing pattern), **not** on `RunScope`. This matches the today-existing `task` and `feature_phase` arms.
- `src/runtime/worker-pool.ts` — extend the dispatch typing with the `'project'` arm. `LocalWorkerPool.dispatchRun` and any internal `switch (scope.kind)` site must handle `'project'`. Use TypeScript's exhaustiveness check (`assertNever`) to flag remaining sites at compile time.
- `src/orchestrator/scheduler/dispatch.ts` — add `dispatchProjectRunUnit`. No worktree provisioning, no graph-readiness gate. Exported for invocation from the coordinator (Step 4.3) and recovery service (Step 4.3).
- `src/runtime/harness/project-planner/index.ts` (new) — harness backend; reuse the proposal-phase session handle pattern; only difference is the agent helper called and the absence of a feature worktree.
- `src/orchestrator/scheduler/events.ts` — extend `feature_phase_*` analogues for project scope, or generalize event names to `agent_run_*`. Document the choice in the commit message. **No `prioritizeReadyWork` change.**

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify project dispatch: (1) `RunScope` and `RuntimePort.dispatchRun` typings accept the project arm; (2) `dispatchProjectRunUnit` is invoked event-driven from coordinator/recovery, not from `prioritizeReadyWork`; (3) `SchedulableUnit` is unchanged from `task | feature_phase` — no `project_run` arm added; (4) no feature-worktree provisioning is triggered; (5) feature-phase and task dispatch behavior is byte-for-byte unchanged; (6) the architecture boundary holds — `core/scheduling/` still imports nothing from `runtime/` or `persistence/`. Under 350 words.

**Commit:** `feat(scheduler/dispatch): project-run dispatch path (event-driven)`

---

### Step 4.3 — Session lifecycle: create, resume, cancel + recovery rehydrate

**Approach:** TDD (test-first).

**What:** orchestrator surface for managing project-planner sessions. `ProjectPlannerCoordinator` exposes:

- `startProjectPlannerSession(): Promise<string>` — creates a new `agent_runs` row with `scope_type='project'`, `scope_id=ProjectScopeId` (singleton const from Phase 2's `src/core/types/runs.ts`), `runStatus='running'`, then immediately invokes `dispatchProjectRunUnit(runId)` from Step 4.2. Returns the `agent_runs.id`. No new `'ready'` status is introduced; the existing `AgentRunStatus` union is unchanged.
- `resumeProjectPlannerSession(id): Promise<void>` — re-dispatches an existing session via `dispatchProjectRunUnit(id)`. If `runStatus='await_approval'` or `'await_response'`, this is a no-op.
- `cancelProjectPlannerSession(id): Promise<void>` — moves the run to `cancelled`, evicts any in-flight worker, leaves the proposal draft discarded.
- **Recovery rehydrate.** On boot, the recovery service queries `Store.listProjectSessions({ status: ['running'] })` and re-invokes `dispatchProjectRunUnit(id)` for each.

Conversation/checkpoint persistence reuses the existing per-session file path (`.gvc0/sessions/<sessionId>.json` via `src/runtime/sessions/index.ts`) with `agent_runs.session_id` linking; no new persistence infrastructure.

**Test (write first, expect red):**

- `test/unit/orchestrator/project-planner.test.ts` (new) — assert `startProjectPlannerSession` writes a row with `scope_type='project'`, `scope_id=ProjectScopeId`, `runStatus='running'`, and triggers exactly one `dispatchProjectRunUnit` call. RED (coordinator does not exist).
- Same file — assert `resumeProjectPlannerSession` re-dispatches a `running` row, no-ops on `await_approval` / `await_response`, rejects on `cancelled` **and on `failed`** (Phase 1's failed-filter applies to project runs too — failed sessions need an explicit operator action, not silent re-dispatch). RED.
- Same file — assert `cancelProjectPlannerSession` moves any non-terminal state to `cancelled` and dispatches no further work. RED.
- Same file — assert per-session file is created at `.gvc0/sessions/<sessionId>.json`. RED.
- `test/unit/orchestrator/recovery-service.test.ts` — extend with a project-rehydrate fixture: boot finds `running` project rows and re-invokes `dispatchProjectRunUnit`; **also assert `failed` and `cancelled` project rows are NOT re-dispatched** (parity with feature-phase recovery semantics). RED (Phase 2 left a placeholder branch).

**Implementation (drive to GREEN):**

- `src/orchestrator/services/project-planner-coordinator.ts` (new) — coordinator surface; calls `dispatchProjectRunUnit` from Step 4.2.
- `src/orchestrator/services/recovery-service.ts` — extend `recoverOrphanedRuns` with the project-arm rehydrate (fills Phase 2's "Phase 4 wires this" placeholder).
- `src/compose.ts` — wire the coordinator into the composition root alongside `FeatureLifecycleCoordinator`.
- `src/orchestrator/ports/index.ts` — extend only if new ports are required beyond Phase 2's Store helpers. Aim for none new.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify session lifecycle: (1) coordinator exposes create / resume / cancel; (2) state transitions are correct and idempotent where appropriate, including resume rejecting on `failed` and `cancelled`; (3) conversation history is keyed on run id; (4) no leakage of feature-coordinator state into project sessions; (5) boot-time recovery rehydrates only `running` project rows — `failed` and `cancelled` rows are skipped (parity with feature-phase recovery). Under 300 words.

**Commit:** `feat(orchestrator/project-planner): session coordinator`

---

### Step 4.4 — Approval and apply path for project proposals

**Approach:** TDD for the deterministic slice (CAS gate, `graphVersion` bump, `ProposalRebaseReason` shape, running-tasks-affected helper); the full faux-agent reopen flow is integration-heavy and lands as a non-TDD addendum.

**What:** when a project-planner session calls `submit`, the run enters `await_approval`. On approval, the proposal applies via the existing pipeline (`src/orchestrator/scheduler/events.ts` → `approveFeatureProposal` → `applyGraphProposal`). That path does per-op stale/validation checks and skips bad ops, but it is **not** CAS-style baseline validation. Step 4.4 adds that mode for project-scope only.

**Baseline mechanism: graph snapshot version.** Add a monotonic `graphVersion: number` on the persistent feature graph, incremented exactly once per applied proposal (feature-scope and project-scope alike). The proposal records the `graphVersion` it was built against by **persisting it in `agent_runs.payload_json`** at submit time (the row already carries proposal context for `await_approval`; this adds one numeric field — `payload.baselineGraphVersion`). Apply reads it back from the row at approval time, compares to current, and rejects as a whole with `ProposalRebaseReason` of kind `stale-baseline` if it advanced. The baseline thus survives `await_approval` and orchestrator restart (recovery rehydrates the row, the field rides along). Per-op stale-skip behavior for feature-scope proposals is preserved.

**Test (write first, expect red):**

- `test/unit/orchestrator/proposals/project-apply.test.ts` (new) — assert an approved project proposal applies all ops and advances `graphVersion` by exactly one. RED.
- Same file — assert apply against a stale baseline rejects the whole apply with `ProposalRebaseReason` of kind `stale-baseline` (no partial application). RED.
- Same file — assert a feature-scope apply between propose and apply also bumps `graphVersion`, so the project apply correctly sees a stale baseline. RED.
- Same file — assert a project apply that touches a feature with running task or feature-phase runs rejects with `ProposalRebaseReason` of kind `running-tasks-affected`; running work is not silently killed. RED.
- Same file — assert approved feature-scope proposals continue to apply through the existing path unchanged (per-op stale-skip preserved). Regression guard.

**Implementation (drive to GREEN):**

- `src/core/graph/types.ts` — add `graphVersion: number` to the persistent graph metadata; bump in the existing `applyGraphProposal` success path.
- `src/agents/runtime.ts` (project-planner submit path) — capture the current `graphVersion` at submit time and persist it to `agent_runs.payload_json` alongside the proposal as `payload.baselineGraphVersion`.
- `src/orchestrator/proposals/index.ts` — extend the apply path for project-scope. Read `baselineGraphVersion` from the run's `payload_json`, compare to the live `graphVersion`, reject as a whole if mismatched. Define and export `ProposalRebaseReason` (e.g. `{ kind: 'stale-baseline' | 'running-tasks-affected', details: ... }`) — Phase 6 Step 6.4 consumes this shape.
- `src/orchestrator/proposals/running-tasks-affected.ts` (new) — shared helper detecting whether a proposal's removed/edited features have running runs. Single source of truth, also consumed by Phase 6's TUI pre-flight.
- `src/orchestrator/scheduler/events.ts` — route the approval-decision handler to project-scope apply when the run is project-scope.

**Non-TDD addendum:**

- `src/runtime/harness/project-planner/index.ts` — handle the rebase signal: re-open the agent with a refreshed snapshot, drop the rejected proposal, attach the typed `ProposalRebaseReason` to the session payload for the TUI (Phase 6).
- `test/integration/project-planner-flow.test.ts` (new) — end-to-end faux-model coverage for the reopen flow. Added after the unit slice is GREEN.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify project apply: (1) approved project proposals apply via the existing op-replay pipeline plus CAS checks; (2) stale apply rejects with a structured reason and re-opens the session; (3) topology change against running tasks is rejected (not silently applied) until explicit cancel approval; (4) feature-scope apply path is unchanged **except for the shared `graphVersion` bump** — per-op stale-skip semantics preserved, but every successful apply (feature- or project-scope) advances the version exactly once; (5) no recursive locking against the project session itself during apply; (6) the proposal's recorded baseline is read from `agent_runs.payload_json.baselineGraphVersion` at apply time and survives orchestrator restart via the existing recovery sweep. Under 400 words.

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
