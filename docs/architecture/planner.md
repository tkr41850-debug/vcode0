# Planner

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for the high-level architecture overview.

## Planner: Proposal-Graph Tool Model

The planner is a pi-sdk `Agent` with access to the
feature-graph mutation tools.
It builds a **temporary proposal graph** incrementally via tool
calls rather than emitting a single JSON blob.
This means the graph is validated as it's constructed
(no cycles, referential integrity) and the planner can
reason step-by-step, while the authoritative graph remains
unchanged until a human approves the proposal.

`GraphProposalToolHost` (created via `createProposalToolHost()` helper in `src/agents/tools/proposal-host.ts`) holds an `InMemoryFeatureGraph` draft and a `GraphProposalBuilder` that records each tool-call mutation as an ordered operation. It maintains the distinction between mutable drafting (before `submit()`) and immutable finalization, allowing the planner and replanner agents to reason about graph changes step-by-step while keeping the proposal in a reviewable form. The host is instantiated by the planner/replanner runtime in `src/agents/runtime.ts` and by the TUI proposal controller in `src/tui/proposal-controller.ts` to provide the feature-graph tools to the agent.

Each tool call mutates only the in-memory proposal graph and is
recorded as an ordered graph-modification step that can later be
reviewed, approved, or rejected. The proposal should retain both
its resulting graph snapshot and the mutation log that produced it.

```typescript
// Tools exposed to the planner agent (see src/agents/tools/planner-toolset.ts)
const plannerTools = [
  'addMilestone',        // (AddMilestoneOptions) → Milestone
  'addFeature',          // (AddFeatureOptions) → Feature — requires milestoneId
  'removeFeature',       // (RemoveFeatureOptions) → void
  'editFeature',         // (EditFeatureOptions) → Feature — PlannerFeatureEditPatch
  'addTask',             // (AddTaskOptions) → Task — planner-baked payload, reservedWritePaths (deps via addDependency)
  'removeTask',          // (RemoveTaskOptions) → void
  'editTask',            // (EditTaskOptions) → Task — TaskEditPatch
  'setFeatureObjective', // (SetFeatureObjectiveOptions) → Feature
  'setFeatureDoD',       // (SetFeatureDoDOptions) → Feature
  'addDependency',       // (DependencyOptions) → void — validated immediately
  'removeDependency',    // (DependencyOptions) → void
  'submit',              // (SubmitProposalOptions) → void — finalize for approval
];
```

### Planner-baked task payload

`addTask` and `editTask` accept an optional planner-baked payload
so each task carries a fresh, typed brief that is written to the `tasks`
row on approval:

- `objective` — one-liner describing what the task must achieve.
- `scope` — boundary note describing what is in / out of scope.
- `expectedFiles` — list of files the task is expected to touch
  (subset of `reservedWritePaths`; reservations are still the scheduling contract).
- `references[]` — typed pointers (`file` / `knowledge` / `decision` / `url`)
  the task should consult. The planner cites knowledge/decisions here rather
  than relying on runtime to auto-inject them.
- `outcomeVerification` — how the worker should verify the task succeeded
  (commands to run, assertions to check).

### Feature-level objective and DoD

`setFeatureObjective` and `setFeatureDoD` let the planner record
feature-scope context once per feature. On approval these are written
to `features.feature_objective` and `features.feature_dod`. Verify
consumes them as the target spec; `buildTaskPayload` merges them into
each task's `TaskPayload` so workers see the feature-level goal alongside
their own objective.

The planner receives the spec text as its prompt
and must use these proposal tools to build the proposal graph.
Free-text rationale is not source of truth.
Planner and replanner call `submit()` exactly once when the proposal is complete.
The orchestrator watches the proposal graph evolve in real time
and may render that draft state in the TUI, but it does not apply
those mutations to the authoritative graph yet.
When the planner calls `submit()`, the proposal is stored in
`agent_runs.payload_json` and the planning run enters
`await_approval`.
If the user approves it, the orchestrator applies the recorded
mutation sequence to the authoritative graph, feature work control
moves from `planning` to `executing`, tasks with no unmet
in-feature dependencies become `ready`, and tasks that still
depend on other in-feature work remain `pending` until unblocked.
If the proposal is rejected, the authoritative graph stays
unchanged.

## Planning Heuristics

The planner should record a **reserved write-path set** for
each task: normalized file paths relative to the project root
that the task is expected to modify.
Exact file-path reservations are preferred.
Glob or directory reservations are allowed as an escape hatch
but are intentionally heavy-handed and should be used sparingly.
These reservations are path-level metadata, not file content,
and persist in `tasks.reserved_write_paths` as JSON-serialized
project-root-relative paths.
The orchestrator uses them to surface likely same-feature
collisions early, apply a heavy scheduling penalty to
cross-feature reservation overlap, inject only the relevant
paths into the execution prompt, and prime the write prehook
with the reservation set before runtime edits begin.

The planner should also put
**dependency-establishing work earlier in the chain**.
Tasks that define contracts, schemas, interfaces, shared types,
or other downstream prerequisites should appear near the front
of the feature-local DAG so later tasks can depend on them
explicitly.
In practice this means the planner should front-load
foundational work, express those relationships as task
dependencies, and let the scheduler exploit that structure
rather than burying prerequisite work late in the task list.

When those contracts are a **shared prerequisite for multiple
 downstream features**, the planner may split work into a
 dedicated **feature-interface** feature followed by one or more
 dependent implementation features.
This is useful when stabilizing the interface early will reduce
 downstream churn, hotspot-file contention, or parallel
 implementation risk.
It should not be the default split for one-off internal
scaffolding; if the contract only matters inside a single
feature, prefer early prerequisite tasks inside that feature
instead of creating an extra feature boundary.

For `add-milestone`, the planner receives the current graph
state (existing milestones/features as context) plus the new
spec, and adds to the existing graph.
