# Phase 3 — Toolset split per scope

## Goal

Narrow the toolset on the only feature-scoped agents that currently reach topology mutations — `plan` and `replan` — so they cannot call `addMilestone`, `addFeature`, `removeFeature`, or cross-feature `addDependency`/`removeDependency`. The `proposalToolHost` stays scope-agnostic; the runtime decides which subset to expose per agent role. Reduces the blast radius of any submit-compliance or prompt issue in feature planners and prepares the agent surface for Phase 4 (project planner).

Also define the `projectPlannerTools` subset here (consumed by Phase 4) and introduce `editFeatureSpec` as a spec-only subset of today's `editFeature`.

## Scope

**In:** define scoped tool subsets in `src/agents/tools/planner-toolset.ts` (or sibling helper); thread the scope choice through plan/replan agent construction in `src/agents/runtime.ts:417-434`; tests asserting each scope's agent has only its allowed tools; introduce `editFeatureSpec` as a scoped subset of today's `editFeature`.

**Out:** new project-planner agent role (Phase 4); changing `proposalToolHost` host implementation (stays scope-agnostic); changing the prompt text for any agent (Phase 7 / Phase 8 cover prompt work); changing existing tool semantics for tools shared across the new subsets; touching discuss/research/verify/summarize/execute-task — they are already topology-clean by construction (structured submits, no proposal host).

Note: Phase 3 **does** add new tool-time rejection behavior on the scoped `addDependency`/`removeDependency` (validates same-feature vs cross-feature endpoints) and new rejection behavior on `editFeatureSpec` (rejects rename / `milestoneId`). These are additions, not modifications to existing tool semantics — call sites that today pass valid same-feature task→task edges or valid spec patches see no behavior change. Out-of-scope inputs that previously silently succeeded against the full toolset are now rejected; Phase 3 owns those new rejection paths.

## Background

Verified state on `main`:

- `src/agents/tools/planner-toolset.ts` exposes a single full toolset (`addMilestone`, `addFeature`, `removeFeature`, `editFeature`, `addTask`, `removeTask`, `editTask`, `setFeatureObjective`, `setFeatureDoD`, `addDependency`, `removeDependency`, `submit`).
- `request_help` is **not** in `planner-toolset.ts`. It is added in `src/agents/tools/agent-toolset.ts` (`buildProposalAgentToolset`) when the runtime supplies a help-response callback. Test coverage is `test/unit/agents/tools/planner-toolset.test.ts` (toolset shape) and `test/unit/agents/tools/agent-toolset.test.ts` (callback presence). Phase 3 must distinguish the two.
- Audit of `src/agents/runtime.ts` and `src/runtime/worker/system-prompt.ts`:
  - `plan` / `replan` (`runtime.ts:417-434`): receive the full planner toolset via `createProposalToolHost(...)`. **These are the only feature-scoped agents with topology authority today.**
  - `discuss` (`runtime.ts:359-371`): `DefaultFeaturePhaseToolHost` + `submitDiscuss`. No proposal-graph tools. Already clean.
  - `research` (`runtime.ts:359-371`): `DefaultFeaturePhaseToolHost` + `submitResearch` + repo-read tools. Already clean.
  - `verify` (`runtime.ts:491-504`): `DefaultFeaturePhaseToolHost` + `raiseIssue` + `submitVerify`. Already clean.
  - `summarize` (`runtime.ts:359-371`): `DefaultFeaturePhaseToolHost` + `submitSummarize`. Already clean.
  - `execute-task` (worker, `runtime/worker/system-prompt.ts`): repo edits + verification commands; no graph tools. Already clean.
- `docs/architecture/planner.md:22-39` documents the full toolset as if it were universal. After this phase, the doc needs a note that subsets are constructed per scope (deferred to a docs-update sweep, see background-agent scan).
- `editFeature` (`PlannerFeatureEditPatch`, `src/core/graph/types.ts:65-75`) covers spec refinement and rename. The actual patch field names are `name`, `description`, `featureObjective`, `featureDoD` (not `objective` / `dod`). Milestone reassignment is **not** in the current patch shape — Phase 4 will need to add it (or a sibling tool) when project-planner ships. The split for this track:
  - `editFeatureSpec` — spec-only patch surface (`description`, `featureObjective`, `featureDoD`).
  - `editFeature` — rename (`name`) + spec; full surface stays project-scope-only.

