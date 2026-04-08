# gsd2 Graph Operations

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the high-level architecture index.

## Graph Operations

### Core Mutations

| Operation | Description |
|---|---|
| **createMilestone(name, description)** | Create a new milestone for grouping / priority metadata |
| **createFeature(milestoneId, name, deps)** | Create a feature under a milestone with feature→feature dependency edges |
| **createTask(featureId, description, deps?)** | Add a task to a feature with in-feature task deps only |
| **addDependency(fromId, toId)** | Add a dependency edge (`feature → feature` or `task → task` within the same feature) |
| **removeDependency(fromId, toId)** | Remove a dependency edge |
| **splitFeature(featureId, subfeatures)** | Break a feature into smaller features; redistribute work when replanning |
| **mergeFeatures(featureIds, name)** | Combine features into one. Union of deps and tasks. Redirect incoming edges |
| **cancelFeature(featureId, cascade?)** | Mark as cancelled. If cascade=true, cancel all transitive dependents |
| **changeMilestone(featureId, newMilestoneId)** | Reassign a feature to a different milestone without changing dependency semantics |
| **editFeature(featureId, patch)** | Update name, description, or task list of a feature |
| **addTask(featureId, description, deps?)** | Add a task to an existing feature |
| **removeTask(taskId)** | Remove a task (only if pending) |
| **reorderTasks(featureId, taskIds)** | Reorder tasks within a feature (affects display, not scheduling) |
| **reweight(taskId, weight)** | Update estimated cost/complexity — affects critical path calculation |
| **enqueueFeatureMerge(featureId)** | Add a completed feature branch to the serialized integration queue |

### Validation

Every mutation must preserve DAG invariants:
- **No cycles** — topological sort must succeed after mutation
- **Feature deps are feature-only** — milestones do not appear in dependency edges
- **Task deps are same-feature only** — a task may depend only on tasks with the same `featureId`
- **One milestone per feature** — milestones group features but do not alter DAG semantics
- **Referential integrity** — no dangling dependency edges
- **Status consistency** — can't add tasks to a cancelled/done feature

```typescript
interface FeatureGraph {
  milestones: Map<string, Milestone>;
  features: Map<string, Feature>;
  tasks: Map<string, Task>;

  // Core queries
  readyFeatures(): Feature[];           // features whose feature deps are all done
  readyTasks(): Task[];                 // tasks whose in-feature deps are all done
  criticalPath(): Task[];               // longest weighted path through the task DAG
  integrationQueue(): Feature[];        // features waiting to merge into main
  isComplete(): boolean;                // all milestones done

  // Mutations (all validate invariants before applying)
  createFeature(opts: CreateFeatureOpts): Feature;
  splitFeature(id: string, splits: SplitSpec[]): Feature[];
  addDependency(from: string, to: string): void;
  enqueueFeatureMerge(id: string): void;
  // ... etc
}
```

## Load Balancing: Critical-Path-First

The scheduler prioritizes tasks on the longest weighted path through the DAG. This minimizes total wall-clock time by ensuring bottleneck chains start as early as possible.

```typescript
function prioritizeReadyTasks(graph: FeatureGraph): Task[] {
  const ready = graph.readyTasks();
  const criticalWeights = computeCriticalPathWeights(graph);

  // Sort by: milestone priority (asc), then critical path weight (desc)
  return ready.sort((a, b) => {
    const mA = milestonePriority(graph, a);
    const mB = milestonePriority(graph, b);
    if (mA !== mB) return mA - mB;
    return criticalWeights.get(b.id)! - criticalWeights.get(a.id)!;
  });
}

// Critical path weight = task's own weight + max weight of any downstream path
function computeCriticalPathWeights(graph: FeatureGraph): Map<string, number> {
  // Reverse topological traversal, memoized
  // ...
}
```

When workers are scarce, critical-path tasks win. When workers are plentiful, everything ready runs.

Planner note: this works best when prerequisite-shaping tasks (schemas, interfaces, shared contracts, generated sources of truth) are placed near the front of the chain and expressed as explicit dependencies. Front-loading dependency-establishing work makes the critical path more faithful to real downstream constraints.

## Collaboration Control: Merge Train

Completed feature branches do not merge directly to `main`. Instead, they enter a serialized integration queue.

```typescript
interface IntegrationQueueEntry {
  featureId: string;
  branchName: string;
  milestonePriority: number;
  enqueuedAt: number;
}
```

Queue rules:
1. Only features whose feature deps are already merged to `main` may integrate.
2. Queue order is based on dependency legality first, then milestone priority, then FIFO.
3. The queue head rebases onto the latest `main`, runs integration checks, and either merges or enters `conflict` collaboration control.
4. Cross-feature conflicts are surfaced here, not by task-level file resets. The exact classification and escalation behavior remains tentative and likely complex.

## Scheduler Loop

```typescript
async function schedulerLoop(graph: FeatureGraph, pool: WorkerPool, store: Store) {
  while (!graph.isComplete()) {
    const ready = prioritizeReadyTasks(graph);
    const idle = pool.idleWorkers();

    const toDispatch = ready.slice(0, idle.length);
    const dispatched: Promise<void>[] = [];

    for (let i = 0; i < toDispatch.length; i++) {
      const task = toDispatch[i];
      const worker = idle[i];
      graph.markRunning(task.id);
      store.updateTask(task.id, { status: "running", workerId: worker.id });

      dispatched.push(
        worker.run(task, buildWorkerContext(graph, task)).then(
          (result) => {
            graph.markDone(task.id, result);
            store.updateTask(task.id, { status: "done", result });
            propagateFeatureStatus(graph, task.featureId, store);
          },
          (err) => {
            graph.markFailed(task.id, err);
            store.updateTask(task.id, { status: "failed", error: err.message });
            // Orchestrator schedules retry via retry.ts
            // or marks the task stuck and the feature replanning
          }
        )
      );
    }

    if (dispatched.length > 0) {
      await Promise.race(dispatched);
    } else {
      await pool.waitForAnyCompletion();
    }
  }
}
```
