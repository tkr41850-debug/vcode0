# gsd2 Graph Operations

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the high-level architecture index.

## Graph Operations

### Core Mutations

| Operation | Description |
|---|---|
| **createMilestone(name, description)** | Create a new milestone |
| **createFeature(milestoneId, name, deps)** | Create a feature under a milestone with dependency edges |
| **createTask(featureId, description, deps?)** | Add a task to a feature |
| **addDependency(fromId, toId)** | Add a dependency edge (feature→feature, feature→milestone, or task→task) |
| **removeDependency(fromId, toId)** | Remove a dependency edge |
| **splitFeature(featureId, subfeatures)** | Break a feature into subfeatures: original keeps its deps but loses its tasks, new subfeatures take the tasks and depend on original's deps. Original becomes a virtual aggregate (like a mini-milestone) |
| **mergeFeatures(featureIds, name)** | Combine features into one. Union of deps and tasks. Redirect incoming edges |
| **cancelFeature(featureId, cascade?)** | Mark as cancelled. If cascade=true, cancel all transitive dependents |
| **changeMilestone(featureId, newMilestoneId)** | Reassign a feature to a different milestone |
| **editFeature(featureId, patch)** | Update name, description, or task list of a feature |
| **addTask(featureId, description, deps?)** | Add a task to an existing feature |
| **removeTask(taskId)** | Remove a task (only if pending) |
| **reorderTasks(featureId, taskIds)** | Reorder tasks within a feature (affects display, not scheduling) |
| **reweight(taskId, weight)** | Update estimated cost/complexity — affects critical path calculation |

### Validation

Every mutation must preserve DAG invariants:
- **No cycles** — topological sort must succeed after mutation
- **One milestone per feature** — moveFeature enforces this
- **Referential integrity** — no dangling dependency edges
- **Status consistency** — can't add tasks to a cancelled/done feature

```typescript
interface FeatureGraph {
  milestones: Map<string, Milestone>;
  features: Map<string, Feature>;
  tasks: Map<string, Task>;

  // Core queries
  readyFeatures(): Feature[];           // features whose deps are all done
  readyTasks(): Task[];                 // tasks whose deps are all done AND feature is ready
  criticalPath(): Task[];               // longest weighted path through the DAG
  isComplete(): boolean;                // all milestones done

  // Mutations (all validate invariants before applying)
  createFeature(opts: CreateFeatureOpts): Feature;
  splitFeature(id: string, splits: SplitSpec[]): Feature[];
  addDependency(from: string, to: string): void;
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
            // Orchestrator schedules retry via retry.ts (exponential backoff)
            // or marks blocked after maxConsecutiveFailures
          }
        )
      );
    }

    // Unblocks as soon as ANY dispatched task completes → immediate re-evaluation
    if (dispatched.length > 0) {
      await Promise.race(dispatched);
    } else {
      // All tasks blocked or running — wait for any running task to finish
      await pool.waitForAnyCompletion();
    }
  }
}
```