Bottom line: Phase 3 is a focused narrowing of `plan` / `replan`, not a sweep across every feature agent.

## Steps

Ships as **2 commits**, in order.

---

### Step 3.1 — Introduce `editFeatureSpec` and define scope subsets

**Approach:** TDD (test-first, red-green-refactor)

**What:** add `editFeatureSpec` as a subset of today's `editFeature` covering description / objective / DoD only. Replace the single `createPlannerToolset(host)` factory in `src/agents/tools/planner-toolset.ts` with **two builder functions**:

- `createFeaturePlanToolset(host)` returns: `addTask`, `editTask`, `removeTask`, `setFeatureObjective`, `setFeatureDoD`, `editFeatureSpec`, intra-feature `addDependency` (validates both endpoints belong to the same feature), intra-feature `removeDependency`, `submit`. (`request_help` is added separately in `agent-toolset.ts` when the help-response callback is wired — not part of the toolset subset.)
- `createProjectPlannerToolset(host)` returns: `addMilestone`, `addFeature`, `removeFeature`, `editFeature` (full incl. rename and milestone reassignment once added in Phase 4), `editFeatureSpec`, cross-feature `addDependency` (validates feature→feature), cross-feature `removeDependency`, `submit`. (Used by Phase 4; defined here so the subset surface is consistent. `request_help` is wired in `agent-toolset.ts` for the project-planner agent build path, same shape as plan/replan today.)

Each builder function takes a `GraphProposalToolHost` (the existing class in `src/agents/tools/proposal-host.ts`; **not** renamed by this phase). `createPlannerToolset` is removed; the test anchor at `test/unit/agents/tools/planner-toolset.test.ts:47-60` (which asserts the unified 12-tool catalog) is replaced with two analogous tests, one per new builder.

The scope-aware `addDependency`/`removeDependency` validation runs at tool-call time and rejects out-of-scope edges with a clear error. There is no `featureDiscussTools` subset — `discuss` does not use the proposal-graph host today and that stays unchanged; spec changes derived from `submitDiscuss` happen at the orchestrator layer, not via discuss-agent tools.

Phase 3 must keep `buildFeaturePhaseAgentToolset` (`src/agents/tools/agent-toolset.ts:214`) **extensible**: do not collapse its parameters or hardcode a phase-specific shape, since Phase 7 wires `request_help` into the discuss build path (it does **not** share the existing proposal-phase callback path — discuss has no help wiring today).

**Files (test):**

- `test/unit/agents/tools/planner-toolset.test.ts` — replace the unified-catalog assertion (currently `:47-60`) with two analogous tests: one asserts `createFeaturePlanToolset(host)` returns exactly the feature-plan catalog (no `addMilestone`/`addFeature`/`removeFeature`/full `editFeature`); one asserts `createProjectPlannerToolset(host)` returns exactly the project-planner catalog (no `addTask`/`editTask`/`removeTask` — task-mutation tools must be absent). Assert `editFeatureSpec` rejects rename-style patches; assert `removeDependency` scope-validation matches `addDependency`.
- `test/unit/agents/tools/agent-toolset.test.ts` — assert `buildProposalAgentToolset` routes to the correct builder by scope, and `request_help` presence/absence by callback wiring is unchanged across both scopes.

**Files (prod):**

- `src/agents/tools/planner-toolset.ts` — replace the unified `createPlannerToolset(host)` factory with `createFeaturePlanToolset(host)` and `createProjectPlannerToolset(host)`. Add `editFeatureSpec` next to `editFeature`. Add scope-validation helpers for `addDependency`/`removeDependency`. Both builders accept the existing `GraphProposalToolHost`.
- `src/agents/tools/agent-toolset.ts` — `buildProposalAgentToolset` selects which builder to call. Today it is unparameterized on scope (calls `createPlannerToolset(host)`); add a scope discriminator (e.g. `kind: 'feature' | 'project'`) so the right builder runs. `request_help` wiring stays the same (callback-driven). Keep `buildFeaturePhaseAgentToolset` extensible — Phase 7 will add a `request_help` callback to discuss separately.
- `src/agents/tools/proposal-host.ts` — confirm `editFeatureSpec` maps to a host method that mutates only spec fields. If the host doesn't separate, add a thin wrapper or expose a typed patch shape so the tool layer enforces the scope. The class is `GraphProposalToolHost`; do not rename.
- `src/agents/tools/schemas.ts` — add the `editFeatureSpec` patch schema (mirrors `PlannerFeatureEditPatch` minus `name`).

