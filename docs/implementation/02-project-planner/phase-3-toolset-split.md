# Phase 3 — Toolset split per scope

Status: drafting
Verified state: as of main @ a5abfeae9b1e59ee53d8c850da7203fdc146521a on 2026-05-01
Depends on: none
Default verify: npm run check:fix && npm run check
Phase exit: both commits land in order; `npm run verify` passes; plan/replan agent runs cannot reach topology tools at construction time; `editFeatureSpec` is a usable scope-safe spec-edit surface; `createProjectPlannerToolset(host)` is defined but not yet wired (`phase-4-project-planner-agent`); `discuss`/`research`/`verify`/`summarize`/`execute-task` construction is untouched; final review confirms no test/doc drift and no plan/replan callsite still uses the full combined toolset.
Doc-sweep deferred: docs/architecture/planner.md (toolset subsets are constructed per scope)

## Contract

Goal: Narrow the toolset on the only feature-scoped agents that currently reach topology mutations — `plan` and `replan` — so they cannot call `addMilestone`, `addFeature`, `removeFeature`, or cross-feature `addDependency`/`removeDependency`. The `proposalToolHost` stays scope-agnostic; the runtime decides which subset to expose per agent role. This reduces the blast radius of any submit-compliance or prompt issue in feature planners, prepares the agent surface for `phase-4-project-planner-agent`, defines the `createProjectPlannerToolset(host)` builder consumed by `phase-4-project-planner-agent`, and introduces `editFeatureSpec` as a spec-only subset of today's `editFeature`.

Scope:
- In: define scoped tool subsets in `src/agents/tools/planner-toolset.ts` (or sibling helper); thread the scope choice through plan/replan agent construction in `src/agents/runtime.ts:417-434`; tests asserting each scope's agent has only its allowed tools; introduce `editFeatureSpec` as a scoped subset of today's `editFeature`.
- Out: new project-planner agent role (`phase-4-project-planner-agent`); changing `proposalToolHost` host implementation (stays scope-agnostic); changing the prompt text for any agent (`phase-7-escalation-prompt` / `phase-8-submit-compliance` cover prompt work); changing existing tool semantics for tools shared across the new subsets; touching discuss/research/verify/summarize/execute-task — they are already topology-clean by construction (structured submits, no proposal host).

Boundary note: This phase does add new tool-time rejection behavior on the scoped `addDependency`/`removeDependency` (validates same-feature vs cross-feature endpoints) and new rejection behavior on `editFeatureSpec` (rejects rename / `milestoneId`). These are additions, not modifications to existing tool semantics — call sites that today pass valid same-feature task→task edges or valid spec patches see no behavior change. Out-of-scope inputs that previously silently succeeded against the full toolset are now rejected; this phase owns those new rejection paths.

Exit criteria:
- Both commits land in order.
- `npm run verify` passes.
- Plan / replan agent runs cannot reach topology tools at construction time.
- `editFeatureSpec` is a usable scope-safe spec-edit surface.
- `createProjectPlannerToolset(host)` is defined but not yet wired (`phase-4-project-planner-agent`).
- Discuss / research / verify / summarize / execute-task construction is untouched.
- Run a final review across both commits to confirm the discipline holds, no test/doc drift remains, and no callsite still uses the full combined toolset for plan/replan.

## Plan

Background:

- `src/agents/tools/planner-toolset.ts` exposes a single full toolset (`addMilestone`, `addFeature`, `removeFeature`, `editFeature`, `addTask`, `removeTask`, `editTask`, `setFeatureObjective`, `setFeatureDoD`, `addDependency`, `removeDependency`, `submit`).
- `request_help` is not in `planner-toolset.ts`. It is added in `src/agents/tools/agent-toolset.ts` (`buildProposalAgentToolset`) when the runtime supplies a help-response callback. Test coverage is `test/unit/agents/tools/planner-toolset.test.ts` (toolset shape) and `test/unit/agents/tools/agent-toolset.test.ts` (callback presence). This phase must distinguish the two.
- Audit of `src/agents/runtime.ts` and `src/runtime/worker/system-prompt.ts`:
  - `plan` / `replan` (`runtime.ts:417-434`): receive the full planner toolset via `createProposalToolHost(...)`. These are the only feature-scoped agents with topology authority today.
  - `discuss` (`runtime.ts:359-371`): `DefaultFeaturePhaseToolHost` + `submitDiscuss`. No proposal-graph tools. Already clean.
  - `research` (`runtime.ts:359-371`): `DefaultFeaturePhaseToolHost` + `submitResearch` + repo-read tools. Already clean.
  - `verify` (`runtime.ts:491-504`): `DefaultFeaturePhaseToolHost` + `raiseIssue` + `submitVerify`. Already clean.
  - `summarize` (`runtime.ts:359-371`): `DefaultFeaturePhaseToolHost` + `submitSummarize`. Already clean.
  - `execute-task` (worker, `runtime/worker/system-prompt.ts`): repo edits + verification commands; no graph tools. Already clean.
