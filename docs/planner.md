# gsd2 Planner

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

The planner receives the spec text as its prompt and calls these tools to build the graph. The orchestrator watches the graph grow in real time and renders it in the TUI as it's constructed.

## Planning Heuristics

The planner should record an **expected write set** for each task as advisory metadata: the files or directories the task is likely to modify. This does not replace runtime file-lock detection, but it gives the orchestrator a chance to avoid dispatching obviously overlapping work in parallel and to reserve known hot files ahead of time. This is an intended planning aid, not yet a fully specified enforcement mechanism.

The planner should also put **dependency-establishing work earlier in the chain**. Tasks that define contracts, schemas, interfaces, shared types, or other downstream prerequisites should appear near the front of the feature-local DAG so later tasks can depend on them explicitly. In practice this means the planner should front-load foundational work, express those relationships as task dependencies, and let the scheduler exploit that structure rather than burying prerequisite work late in the task list.

For `add-milestone`, the planner receives the current graph state (existing milestones/features as context) plus the new spec, and adds to the existing graph.