**Test (write first, expect red):**

- Write `featurePlanTools` exclusion test (no `addMilestone`/`addFeature`/`removeFeature`/full `editFeature`) and inclusion test (`editFeatureSpec`, `addTask`, `editTask`, `removeTask`, intra-feature `addDependency`/`removeDependency`, `setFeatureObjective`, `setFeatureDoD`, `submit`). Confirm RED (builder does not exist).
- Write `projectPlannerTools` inclusion test (topology surface + full `editFeature`) plus exclusion test (no `addTask`/`editTask`/`removeTask`). Confirm RED.
- Write `editFeatureSpec` shape tests: accepts `{ description, featureObjective, featureDoD }` patches; rejects `{ name }` with a clear error. Confirm RED. (`{ milestoneId }` rejection is **deferred to Phase 4** — field does not exist on `main`.)
- Write scope-aware dependency tests: intra-feature `addDependency`/`removeDependency` reject feature→feature edges; cross-feature variants accept them and reject task→task edges. Confirm RED.
- Write `buildProposalAgentToolset` routing test (scope discriminator selects correct builder; `request_help` presence governed by callback wiring across both scopes). Confirm RED.

**Implementation:** define `createFeaturePlanToolset` and `createProjectPlannerToolset` minimally to pass each red test in turn; add `editFeatureSpec` schema and host wrapper; add scope-validation helpers; thread the scope discriminator through `buildProposalAgentToolset`. Confirm GREEN after each step. Refactor for shared validation helpers once green.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the toolset split: (1) `featurePlanTools` and `projectPlannerTools` are defined as named exports; (2) `editFeatureSpec` rejects rename / topology-adjacent fields (rename `name` rejection in this commit; `milestoneId` rejection deferred to Phase 4 when the field lands); (3) scope-aware dependency tools reject out-of-scope edges; (4) existing combined toolset (if still exported for backward compat) is not used by `plan`/`replan` agent construction; (5) `discuss`/`research`/`verify`/`summarize`/`execute-task` construction is untouched **by Phase 3** — Phase 7 separately extends the discuss toolset with `request_help` for topology escalation; that is not in scope here. Under 350 words.

**Commit:** `feat(agents/tools): introduce scoped planner toolset subsets`

---

### Step 3.2 — Wire `featurePlanTools` through plan/replan construction

**Approach:** TDD (test-first, red-green-refactor)

**What:** change `src/agents/runtime.ts` plan/replan construction (around `:417-434`) to attach `featurePlanTools` instead of the full combined toolset. The full combined set is no longer used by feature-scoped roles. Project-planner construction is added in Phase 4 (this phase leaves a stub or comment marker only). `discuss`, `research`, `verify`, `summarize` construction sites stay untouched — they already use `DefaultFeaturePhaseToolHost` with structured-submit tools.

**Files (test):**

