# Phase 5 — Bootstrap rewrite

Status: drafting
Verified state: as of a5abfeae9b1e59ee53d8c850da7203fdc146521a
Depends on: phase-2-agent-runs-scope (scope_type='project' discriminator), phase-4-project-planner-agent (project session create/dispatch surface)
Default verify: npm run check:fix && npm run check
Phase exit: greenfield `/init` lands on the project-planner bootstrap path; existing-project init remains unchanged
Doc-sweep deferred: docs/reference/tui.md, docs/architecture/data-model.md, docs/implementation/01-baseline/phase-8-planning-branch-bootstrap.md

## Contract

Goal: Replace the synthetic-feature bootstrap path with a real first-run project-planner session. On a greenfield project (no milestones, no features), the compose layer creates empty project state and spawns a project-planner session via the phase-4-project-planner-agent coordinator. phase-6-tui-mode consumes the bootstrap result to auto-enter the session.

Scope:
- In: rewrite `initializeProjectGraph` in `src/compose.ts` to no longer fabricate `m-1`/`f-1`; detect greenfield state and call `ProjectPlannerCoordinator.startProjectPlannerSession`; preserve the existing path for non-greenfield startup (resume existing graph, do not auto-spawn); update the return shape of `initializeProjectGraph` and propagate the new shape through `src/tui/app-deps.ts` and `src/tui/app-composer.ts` (which currently expect `{ milestoneId, featureId }`); update empty-state copy in `src/tui/view-model/index.ts`; update tests and fixtures that depend on the synthetic feature.
- Out: TUI auto-enter wiring proper (`phase-6-tui-mode` — this phase only changes the bootstrap return shape and ensures TUI deps compile against it; the actual auto-enter behavior lands in `phase-6-tui-mode`); approval surfacing for the first-run proposal (`phase-6-tui-mode`); changing the feature workControl FSM or per-feature discuss/research/plan flow.

Exit criteria:
- Both commits land in order.
- `npm run verify` passes.
- On a fresh project root, `/init` followed by `npx tsx src/main.ts` produces empty graph state plus a single project-planner session in `running` (or `ready`).
- On a project root with existing graph state, startup behaves unchanged (no new project session).
- Run a final review subagent across both commits to confirm the synthetic-feature path is fully gone and the new bootstrap surface is covered.

## Plan

### Background

At the header SHA:

- `initializeProjectGraph(graph, input)` in `src/compose.ts` creates `m-1` synthetically, creates `f-1` synthetically, and calls `transitionFeatureToPlanning(f-1)`. Today it returns `{ milestoneId, featureId }`; that shape is consumed by `src/tui/app-deps.ts` (`initializeProject(...)`) and immediately used by `src/tui/app-composer.ts` to select the bootstrap feature.
- `createFeature(...)` in `src/core/graph/creation.ts` starts features in `workControl: 'discussing'`. `transitionFeatureToPlanning(...)` then advances the feature agentlessly through `discussing → done → researching → done → planning`. The feature lands in `workControl: 'planning', status: 'pending'` ready for dispatch.
- This bypasses the agent-driven discuss and research surfaces entirely. With the project-planner architecture, there is no synthetic feature to bypass — graph topology is built by the project planner instead.
- The synthetic state is persisted, not in-memory only: `initializeProjectGraph(...)` mutates a `PersistentFeatureGraph` backed by `.gvc0/state.db`. Once `/init` runs, `m-1` and `f-1` exist on disk. This means greenfield detection cannot be "graph empty in memory" — a second startup of an `/init`-only project sees the persisted synthetic feature and is not greenfield. (See Step 5.1 for the implication: greenfield detection needs to predate the synthetic-feature creation, or the synthetic creation needs to be removed before any other startup ever runs against the new code.)
- `01-baseline/phase-8-planning-branch-bootstrap` (`fix(scheduler): skip feature worktree for planning phases`, commit `245fcf0`) made this synthetic-feature path non-failing for the worktree-provisioning step. The bootstrap rewrite here supersedes the synthetic half of that phase: the worktree gate stays correct, but the synthetic feature itself is no longer created.
- `ProjectPlannerCoordinator` and `Store.listProjectSessions(...)` are introduced by `phase-4-project-planner-agent` / `phase-2-agent-runs-scope`, not present on `main`. This phase has hard dependencies on `phase-4-project-planner-agent` (coordinator) and `phase-2-agent-runs-scope` (store helper).
- Tests that actually depend on the synthetic bootstrap (verified):
  - `test/unit/compose.test.ts` — direct compose-level coverage (closest existing compose test; not `test/unit/app/compose.test.ts`, which does not exist).
  - `test/integration/tui/smoke.test.ts` — assumes initial graph contains `m-1`/`f-1`.
  - `test/unit/tui/app-composer.test.ts` and `test/unit/tui/commands.test.ts` — lighter contract assumptions on the bootstrap return shape.
  - `test/integration/feature-phase-agent-flow.test.ts` already seeds its own explicit `m-1`/`f-1` fixture and does not depend on `initializeProjectGraph`. No migration needed there.

