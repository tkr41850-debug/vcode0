# Phase 8 — Planning dispatch & feature-branch bootstrap

## Goal

Fix first-run orchestration so `/init` followed by `/auto` enters normal planning approval flow instead of bouncing the first feature into `retry_await`. At the same time, make `branch_open` truthful again: when a feature transitions into execution, its git feature branch must already exist.

This phase is a TDD bug fix with one lifecycle correction attached. Do not expand it into worktree cleanup, merge-train changes, or planner prompt redesign.

## Scope

**In:** gate `ensureFeatureWorktree` in `dispatch.ts` so `discuss | research | plan | replan` phases skip provisioning; `ensureFeatureBranch(feature)` on `WorktreeProvisioner` interface; explicit `ensureFeatureBranch` call before `branch_open` collab transition; updating the 6 `WorktreeProvisioner` test-double sites with the new method.

**Out:** worktree disposal (Phase 4); harness `verify`/`summarize` worktree requirements (current implementation reads graph/store/projectRoot, not feature path); planner prompt redesign; merge-train changes; new `FeatureLifecycleCoordinator` surface beyond wiring `ensureFeatureBranch` at `approveFeatureProposal`.

## Background

Verified gaps on `main`:

- `/init` seeds the first feature directly into `planning` in `src/compose.ts:560-610`. It creates milestone/feature graph state only; no git branch or worktree is created there.
- Scheduler maps `planning -> plan` in `src/core/scheduling/index.ts:128-150` and treats the feature as dispatchable ready work through `prioritizeReadyWork(...)` (`src/core/scheduling/index.ts:457-474`).
- `dispatchFeaturePhaseUnit(...)` in `src/orchestrator/scheduler/dispatch.ts:474-545` unconditionally calls `ports.worktree.ensureFeatureWorktree(feature)` at `:493` before every feature phase.
- That unconditional worktree provisioning is wrong for pre-execution phases:
  - `plan`/`replan` use proposal + inspection hosts (`src/agents/tools/agent-toolset.ts:182-212`), not a feature worktree.
  - `research` repo inspection uses `projectRoot` directly via `buildRepoInspectionTools(projectRoot)` (`src/agents/tools/agent-toolset.ts:136-144,214-223`), not the feature worktree.
  - `discuss` also runs entirely from graph/store context.
- `GitWorktreeProvisioner.ensureFeatureWorktree(...)` in `src/runtime/worktree/index.ts:19-25` assumes the feature branch already exists and opens the worktree with `git worktree add <target> <branch>` via `ensureWorktree(...)` (`:35-60`). It does **not** create the feature branch.
- Feature creation only persists branch metadata: `createFeature(...)` in `src/core/graph/creation.ts:48-130` sets `feature.featureBranch = featureBranchName(...)` at `:117`, but does not create the git ref.
- When first `plan` dispatch hits the missing-branch path, `dispatchFeaturePhaseUnit(...)` catches the thrown error and emits `feature_phase_error` (`src/orchestrator/scheduler/dispatch.ts:537-543`), and `handleSchedulerEvent(...)` converts that into `retry_await` in `src/orchestrator/scheduler/events.ts:439-455`.
- There is a second, latent lifecycle mismatch after that immediate bug: approved `plan`/`replan` transitions the feature to `executing/branch_open` in `src/orchestrator/proposals/index.ts:184-205`, but no production path creates the feature branch before that transition.
- Repo docs/specs explicitly say `branch_open` means the feature branch/worktree exist, and that the feature branch is created when execution begins:
  - `docs/architecture/data-model.md:62-66,381-383`
  - `docs/architecture/worker-model.md:37-45,91-108`
  - `specs/test_feature_branch_lifecycle.md:9-20`
- `FeatureLifecycleCoordinator.openBranch(...)` exists in `src/orchestrator/features/index.ts:18-24`, but has no callsites and only flips graph state; it does not solve git bootstrap.
- Existing tests encode the current gap:
  - `test/unit/runtime/worktree.test.ts:51-138` pre-creates the feature branch before `ensureFeatureWorktree(...)` and currently expects missing branch to fail.
  - `test/unit/orchestrator/scheduler-loop.test.ts:2403-2423` already covers failed feature-phase dispatch going through `feature_phase_error`.
  - `test/unit/orchestrator/scheduler-loop.test.ts:2463-2539` already covers approved `plan` moving the feature to `executing/pending/branch_open`, but does not yet assert a real branch bootstrap side effect.

## Steps

Ships as **2 commits**, in order. First commit fixes the user-visible regression in a narrow way. Second commit restores the documented `branch_open` lifecycle invariant.