- `docs/architecture/planner.md:22-39` documents the full toolset as if it were universal. After this phase, the doc needs a note that subsets are constructed per scope; defer that update to the track docs sweep.
- `editFeature` (`PlannerFeatureEditPatch`, `src/core/graph/types.ts:65-75`) covers spec refinement and rename. The actual patch field names are `name`, `description`, `featureObjective`, `featureDoD` (not `objective` / `dod`). Milestone reassignment is not in the current patch shape. `phase-4-project-planner-agent` will need to add it (or a sibling tool) when the project planner ships. The split for this track:
  - `editFeatureSpec` — spec-only patch surface (`description`, `featureObjective`, `featureDoD`).
  - `editFeature` — rename (`name`) + spec; full surface stays project-scope-only.
- Bottom line: this phase is a focused narrowing of `plan` / `replan`, not a sweep across every feature agent.

Notes:

- 5 of 7 agents are already topology-clean. Audit of `runtime.ts` and `runtime/worker/system-prompt.ts` confirms only `plan` and `replan` reach the `proposalToolHost`. `discuss` / `research` / `verify` / `summarize` use `DefaultFeaturePhaseToolHost` with structured-submit tools (`submitDiscuss`, `submitResearch`, `raiseIssue`+`submitVerify`, `submitSummarize`); `execute-task` worker uses an `IpcBridge` toolset with no graph tools. This phase does not touch those sites.
- No new agent role yet. `phase-4-project-planner-agent` introduces the project-planner agent and wires `createProjectPlannerToolset(host)` into a real construction path. This phase only removes topology surface from `plan`/`replan`.
- Why before `phase-4-project-planner-agent`. Restricting plan/replan first reduces the surface area the new agent has to coexist with, and isolates Bug A's submit-compliance failure mode (the failing `plan` agent today has the full toolset; after this phase it has a much smaller one, and `phase-8-submit-compliance` targets the smaller surface).
- Milestone reassignment gap. Today's `PlannerFeatureEditPatch` has no `milestoneId` field, so `editFeature` cannot move a feature between milestones. `phase-4-project-planner-agent` must add this when the project planner ships, since milestone reassignment is part of project-scope authority.
- Documentation drift. `docs/architecture/planner.md` describes the full toolset as universal. The docs-update sweep covers the rewrite; do not include doc changes in this phase's commits.

## Steps

Ships as 2 commits, in order.

---

### 3.1 Introduce `editFeatureSpec` and define scope subsets [risk: low, size: M]

Approach: TDD (test-first, red-green-refactor)

What: add `editFeatureSpec` as a subset of today's `editFeature` covering description / objective / DoD only. Replace the single `createPlannerToolset(host)` factory in `src/agents/tools/planner-toolset.ts` with two builder functions:

- `createFeaturePlanToolset(host)` returns: `addTask`, `editTask`, `removeTask`, `setFeatureObjective`, `setFeatureDoD`, `editFeatureSpec`, intra-feature `addDependency` (validates both endpoints belong to the same feature), intra-feature `removeDependency`, `submit`. (`request_help` is added separately in `agent-toolset.ts` when the help-response callback is wired — not part of the toolset subset.)
- `createProjectPlannerToolset(host)` returns: `addMilestone`, `addFeature`, `removeFeature`, `editFeature` (full incl. rename and milestone reassignment once added in `phase-4-project-planner-agent`), `editFeatureSpec`, cross-feature `addDependency` (validates feature→feature), cross-feature `removeDependency`, `submit`. (Used by `phase-4-project-planner-agent`; defined here so the subset surface is consistent. `request_help` is wired in `agent-toolset.ts` for the project-planner agent build path, same shape as plan/replan today.)

Each builder function takes a `GraphProposalToolHost` (the existing class in `src/agents/tools/proposal-host.ts`; not renamed by this phase). `createPlannerToolset` is removed; the test anchor at `test/unit/agents/tools/planner-toolset.test.ts:47-60` (which asserts the unified 12-tool catalog) is replaced with two analogous tests, one per new builder.

The scope-aware `addDependency`/`removeDependency` validation runs at tool-call time and rejects out-of-scope edges with a clear error. There is no `featureDiscussTools` subset — `discuss` does not use the proposal-graph host today and that stays unchanged; spec changes derived from `submitDiscuss` happen at the orchestrator layer, not via discuss-agent tools.

