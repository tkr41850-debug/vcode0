# Graph Operations

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the high-level architecture index.

## Graph Operations

### Core Mutations

| Operation | Description |
|---|---|
| **createMilestone(name, description)** | Create a new milestone for grouping / progress tracking metadata |
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
| **queueMilestone(milestoneId)** | Append a milestone to the scheduler steering queue |
| **dequeueMilestone(milestoneId)** | Remove a milestone from the scheduler steering queue |
| **clearQueuedMilestones()** | Clear milestone steering and return to autonomous scheduling |
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
  queuedMilestones(): Milestone[];      // ordered user steering queue
  isComplete(): boolean;                // all milestones done

  // Mutations (all validate invariants before applying)
  createFeature(opts: CreateFeatureOpts): Feature;
  splitFeature(id: string, splits: SplitSpec[]): Feature[];
  addDependency(from: string, to: string): void;
  queueMilestone(id: string): void;
  dequeueMilestone(id: string): void;
  clearQueuedMilestones(): void;
  enqueueFeatureMerge(id: string): void;
  // ... etc
}
```

## Load Balancing: Critical-Path-First

The scheduler normally prioritizes tasks on the longest weighted path through the DAG. This minimizes total wall-clock time by ensuring bottleneck chains start as early as possible. If users queue milestones, that becomes an ordered steering override: among ready work, earlier queued milestones sort ahead of later queued milestones, while dependency legality and in-feature task constraints still apply.

Reservation-only cross-feature overlap does not hard-block ready work, but it does apply a heavy scheduling penalty. In practice this means work whose reserved write paths overlap with another active feature should run only when higher-priority non-overlapping ready work is unavailable. Hard runtime overlap detected by the write prehook or actual git state is handled separately by the cross-feature overlap protocol.

```typescript
function prioritizeReadyTasks(graph: FeatureGraph): Task[] {
  const ready = graph.readyTasks();
  const criticalWeights = computeCriticalPathWeights(graph);
  const queuedMilestones = graph.queuedMilestones();
  const queuePos = new Map(queuedMilestones.map((m, i) => [m.id, i]));

  return ready.sort((a, b) => {
    const aQueuePos = queuePos.get(milestoneIdOf(graph, a)) ?? Infinity;
    const bQueuePos = queuePos.get(milestoneIdOf(graph, b)) ?? Infinity;
    if (aQueuePos !== bQueuePos) return aQueuePos - bQueuePos;

    const weightDiff = criticalWeights.get(b.id)! - criticalWeights.get(a.id)!;
    if (weightDiff !== 0) return weightDiff;

    return readySince(a) - readySince(b); // stable fallback
  });
}

// Critical path weight = task's own weight + max weight of any downstream path
function computeCriticalPathWeights(graph: FeatureGraph): Map<string, number> {
  // Reverse topological traversal, memoized
  // ...
}
```

When workers are scarce, earlier queued milestones win first, then critical-path weight inside each queue-position bucket. Work whose milestone is not queued falls into the `∞` bucket, so it still runs when higher-priority queued buckets do not supply enough runnable work. When workers are plentiful, everything ready runs.

Planner note: this works best when prerequisite-shaping tasks (schemas, interfaces, shared contracts, generated sources of truth) are placed near the front of the chain and expressed as explicit dependencies. Front-loading dependency-establishing work makes the critical path more faithful to real downstream constraints.

Where a contract is a real upstream dependency for multiple later features, that front-loading may justify splitting the plan into a dedicated interface feature plus dependent implementation features. Where the contract is only internal scaffolding for one feature, keep it as early tasks inside the same feature rather than paying extra merge-train and verification overhead for a premature feature split.

## Collaboration Control: Merge Train

Completed feature branches do not merge directly to `main`. Instead, they enter a serialized integration queue.

```typescript
interface IntegrationQueueEntry {
  featureId: string;
  branchName: string;
  queuedMilestonePositions?: number[]; // snapshot of steering context before merge queueing
  manualPosition?: number;             // present only for the manual override bucket
  enteredAt: number;
  entrySeq: number;
  reentryCount: number;
}
```

Queue rules:
1. Only features whose feature deps are already merged to `main` may integrate.
2. User-queued milestones steer scheduler selection before feature work reaches the merge train; they do not bypass dependency legality, and multiple queued milestones are compared by queue position.
3. Once features enter the integration queue, ordering is serialized and based on dependency legality plus queue policy; milestone steering does not automatically define merge ordering.
4. Baseline manual merge-train steering is intentionally limited to a simple override bucket: explicitly ordered queued features sort first by `manualPosition`, and the remaining queued features use automatic priority (`reentryCount` desc, then current queue entry order via `enteredAt` / `entrySeq`). Fully arbitrary persistent manual ordering is deferred as a feature candidate because it adds persistence/update complexity. See [Feature Candidate: Arbitrary Merge-Train Manual Ordering](./feature-candidates/arbitrary-merge-train-manual-ordering.md).
5. The queue head rebases onto the latest `main`, runs merge-train verification, and either merges or is removed from the queue for repair work on the same feature branch.
6. Cross-feature conflicts are surfaced here, not by task-level file resets. Reservation overlap only penalizes scheduling; runtime overlap uses the feature-pair coordination protocol described in [file-lock-conflict-resolution.md](./file-lock-conflict-resolution.md).

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