- `test/unit/agents/runtime.test.ts` (or closest equivalent) — assert the toolset attached to the plan/replan agent is the feature-plan catalog (dispatch routing verifiable via the constructed agent's tool list).
- `test/integration/feature-phase-agent-flow.test.ts` — extend or add coverage that scripts a faux model attempting `addMilestone` from a `plan` phase agent and asserts the call is rejected (tool not present in the subset).

**Files (prod):**

- `src/agents/runtime.ts` — at the plan/replan agent construction site (`:417-421`), pass scope `'feature'` to `buildProposalAgentToolset`. The construction shape stays the same.
- `src/agents/tools/agent-toolset.ts` — `buildProposalAgentToolset` branches on the scope arg to call `createFeaturePlanToolset` or `createProjectPlannerToolset`.
- `src/runtime/harness/feature-phase/index.ts` — verified does not reference the toolset directly today; update only if a downstream change requires it.
- `src/tui/proposal-controller.ts` — verified Phase 6 does not reuse this controller for project sessions (it stays feature-scoped). Confirm the controller's planner-op echo logic does not assume `addMilestone`/`addFeature`/`removeFeature` ops appear from feature-scope agents (they no longer can post-Phase-3); narrow the op-handling switch if it has a wildcard fallthrough that silently masks unexpected ops.

**Test (write first, expect red):**

- Write the unit assertion that the `plan` phase agent's toolset is exactly the feature-plan catalog (dispatch routes through `buildProposalAgentToolset(..., { kind: 'feature' })`); confirm RED (construction site still attaches the unified toolset).
- Write the same assertion for `replan`. Confirm RED.
- Write the integration test scripting a faux model that emits `addMilestone` from a `plan` agent and asserts a clear "tool not found" error (no silent proposal-graph mutation). Confirm RED.
- Keep regression coverage for the existing `plan` happy-path (`addTask` + `submit`) and for `discuss`/`research`/`verify`/`summarize` construction shape — these must stay GREEN throughout.

**Implementation:** thread `kind: 'feature'` through the plan/replan construction call in `runtime.ts:417-421`; route `buildProposalAgentToolset` to `createFeaturePlanToolset` for that scope. Do not modify discuss/research/verify/summarize construction sites. Confirm GREEN on the new tests and that the regression set stays GREEN.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify scope wiring: (1) `src/agents/runtime.ts:417-421` attaches the feature-plan catalog to plan and replan via `buildProposalAgentToolset(..., { kind: 'feature' })`; (2) faux-model integration test confirms a `plan` agent cannot call topology tools; (3) existing happy-path `plan`/`replan` tests are unchanged; (4) no callsite still threads the unified `createPlannerToolset` for plan/replan; (5) `discuss`/`research`/`verify`/`summarize` construction sites at `runtime.ts:359-371` and `:491-504` are not modified **by Phase 3** — Phase 7 separately wires `request_help` into `buildFeaturePhaseAgentToolset` for discuss escalation. Under 300 words.

**Commit:** `refactor(agents/runtime): scope planner toolset per agent phase`

---

## Phase exit criteria

- Both commits land in order.
- `npm run verify` passes.
- Plan / replan agent runs cannot reach topology tools at construction time.
- `editFeatureSpec` is a usable scope-safe spec-edit surface.
- `projectPlannerTools` subset is defined but not yet wired (Phase 4).
- Discuss / research / verify / summarize / execute-task construction is untouched.
- Run a final review subagent across both commits to confirm the discipline holds, no test/doc drift remains, and no callsite still uses the full combined toolset for plan/replan.

## Notes

- **5 of 7 agents are already topology-clean.** Audit of `runtime.ts` and `runtime/worker/system-prompt.ts` confirms only `plan` and `replan` reach the `proposalToolHost`. `discuss` / `research` / `verify` / `summarize` use `DefaultFeaturePhaseToolHost` with structured-submit tools (`submitDiscuss`, `submitResearch`, `raiseIssue`+`submitVerify`, `submitSummarize`); `execute-task` worker uses an `IpcBridge` toolset with no graph tools. Phase 3 does not touch those sites.
- **No new agent role yet.** Phase 4 introduces the project-planner agent and wires `projectPlannerTools` into a real construction path. Phase 3 only removes topology surface from `plan`/`replan`.
- **Why before Phase 4.** Restricting plan/replan first reduces the surface area Phase 4's new agent has to coexist with, and isolates Bug A's submit-compliance failure mode (the failing `plan` agent today has the full toolset; after Phase 3 it has a much smaller one, and Phase 8's prompt work targets the smaller surface).
- **Milestone reassignment gap.** Today's `PlannerFeatureEditPatch` has no `milestoneId` field, so `editFeature` cannot move a feature between milestones. Phase 4 must add this when project-planner ships, since milestone reassignment is part of project-scope authority.
- **Documentation drift.** `docs/architecture/planner.md` describes the full toolset as universal. The docs-update sweep (background scan) covers the rewrite; do not include doc changes in Phase 3 commits.