This phase must keep `buildFeaturePhaseAgentToolset` (`src/agents/tools/agent-toolset.ts:214`) extensible: do not collapse its parameters or hardcode a phase-specific shape, since `phase-7-escalation-prompt` wires `request_help` into the discuss build path (it does not share the existing proposal-phase callback path — discuss has no help wiring today).

Files (test):

- `test/unit/agents/tools/planner-toolset.test.ts` — replace the unified-catalog assertion (currently `:47-60`) with two analogous tests: one asserts `createFeaturePlanToolset(host)` returns exactly the feature-plan catalog (no `addMilestone`/`addFeature`/`removeFeature`/full `editFeature`); one asserts `createProjectPlannerToolset(host)` returns exactly the project-planner catalog (no `addTask`/`editTask`/`removeTask` — task-mutation tools must be absent). Assert `editFeatureSpec` rejects rename-style patches; assert `removeDependency` scope-validation matches `addDependency`.
- `test/unit/agents/tools/agent-toolset.test.ts` — assert `buildProposalAgentToolset` routes to the correct builder by scope, and `request_help` presence/absence by callback wiring is unchanged across both scopes.

Files (prod):

- `src/agents/tools/planner-toolset.ts` — replace the unified `createPlannerToolset(host)` factory with `createFeaturePlanToolset(host)` and `createProjectPlannerToolset(host)`. Add `editFeatureSpec` next to `editFeature`. Add scope-validation helpers for `addDependency`/`removeDependency`. Both builders accept the existing `GraphProposalToolHost`.
- `src/agents/tools/agent-toolset.ts` — `buildProposalAgentToolset` selects which builder to call. Today it is unparameterized on scope (calls `createPlannerToolset(host)`); add a scope discriminator (e.g. `kind: 'feature' | 'project'`) with a default of `'feature'` so existing call sites (plan/replan in `runtime.ts:417-434`) continue to compile and route to the feature-plan catalog without code change. Step 3.2 then makes the scope arg explicit at the plan/replan call site (`{ kind: 'feature' }`) and adds the integration test scripting `addMilestone` from a plan agent (RED → GREEN once the toolset narrows). Without the default, Step 3.1's RED at the runtime call site would already be GREEN (the unified toolset is gone) and Step 3.2's RED could not be authored. `request_help` wiring stays the same (callback-driven). Keep `buildFeaturePhaseAgentToolset` extensible — `phase-7-escalation-prompt` adds a `request_help` callback to discuss separately.
- `src/agents/tools/proposal-host.ts` — confirm `editFeatureSpec` maps to a host method that mutates only spec fields. If the host doesn't separate, add a thin wrapper or expose a typed patch shape so the tool layer enforces the scope. The class is `GraphProposalToolHost`; do not rename.
- `src/agents/tools/schemas.ts` — add the `editFeatureSpec` patch schema (mirrors `PlannerFeatureEditPatch` minus `name`).

Test (write first, expect red):

- Write `createFeaturePlanToolset(host)` exclusion test (no `addMilestone`/`addFeature`/`removeFeature`/full `editFeature`) and inclusion test (`editFeatureSpec`, `addTask`, `editTask`, `removeTask`, intra-feature `addDependency`/`removeDependency`, `setFeatureObjective`, `setFeatureDoD`, `submit`). Confirm RED — note this is a compile-RED (the new builder names, `editFeatureSpec` schema, and the scope-validation helpers do not exist yet), not an assertion-RED.
- Write `createProjectPlannerToolset(host)` inclusion test (topology surface + full `editFeature`) plus exclusion test (no `addTask`/`editTask`/`removeTask`). Confirm RED.
- Write `editFeatureSpec` shape tests: accepts `{ description, featureObjective, featureDoD }` patches; rejects `{ name }` with a clear error. Confirm RED. (`{ milestoneId }` rejection is deferred to `phase-4-project-planner-agent` — the field does not exist on `main`.)
- Write scope-aware dependency tests: intra-feature `addDependency`/`removeDependency` reject feature→feature edges; cross-feature variants accept them and reject task→task edges. Confirm RED.
- Write `buildProposalAgentToolset` routing test (scope discriminator selects correct builder; `request_help` presence governed by callback wiring across both scopes). Confirm RED.

Implementation: define `createFeaturePlanToolset` and `createProjectPlannerToolset` minimally to pass each red test in turn; add `editFeatureSpec` schema and host wrapper; add scope-validation helpers; thread the scope discriminator through `buildProposalAgentToolset`. Confirm GREEN after each step. Refactor for shared validation helpers once green.

Verification: `npm run check:fix && npm run check`.