---

### Step 8.1 — Stop provisioning feature worktrees for pre-execution feature phases

**What:** gate `ensureFeatureWorktree(...)` by feature phase inside `dispatchFeaturePhaseUnit(...)`. `discuss`, `research`, `plan`, and `replan` should dispatch without requiring a feature worktree. Keep feature-worktree provisioning for phases that need or will need it (`verify`, `ci_check`, `summarize`), and leave `execute` unchanged. **Note on the `verify`/`summarize` side**: today the agent tool wiring for these phases uses graph/store/`projectRoot` context, not the feature worktree path itself — `ci_check` is the only phase whose underlying `ports.verification.verifyFeature` clearly needs the feature branch checked out. Keeping `verify` and `summarize` on the "needs worktree" side is intentional forward-compat (these phases will likely gain worktree-bound tools as feature verification matures); it is conservative, not strictly required by current code.

This is the immediate `/init` + `/auto` fix. It should make the first feature enter planning approval flow instead of `retry_await`.

**Files:**

- `src/orchestrator/scheduler/dispatch.ts` — add a small local helper/predicate for “phase requires feature worktree” and gate the existing `ensureFeatureWorktree(...)` call in `dispatchFeaturePhaseUnit(...)`.
- `test/unit/orchestrator/scheduler-loop.test.ts` — add a regression test on the planning dispatch path proving `plan` dispatch does **not** touch `ensureFeatureWorktree(...)` and does **not** fall into `feature_phase_error` / `retry_await` when runtime dispatch itself succeeds.
- `test/integration/feature-phase-agent-flow.test.ts` — extend only if needed to add an integration-level `/init`-style planning-flow assertion; keep this light if the unit regression already proves the gating behavior.
- Any test fixtures that stub `WorktreeProvisioner` will likely need small type-surface updates later in Step 8.2; do not broaden those changes in this step unless the compiler requires it.

**Tests:**

- In `test/unit/orchestrator/scheduler-loop.test.ts`, create a planning feature fixture (`workControl: 'planning'`, `collabControl: 'none'`), make `ports.worktree.ensureFeatureWorktree` a spy/mock that would fail if called, configure plan runtime dispatch to succeed into `await_approval`, run one scheduler step, and assert:
  - `ensureFeatureWorktree(...)` was not called for `plan`
  - runtime `dispatchRun(...)` was called for `{ kind: 'feature_phase', phase: 'plan' }`
  - resulting plan run reaches `await_approval`
  - no `feature_phase_error` / `retry_await` path was taken
- Re-run the existing failure-path regression near `test/unit/orchestrator/scheduler-loop.test.ts:2403-2423` to ensure true runtime failures still become `feature_phase_error`.
- Keep existing approved-plan coverage (`:2463-2539`) green; this step should not change approval semantics.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the planning-dispatch fix: (1) `src/orchestrator/scheduler/dispatch.ts` no longer provisions a feature worktree for `discuss|research|plan|replan`; (2) `verify|ci_check|summarize` still require it; (3) the new regression test proves a planning feature can reach `await_approval` without `ensureFeatureWorktree(...)`; (4) true dispatch failures still flow through `feature_phase_error` and `retry_await`. Under 300 words.

**Commit:** `fix(scheduler): skip feature worktree for planning phases`

---

### Step 8.2 — Bootstrap feature branch before `executing/branch_open`

**What:** make feature-branch creation an explicit production behavior before the graph claims `branch_open`. Reuse the existing worktree layer rather than adding a new subsystem:

- extend `WorktreeProvisioner` with `ensureFeatureBranch(feature)`
- implement it in `GitWorktreeProvisioner`
- make approval flow call it before advancing the feature to `executing/branch_open`
- keep feature worktree checkout lazy; only the branch creation is eager

This restores the documented invariant that `branch_open` means a real feature branch exists.

**Files:**