### Notes

- `phase-6-tui-mode` implements TUI auto-enter and consumes the bootstrap result this phase produces. This phase alone does not change TUI behavior; the user will still see whatever default mode the TUI uses.
- Documentation drift. `01-baseline/phase-8-planning-branch-bootstrap` describes the synthetic-feature path. The docs-update sweep handles the rewrite; do not include doc edits in this phase's commits.
- Migration semantics. This is a breaking change to startup behavior. The synthetic feature is persisted to `.gvc0/state.db` once `/init` runs (`PersistentFeatureGraph` writes through). Existing greenfield projects that already ran the old `/init` will boot up with `m-1`/`f-1` already in the store and will be classified as "existing project" by the new bootstrap — they will not auto-spawn a project-planner session. That is the desired migration: users who started under the synthetic-feature regime keep their feature; only truly new projects get the new flow. No automated state-migration step is needed.
- `src/main.ts` is unaffected. The CLI entry point consumes `composeApplication` only (verified via grep) and does not call `initializeProjectGraph` or `initializeProject` directly. The bootstrap return-shape change flows transparently through `composeApplication`.

## Steps

Ships as 2 commits, in order.

---

### Step 5.1 — Rewrite `initializeProjectGraph` for greenfield + existing-project paths [risk: med, size: M]

Approach: TDD (test-first).

What: split `initializeProjectGraph` into two paths:

- Greenfield (no milestones, no features): create empty project state. Persist nothing into the graph. Call `ProjectPlannerCoordinator.startProjectPlannerSession()`. Return the session id (or a structured bootstrap result) so the compose layer can pass it forward to the TUI.
- Existing project (any milestones or features present): resume as today. No auto-spawn.

The synthetic `m-1` / `f-1` creation and `transitionFeatureToPlanning(f-1)` call are removed.

Test (write first, expect red):

- In `test/unit/compose.test.ts`, add the bootstrap-split coverage and run before any implementation change. Each assertion below should fail RED against current `main`. Compile-RED expected first: the bootstrap-result union (`{ kind: 'greenfield-bootstrap', sessionId } | { kind: 'existing' }`) and `Store.listProjectSessions(...)` (phase-2-agent-runs-scope dependency) do not exist on `main`. The test file will fail to typecheck before any assertion runs; that is the expected initial RED. Once the types land via the implementation pass, the failures transition to assertion-RED on the behavioral checks below:
  - Greenfield bootstrap (no persisted state): `initializeProjectGraph(...)` against an empty `PersistentFeatureGraph` returns `{ kind: 'greenfield-bootstrap', sessionId }`; `Store.listProjectSessions({ status: ['running'] })` returns exactly one row; `graph.milestones.size === 0`; `graph.features.size === 0`.
  - Greenfield bootstrap (persisted-but-empty edge case): `.gvc0/state.db` exists with zero milestone and zero feature rows (e.g. abandoned `/init` partway, or upgrade from a prior version that left no synthetic feature) → same outcome as fresh greenfield (one project run, no milestones/features). This is distinct from the migration case in Notes: a project that ran the old `/init` has `m-1`/`f-1` rows persisted and is classified `existing`. The two cases are tested separately to make the boundary obvious.
  - Existing-project bootstrap: pre-seed graph with a real `m-x`/`f-x` from a fixture → `initializeProjectGraph(...)` returns `{ kind: 'existing' }`; no new project session is spawned (`Store.listProjectSessions({ status: ['running'] })` length unchanged).
- Confirm RED before implementing.

Implementation:

- `src/compose.ts` — rewrite `initializeProjectGraph`. The new function returns `{ kind: 'greenfield-bootstrap', sessionId } | { kind: 'existing' }`. Compose forwards this result so `phase-6-tui-mode` can auto-enter the session. Naming note: post-rewrite the function name is misleading on the greenfield path (it persists no graph, only triggers a project-planner session). Renaming is deferred — call out in the commit message that future phases may rename to `initializeProject` or split into two functions.
- `src/compose.ts` — `composeApplication` plumbs the bootstrap result into the TUI initialization step. Concretely: the result flows from `initializeProjectGraph` → composeApplication local → `app-deps.ts:initializeProject` return → `app-composer.ts:169` (where `dataSource.initializeProject(...)` is called today) → stored as a new `bootstrapResult` field that `phase-6-tui-mode` step 6.3 reads at startup.
- `src/tui/app-deps.ts` — change `initializeProject(...)` return type to match the new shape; this is a breaking change to the TUI's bootstrap contract and is the reason this phase cannot avoid TUI plumbing.
- `src/tui/app-composer.ts:169` — stop selecting `featureId` from the bootstrap result. Land a no-op consumer that stores `bootstrapResult` on view-model state (or a deps field) and reads nothing from it yet. `phase-6-tui-mode` step 6.3 replaces the no-op with auto-enter logic. Rationale: avoid an interim "delegate to `phase-6-tui-mode`" state where the field is set but unread — that risks this phase shipping with a typecheck-pass-but-runtime-broken composer flow if `phase-6-tui-mode` slips.
- `src/tui/view-model/index.ts` — empty-state copy update so the operator sees an explanatory message rather than an empty graph with no context (the previous synthetic feature filled that space).
- Iterate until the failing tests above turn GREEN. The deprecated synthetic `m-1` / `f-1` fixture path is removed or migrated as part of this implementation pass (broader fixture sweep happens in Step 5.2).

Verification: rerun the new compose tests (GREEN), then `npm run check:fix && npm run check`.

Review goals:
1. Verify the greenfield path creates only a project session, no synthetic milestone or feature.
2. Verify the existing-project path is unchanged.
3. Verify compose forwards the bootstrap result to TUI init and `src/tui/app-composer.ts:169` stores `bootstrapResult` without dereferencing `featureId`.
4. Verify Step 5.1's compose-level tests cover greenfield (fresh + persisted-but-empty) and existing-project paths.
Word cap: 350.

Commit: `feat(app/compose): bootstrap project-planner session on greenfield`

---

### Step 5.2 — Migrate existing tests off synthetic-feature assumptions [risk: low, size: M]

Approach: TDD for the unit-contract slice (`commands.test`, `app-composer.test`) — write red assertions against the new bootstrap-result shape, then make GREEN by rewriting test setup (production-side type-flow already established in Step 5.1). Fixture sweep across integration tests is migration churn (no RED→GREEN: existing coverage is preserved under the new bootstrap contract, not driven by new failing tests).

What: sweep the test suite for fixtures that implicitly assume a synthetic `f-1` exists at startup. Two migration patterns:

- Tests that exercise feature-phase flow: pre-seed the fixture with explicit `m-1`/`f-1` rows in the graph (mimicking an approved project-planner session). The synthetic shape moves from "compose creates it" to "test fixture creates it".
- Tests that exercise compose / startup flow: assert against the new greenfield/existing-project split.

TDD-able unit contracts (write first, expect red):

- `test/unit/tui/commands.test.ts` — for the `/init` command path, write failing assertions that the bootstrap-result union (`{ kind: 'greenfield-bootstrap', sessionId } | { kind: 'existing' }`) is what the command surface receives and forwards. Before implementation: RED (current code expects `featureId`). After Step 5.1's contract is in place plus the local rewrites here: GREEN.
- `test/unit/tui/app-composer.test.ts` — write failing assertions that `app-composer` consumes the new bootstrap-result shape (stores it as `bootstrapResult` per Step 5.1) and does not dereference `featureId`. RED first; rewrite the composer test setup to drive the new union; GREEN.
- Confirm RED for both before touching production code in this step. Implementation here is mostly test-side: any production-side touch needed to make these GREEN should be limited to type-flow that Step 5.1 already established.

Non-TDD pass (fixture sweep / migration churn):

- `test/integration/tui/smoke.test.ts` — replace assumed-synthetic-`f-1` setup with an explicit fixture that seeds the graph before the smoke run. (This is the primary integration migration.) Treated as migration churn rather than red→green: the goal is to keep existing coverage passing under the new bootstrap contract, not to drive new behavior from a failing test.
- `test/integration/feature-phase-agent-flow.test.ts` — no migration needed (verified self-contained); confirm by re-running the suite and leaving the file unchanged.
- `test/helpers/*` — add a shared helper for "pre-approved bootstrap" if more than one test needs it (likely just the smoke test plus one unit test; add only if duplication is real).

Verification:

- TDD slice: `commands.test` and `app-composer.test` go RED → GREEN as described.
- Migration slice: existing feature-phase coverage continues to pass with the explicit fixture; new compose-level coverage from Step 5.1 still passes.
- `npm run check:fix && npm run check`.

Review goals:
1. Verify no test still relies on `initializeProjectGraph` creating synthetic `m-1`/`f-1`.
2. Verify feature-phase tests use an explicit fixture helper where needed.
3. Verify coverage for the compose greenfield/existing-project split remains in place.
4. Verify integration tests still cover the full plan/replan/execute flow.
Word cap: 300.

Commit: `test: migrate fixtures off synthetic-feature bootstrap`