Review goals:
1) Verify `createFeaturePlanToolset` and `createProjectPlannerToolset` are defined as named exports, replacing today's `createPlannerToolset`.
2) Verify `editFeatureSpec` rejects rename / topology-adjacent fields (`name` rejection in this commit; `milestoneId` rejection deferred to `phase-4-project-planner-agent` when the field lands).
3) Verify scope-aware dependency tools reject out-of-scope edges.
4) Verify `buildProposalAgentToolset` defaults its scope arg to `'feature'` so plan/replan call sites still compile before Step 3.2, which then makes the scope explicit and adds the integration test.
5) Verify `discuss`/`research`/`verify`/`summarize`/`execute-task` construction is untouched by this phase; `phase-7-escalation-prompt` separately extends the discuss toolset with `request_help` for topology escalation.
Word cap: 350.

Commit: `feat(agents/tools): introduce scoped planner toolset subsets`

---

### 3.2 Wire `createFeaturePlanToolset` through plan/replan construction [risk: low, size: S]

Approach: TDD (test-first, red-green-refactor)

What: change `src/agents/runtime.ts` plan/replan construction (around `:417-434`) to attach the result of `createFeaturePlanToolset(host)` instead of the full combined toolset. The full combined set is no longer used by feature-scoped roles. Project-planner construction is added in `phase-4-project-planner-agent` (this phase leaves a stub or comment marker only). `discuss`, `research`, `verify`, `summarize` construction sites stay untouched — they already use `DefaultFeaturePhaseToolHost` with structured-submit tools.

Files (test):

- `test/unit/agents/runtime.test.ts` (or closest equivalent) — assert the toolset attached to the plan/replan agent is the feature-plan catalog (dispatch routing verifiable via the constructed agent's tool list).
- `test/integration/feature-phase-agent-flow.test.ts` — extend or add coverage that scripts a faux model attempting `addMilestone` from a `plan` phase agent and asserts the call is rejected (tool not present in the subset).

Files (prod):

- `src/agents/runtime.ts` — at the plan/replan agent construction site (`:417-421`), pass scope `'feature'` to `buildProposalAgentToolset`. The construction shape stays the same.
- `src/agents/tools/agent-toolset.ts` — `buildProposalAgentToolset` branches on the scope arg to call `createFeaturePlanToolset` or `createProjectPlannerToolset`.
- `src/runtime/harness/feature-phase/index.ts` — verified does not reference the toolset directly today; update only if a downstream change requires it.
- `src/tui/proposal-controller.ts` — verified `phase-6-tui-mode` does not reuse this controller for project sessions (it stays feature-scoped). Confirm the controller's planner-op echo logic does not assume `addMilestone`/`addFeature`/`removeFeature` ops appear from feature-scope agents (they no longer can post-phase-3); narrow the op-handling switch if it has a wildcard fallthrough that silently masks unexpected ops.

Test (write first, expect red):

- Write the unit assertion that the `plan` phase agent's toolset is exactly the feature-plan catalog (dispatch routes through `buildProposalAgentToolset(..., { kind: 'feature' })`); confirm RED (construction site still attaches the unified toolset).
- Write the same assertion for `replan`. Confirm RED.
- Write the integration test scripting a faux model that emits `addMilestone` from a `plan` agent and asserts a clear "tool not found" error (no silent proposal-graph mutation). Confirm RED.
- Keep regression coverage for the existing `plan` happy-path (`addTask` + `submit`) and for `discuss`/`research`/`verify`/`summarize` construction shape — these must stay GREEN throughout.

Implementation: thread `kind: 'feature'` through the plan/replan construction call in `runtime.ts:417-421`; route `buildProposalAgentToolset` to `createFeaturePlanToolset` for that scope. Do not modify discuss/research/verify/summarize construction sites. Confirm GREEN on the new tests and that the regression set stays GREEN.

Verification: `npm run check:fix && npm run check`.

Review goals:
1) Verify `src/agents/runtime.ts:417-421` attaches the feature-plan catalog to plan and replan via `buildProposalAgentToolset(..., { kind: 'feature' })`.
2) Verify the faux-model integration test confirms a `plan` agent cannot call topology tools.
3) Verify existing happy-path `plan`/`replan` tests are unchanged.
4) Verify no callsite still threads the unified `createPlannerToolset` for plan/replan.
5) Verify `discuss`/`research`/`verify`/`summarize` construction sites at `runtime.ts:359-371` and `:491-504` are not modified by this phase; `phase-7-escalation-prompt` separately wires `request_help` into `buildFeaturePhaseAgentToolset` for discuss escalation.
Word cap: 300.

Commit: `refactor(agents/runtime): scope planner toolset per agent phase`

---