- `src/runtime/worktree/index.ts` — extend `WorktreeProvisioner` with `ensureFeatureBranch(feature): Promise<void>`. In `GitWorktreeProvisioner`, implement branch bootstrap as: if `refs/heads/<featureBranch>` already exists, no-op; otherwise create it from current `main`. Then make `ensureFeatureWorktree(feature)` call `ensureFeatureBranch(feature)` before `ensureWorktree(...)`. Preserve the current idempotent race fallback in `ensureWorktree(...)`.
- `src/orchestrator/proposals/index.ts` — refactor `approveFeatureProposal(...)` so it no longer unconditionally flips the feature into `executing/branch_open` internally. Keep pure graph responsibilities here: apply proposal ops, restore replanned stuck tasks, promote root tasks to `ready`, report cancellation, and report whether execution should advance. Extract or expose the execution-advance step so the caller can do it only after branch bootstrap succeeds.
- `src/orchestrator/scheduler/events.ts` — in `feature_phase_approval_decision` approved path, after proposal application succeeds and if the feature should advance, call `ports.worktree.ensureFeatureBranch(feature)` first, then transition the feature to `executing/branch_open`. Keep this inside the existing `try` so branch-bootstrap failure reuses the current `proposal_apply_failed` recovery path instead of leaving a false logical state behind.
- `test/unit/runtime/worktree.test.ts` — replace the current missing-feature-branch failure expectation (`:130-138`) with branch-bootstrap coverage. Add tests that prove:
  - `ensureFeatureBranch(feature)` creates a missing feature branch from current `main`
  - repeated calls are idempotent
  - `ensureFeatureWorktree(feature)` succeeds even if the feature branch was not pre-created because it bootstraps first
  - task worktree creation still branches from feature-branch HEAD
- `test/unit/orchestrator/scheduler-loop.test.ts` — extend approved-plan/replan coverage to assert:
  - approved `plan` calls `ensureFeatureBranch(feature)` before the feature becomes `executing/branch_open`
  - approved `replan` remains idempotent if the branch already exists
  - branch-bootstrap failure during approval yields `proposal_apply_failed` and leaves the feature in `planning`/`replanning`, not `executing/branch_open`
- `test/unit/orchestrator/proposals/approve.test.ts` — update only if helper semantics change. Keep graph-only assertions here; bootstrap ordering belongs at scheduler-event level.
- Any test doubles that implement `WorktreeProvisioner` will need the new `ensureFeatureBranch(...)` stub added. Verified stub sites include:
  - `test/unit/orchestrator/scheduler-loop.test.ts:438-439`
  - `test/unit/orchestrator/conflicts.test.ts:35-36`
  - `test/unit/orchestrator/integration-coordinator.test.ts:119-120`
  - `test/unit/orchestrator/integration-reconciler.test.ts:103-104`
  - `test/unit/orchestrator/recovery.test.ts:463-464`
  - `test/integration/feature-phase-agent-flow.test.ts:65-66`

**Tests:**

- In `test/unit/runtime/worktree.test.ts`, assert branch ancestry is based on current `main` tip, matching `specs/test_feature_branch_lifecycle.md:12` and `docs/architecture/worker-model.md:92`.
- In `test/unit/orchestrator/scheduler-loop.test.ts`, extend approved-plan coverage near `:2463-2539` to verify branch bootstrap occurs before `branch_open` is observed.
- Add a failure-path approval regression where `ensureFeatureBranch(...)` throws and the feature stays out of `executing/branch_open` while the run records `proposal_apply_failed`.
- Re-run existing replan/approval tests to ensure task readiness semantics do not drift.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify feature-branch bootstrap: (1) `WorktreeProvisioner` now has an explicit `ensureFeatureBranch(...)` and all test doubles implement it; (2) branch creation is idempotent and based on current `main`; (3) approval flow does not transition to `executing/branch_open` until branch bootstrap succeeds; (4) branch-bootstrap failure becomes `proposal_apply_failed`, not a false `branch_open` state; (5) task worktree creation still branches from feature-branch HEAD. Under 350 words.

**Commit:** `fix(worktree): bootstrap feature branch before branch_open`

---

## Phase exit criteria

- Both commits land in order.
- `npm run verify` passes.
- In a fresh workspace, `/init` followed by `/auto` moves the first feature into normal planning approval flow instead of `retry_await`.
- Approved `plan`/`replan` creates the feature branch before the feature reaches `executing/branch_open`.
- `branch_open` once again corresponds to a real feature branch existing in git.
- Run a final review subagent across both commits to confirm the pre-execution phase gate is narrow, branch bootstrap is explicit and idempotent, and no tests/docs drift remains.

## Notes

- **Scope boundary:** do not pull feature-worktree cleanup / GC into this phase. `docs/implementation/01-baseline/phase-4-recovery.md` already tracks disposal work separately.
- **Keep branch creation eager, worktree checkout lazy.** The docs already describe that split (`docs/architecture/worker-model.md:37-45`). This phase should implement it, not redefine it.
- **Do not touch the 01-baseline README index in this phase.** Add the phase doc only.
- **Reason this ships as two commits:** Step 8.1 is the direct regression fix for current user-visible behavior. Step 8.2 restores the deeper lifecycle invariant and updates the worktree/test surface coherently.
