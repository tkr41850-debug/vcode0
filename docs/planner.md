# Planner

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the high-level architecture index.

## Planner: Tool-Call Output Format

The planner is a pi-sdk `Agent` with access to the feature-graph mutation tools. It builds the DAG incrementally via tool calls rather than emitting a JSON blob. This means the graph is validated as it's constructed (no cycles, referential integrity) and the planner can reason step-by-step.

```typescript
// Tools exposed to the planner agent
const plannerTools: AgentTool[] = [
  createMilestoneTool,   // createMilestone(name, description) → Milestone
  createFeatureTool,     // createFeature(milestoneId, name, description, dependsOn[]) → Feature
  createTaskTool,        // createTask(featureId, description, dependsOn[]) → Task
  addDependencyTool,     // addDependency(fromId, toId) → void
  submitPlanTool,        // submit() → signals planner is done
];
```

The planner receives the spec text as its prompt and calls these tools to build the graph. The orchestrator watches the graph grow in real time and renders it in the TUI as it's constructed. When the planner calls `submit()`, planning for that feature closes, feature work control moves from `planning` to `executing`, tasks with no unmet in-feature dependencies become `ready`, and tasks that still depend on other in-feature work remain `pending` until unblocked.

## Planning Heuristics

The planner should record a **reserved write-path set** for each task: normalized file paths relative to the project root that the task is expected to modify. Exact file-path reservations are preferred. Glob or directory reservations are allowed as an escape hatch but are intentionally heavy-handed and should be used sparingly. These reservations are path-level metadata, not file content, and persist in `tasks.reserved_write_paths` as JSON-serialized project-root-relative paths. The orchestrator uses them to surface likely same-feature collisions early, apply a heavy scheduling penalty to cross-feature reservation overlap, inject only the relevant paths into the execution prompt, and prime the write prehook with the reservation set before runtime edits begin.

The planner should also put **dependency-establishing work earlier in the chain**. Tasks that define contracts, schemas, interfaces, shared types, or other downstream prerequisites should appear near the front of the feature-local DAG so later tasks can depend on them explicitly. In practice this means the planner should front-load foundational work, express those relationships as task dependencies, and let the scheduler exploit that structure rather than burying prerequisite work late in the task list.

When those contracts are a **shared prerequisite for multiple downstream features**, the planner may split work into a dedicated **feature-interface** feature followed by one or more dependent implementation features. This is useful when stabilizing the interface early will reduce downstream churn, hotspot-file contention, or parallel implementation risk. It should not be the default split for one-off internal scaffolding; if the contract only matters inside a single feature, prefer early prerequisite tasks inside that feature instead of creating an extra feature boundary.

For `add-milestone`, the planner receives the current graph state (existing milestones/features as context) plus the new spec, and adds to the existing graph.
