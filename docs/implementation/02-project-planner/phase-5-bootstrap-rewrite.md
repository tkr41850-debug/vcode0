# Phase 5 — Bootstrap rewrite

## Goal

Replace the synthetic-feature bootstrap path with a real first-run project-planner session. On a greenfield project (no milestones, no features), the compose layer creates empty project state and spawns a project-planner session via the Phase 4 coordinator. The TUI auto-enter (Phase 6) attaches the operator to the session.

## Scope

**In:** rewrite `initializeProjectGraph` in `src/compose.ts` to no longer fabricate `m-1`/`f-1`; detect greenfield state and call `ProjectPlannerCoordinator.startProjectPlannerSession`; preserve the existing path for non-greenfield startup (resume existing graph, do not auto-spawn); update the **return shape** of `initializeProjectGraph` and propagate the new shape through `src/tui/app-deps.ts` and `src/tui/app-composer.ts` (which currently expect `{ milestoneId, featureId }`); update empty-state copy in `src/tui/view-model/index.ts`; update tests and fixtures that depend on the synthetic feature.

**Out:** TUI auto-enter wiring proper (Phase 6 — Phase 5 only changes the bootstrap return shape and ensures TUI deps compile against it; the actual auto-enter behavior lands in Phase 6); approval surfacing for the first-run proposal (Phase 6); changing the feature workControl FSM or per-feature discuss/research/plan flow.

## Background

Verified state on `main`:

- `initializeProjectGraph(graph, input)` in `src/compose.ts` creates `m-1` synthetically, creates `f-1` synthetically, and calls `transitionFeatureToPlanning(f-1)`. Today it returns `{ milestoneId, featureId }`; that shape is consumed by `src/tui/app-deps.ts` (`initializeProject(...)`) and immediately used by `src/tui/app-composer.ts` to select the bootstrap feature.
- `createFeature(...)` in `src/core/graph/creation.ts` starts features in `workControl: 'discussing'`. `transitionFeatureToPlanning(...)` then advances the feature agentlessly through `discussing → done → researching → done → planning`. The feature lands in `workControl: 'planning', status: 'pending'` ready for dispatch.
- This bypasses the agent-driven discuss and research surfaces entirely. With the project-planner architecture, there is no synthetic feature to bypass — graph topology is built by the project planner instead.
- The synthetic state **is persisted**, not in-memory only: `initializeProjectGraph(...)` mutates a `PersistentFeatureGraph` backed by `.gvc0/state.db`. Once `/init` runs, `m-1` and `f-1` exist on disk. This means greenfield detection cannot be "graph empty in memory" — a second startup of an `/init`-only project sees the persisted synthetic feature and is **not** greenfield. (See Step 5.1 for the implication: greenfield detection needs to predate the synthetic-feature creation, or the synthetic creation needs to be removed before any other startup ever runs against the new code.)
- Phase 8 of `01-baseline` (`fix(scheduler): skip feature worktree for planning phases`, commit `245fcf0`) made this synthetic-feature path non-failing for the worktree-provisioning step. The bootstrap rewrite here supersedes the synthetic half of phase 8: the worktree gate stays correct, but the synthetic feature itself is no longer created.
- `ProjectPlannerCoordinator` and `Store.listProjectSessions(...)` are **introduced by Phase 4 / Phase 2**, not present on `main`. Phase 5 has hard dependencies on Phase 4 (coordinator) and Phase 2 (store helper).
- Tests that actually depend on the synthetic bootstrap (verified):
  - `test/unit/compose.test.ts` — direct compose-level coverage (closest existing compose test; **not** `test/unit/app/compose.test.ts`, which does not exist).
  - `test/integration/tui/smoke.test.ts` — assumes initial graph contains `m-1`/`f-1`.
  - `test/unit/tui/app-composer.test.ts` and `test/unit/tui/commands.test.ts` — lighter contract assumptions on the bootstrap return shape.
  - `test/integration/feature-phase-agent-flow.test.ts` already seeds its own explicit `m-1`/`f-1` fixture and does **not** depend on `initializeProjectGraph`. No migration needed there.

## Steps

Ships as **2 commits**, in order.

---

### Step 5.1 — Rewrite `initializeProjectGraph` for greenfield + existing-project paths

**What:** split `initializeProjectGraph` into two paths:

- **Greenfield** (no milestones, no features): create empty project state. Persist nothing into the graph. Call `ProjectPlannerCoordinator.startProjectPlannerSession()`. Return the session id (or a structured bootstrap result) so the compose layer can pass it forward to the TUI.
- **Existing project** (any milestones or features present): resume as today. No auto-spawn.

The synthetic `m-1` / `f-1` creation and `transitionFeatureToPlanning(f-1)` call are removed.

**Files:**

- `src/compose.ts` — rewrite `initializeProjectGraph`. The new function returns `{ kind: 'greenfield-bootstrap', sessionId } | { kind: 'existing' }`. Compose forwards this result so Phase 6 can auto-enter the session. **Naming note:** post-rewrite the function name is misleading on the greenfield path (it persists no graph, only triggers a project-planner session). Renaming is deferred — call out in the commit message that future phases may rename to `initializeProject` or split into two functions.
- `src/compose.ts` — `composeApplication` plumbs the bootstrap result into the TUI initialization step. Concretely: the result flows from `initializeProjectGraph` → composeApplication local → `app-deps.ts:initializeProject` return → `app-composer.ts:169` (where `dataSource.initializeProject(...)` is called today) → stored as a new `bootstrapResult` field that Phase 6 Step 6.3 reads at startup.
- `src/tui/app-deps.ts` — change `initializeProject(...)` return type to match the new shape; this is a breaking change to the TUI's bootstrap contract and is the reason Phase 5 cannot avoid TUI plumbing.
- `src/tui/app-composer.ts:169` — stop selecting `featureId` from the bootstrap result. **Land a no-op consumer** that stores `bootstrapResult` on view-model state (or a deps field) and reads nothing from it yet. Phase 6 Step 6.3 replaces the no-op with auto-enter logic. Rationale: avoid an interim "delegate to Phase 6" state where the field is set but unread — that risks Phase 5 shipping with a typecheck-pass-but-runtime-broken composer flow if Phase 6 slips.
- `src/tui/view-model/index.ts` — empty-state copy update so the operator sees an explanatory message rather than an empty graph with no context (the previous synthetic feature filled that space).
- `test/unit/compose.test.ts` — coverage that greenfield path creates exactly one project run and zero milestones/features.
- `test/unit/compose.test.ts` — coverage that existing-project path creates zero new runs.
- `test/unit/compose.test.ts` — coverage for the **truly-empty persisted-state** edge case: a `.gvc0/state.db` file exists but contains zero milestone and zero feature rows (e.g. abandoned `/init` partway, or upgrade from a prior version that left no synthetic feature) → still treated as greenfield. This is **distinct** from the migration case in Notes: a project that ran the old `/init` has `m-1`/`f-1` rows persisted and is classified `existing`. The two cases are tested separately to make the boundary obvious.

**Tests:**

- Greenfield bootstrap (no persisted state): after init, `Store.listProjectSessions({ status: ['running'] })` returns one row; `graph.milestones.size === 0`; `graph.features.size === 0`.
- Greenfield bootstrap (persisted but empty: empty store + empty graph after migration): same outcome — one project run; no milestones/features.
- Existing-project bootstrap: pre-seed graph with a real `m-x`/`f-x` from a fixture → after init, no new project session is spawned.
- The deprecated synthetic `m-1` / `f-1` fixture path is removed or migrated.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify bootstrap split: (1) greenfield path creates only a project session, no synthetic milestone/feature; (2) existing-project path is unchanged; (3) compose forwards the bootstrap result to TUI init; (4) tests that previously assumed synthetic `f-1` are migrated to either set up a real fixture or work from a project-planner session result. Under 350 words.

**Commit:** `feat(app/compose): bootstrap project-planner session on greenfield`

---

### Step 5.2 — Migrate existing tests off synthetic-feature assumptions

**What:** sweep the test suite for fixtures that implicitly assume a synthetic `f-1` exists at startup. Two migration patterns:

- Tests that exercise feature-phase flow: pre-seed the fixture with explicit `m-1`/`f-1` rows in the graph (mimicking an approved project-planner session). The synthetic shape moves from "compose creates it" to "test fixture creates it".
- Tests that exercise compose / startup flow: assert against the new greenfield/existing-project split.

**Files:**

- `test/integration/tui/smoke.test.ts` — replace assumed-synthetic-`f-1` setup with an explicit fixture that seeds the graph before the smoke run. (This is the primary integration migration.)
- `test/unit/tui/app-composer.test.ts`, `test/unit/tui/commands.test.ts` — update light contract assumptions about the bootstrap return shape. Most assertions are about `featureId` being present; rewrite to assert the new union shape and route through the new return type.
- `test/integration/feature-phase-agent-flow.test.ts` — **no migration needed** (verified self-contained); confirm by re-running the suite and leaving the file unchanged.
- `test/helpers/*` — add a shared helper for "pre-approved bootstrap" if more than one test needs it (likely just the smoke test plus one unit test; add only if duplication is real).

**Tests:**

- Existing feature-phase coverage continues to pass with the explicit fixture.
- New compose-level coverage (from step 5.1) passes.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify test migration: (1) no test still relies on `initializeProjectGraph` creating synthetic `m-1`/`f-1`; (2) feature-phase tests use an explicit fixture helper; (3) coverage for compose greenfield/existing split is in place; (4) integration tests still cover the full plan/replan/execute flow. Under 300 words.

**Commit:** `test: migrate fixtures off synthetic-feature bootstrap`

---

## Phase exit criteria

- Both commits land in order.
- `npm run verify` passes.
- On a fresh project root, `/init` followed by `npx tsx src/main.ts` produces empty graph state plus a single project-planner session in `running` (or `ready`).
- On a project root with existing graph state, startup behaves unchanged (no new project session).
- Run a final review subagent across both commits to confirm the synthetic-feature path is fully gone and the new bootstrap surface is covered.

## Notes

- **Phase 6 dependency.** The TUI auto-enter is implemented in Phase 6 and consumes the bootstrap result Phase 5 produces. Phase 5 alone does not change TUI behavior; the user will still see whatever default mode the TUI uses.
- **Documentation drift.** `01-baseline/phase-8-planning-branch-bootstrap.md` describes the synthetic-feature path. The docs-update sweep handles the rewrite; do not include doc edits in Phase 5 commits.
- **Migration semantics.** This is a breaking change to startup behavior. The synthetic feature **is persisted** to `.gvc0/state.db` once `/init` runs (`PersistentFeatureGraph` writes through). Existing greenfield projects that already ran the old `/init` will boot up with `m-1`/`f-1` already in the store and will be classified as "existing project" by the new bootstrap — they will not auto-spawn a project-planner session. That is the desired migration: users who started under the synthetic-feature regime keep their feature; only truly new projects get the new flow. No automated state-migration step is needed.
- **`src/main.ts` is unaffected.** The CLI entry point consumes `composeApplication` only (verified via grep) and does not call `initializeProjectGraph` or `initializeProject` directly. The bootstrap return-shape change flows transparently through `composeApplication`.
