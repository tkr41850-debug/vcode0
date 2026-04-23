# Graph Operations

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for the high-level architecture overview.

## Graph Operations

### Core Mutations

| Operation | Description |
|---|---|
| **createMilestone(name, description)** | Create a new milestone for grouping / progress tracking metadata |
| **createFeature(milestoneId, name, deps)** | Create a feature under a milestone with feature→feature dependency edges |
| **createTask(featureId, description, deps?)** | Add a task to a feature with in-feature task deps only |
| **addDependency(fromId, toId)** | Add a dependency edge (`feature → feature` or `task → task` within the same feature). Edge kind is inferred from typed prefixed ids (`f-*`, `t-*`). |
| **removeDependency(fromId, toId)** | Remove a dependency edge |
| **splitFeature(featureId, subfeatures)** | Split a feature while it is still pre-execution and pre-branch (`workControl` is `discussing`, `researching`, or `planning`, and `collabControl = none`). Planned tasks on the source feature are discarded, and downstream feature deps are rewritten to the terminal split children. See [in-flight split/merge](../feature-candidates/in-flight-split-merge.md) for the deferred in-flight variant. |
| **mergeFeatures(featureIds, name)** | Merge multiple features while they are still pre-execution and pre-branch. Planned tasks on the source features are discarded, and downstream feature deps are rewritten to the retained merged feature. |
| **cancelFeature(featureId, cascade?)** | **User-facing soft abort.** Mark as cancelled (`collabControl → cancelled`), clear feature runtime block metadata, cancel feature-scoped and task-scoped runs, abort in-flight task runs, preserve existing task suspension metadata for worktree context, and optionally cancel transitive dependents when `cascade=true`. Preserves the feature, its tasks, and worktrees so state remains inspectable and the decision is reversible. Wired from TUI (`x` / `/cancel`) through `cancelFeatureRunWork` in `src/compose.ts`. |
| **removeFeature(featureId)** | **Destructive planner-only primitive.** Remove a feature, detach incoming feature deps, and remove its tasks and task deps. Reachable in production only through proposal approval; the proposal layer rejects the op when the feature has already started work or still has dependents (see `staleReasonForOp` in `src/core/proposals/index.ts`). The core mutation itself has no guard — the policy lives at the proposal boundary, not as an invariant in core, so any direct caller outside proposals must enforce the same check and coordinate runtime cleanup (worktrees, agent runs) itself. No user-facing kill path exists today; see [User Feature Kill](../feature-candidates/user-feature-kill.md) for the deferred candidate. |
| **changeMilestone(featureId, newMilestoneId)** | Reassign a feature to a different milestone without changing dependency semantics |
| **editFeature(featureId, patch)** | Update feature fields such as name, description, summary, or runtime block metadata |
| **addTask(featureId, description, deps?)** | Add a task to an existing feature. Core `AddTaskOptions` accepts inline `deps` plus optional `weight`, `reservedWritePaths`, `repairSource`, and planner-baked payload fields. The planner **tool** schema (`src/agents/tools/schemas.ts`) does not expose `deps` — planner flows declare edges via the separate `addDependency` tool. |
| **editTask(taskId, patch)** | Update task description, weight, or reserved write paths |
| **removeTask(taskId)** | Remove a task (only when status is `pending` or `cancelled`; other statuses must be cancelled first so worktree/run cleanup runs) |
| **reorderTasks(featureId, taskIds)** | Reorder tasks within a feature (affects display, not scheduling) |
| **reweight(taskId, weight)** | Update estimated cost/complexity — affects critical path calculation |
| **queueMilestone(milestoneId)** | Append a milestone to the scheduler steering queue |
| **dequeueMilestone(milestoneId)** | Remove a milestone from the scheduler steering queue |
| **clearQueuedMilestones()** | Clear milestone steering and return to autonomous scheduling |
| **replaceUsageRollups(patch)** | Replace persisted task/feature token-usage aggregates in one patch |

### Validation

Every mutation must preserve DAG invariants:
- **No cycles** — topological sort must succeed after mutation
- **Feature deps are feature-only** — milestones do not appear in dependency edges
- **Task deps are same-feature only** — a task may depend only on tasks with the same `featureId`
- **Typed ID namespaces** — milestone ids are `m-*`, feature ids are `f-*`, and task ids are `t-*`
- **One milestone per feature** — milestones group features but do not alter DAG semantics
- **Child-owned order** — `Feature.orderInMilestone` and `Task.orderInFeature` define sibling order; parent collections are derived views
- **Referential integrity** — no dangling dependency edges
- **Status consistency** — can't add tasks to a cancelled/done feature

```typescript
interface FeatureGraph {
  readonly milestones: Map<MilestoneId, Milestone>;
  readonly features: Map<FeatureId, Feature>;
  readonly tasks: Map<TaskId, Task>;

  // Snapshot / hydration
  snapshot(): GraphSnapshot;

  // Core queries
  readyFeatures(): Feature[];           // dispatchable feature phases (pre/post execution, deps merged, not owned by merge-train/conflict)
  readyTasks(): Task[];                 // dispatchable tasks (status=ready, deps done, not suspended/conflict, feature not cancelled)
  queuedMilestones(): Milestone[];      // ordered user steering queue
  isComplete(): boolean;                // all features completed and merged
  // Critical path lives in core/scheduling (buildCombinedGraph + computeGraphMetrics)

  // Structural mutations (all validate invariants before applying)
  createMilestone(opts: CreateMilestoneOptions): Milestone;
  createFeature(opts: CreateFeatureOptions): Feature;
  createTask(opts: CreateTaskOptions): Task;
  addDependency(opts: DependencyOptions): void;
  removeDependency(opts: DependencyOptions): void;
  splitFeature(id: FeatureId, splits: SplitSpec[]): Feature[];   // pre-execution and pre-branch only; planned tasks are discarded
  mergeFeatures(featureIds: FeatureId[], name: string): Feature;  // pre-execution and pre-branch only; planned tasks are discarded
  cancelFeature(featureId: FeatureId, cascade?: boolean): void;
  removeFeature(featureId: FeatureId): void;
  changeMilestone(featureId: FeatureId, newMilestoneId: MilestoneId): void;
  editFeature(featureId: FeatureId, patch: FeatureEditPatch): Feature;
  addTask(opts: AddTaskOptions): Task;
  editTask(taskId: TaskId, patch: TaskEditPatch): Task;
  removeTask(taskId: TaskId): void;
  reorderTasks(featureId: FeatureId, taskIds: TaskId[]): void;
  reweight(taskId: TaskId, weight: TaskWeight): void;
  queueMilestone(id: MilestoneId): void;
  dequeueMilestone(id: MilestoneId): void;
  clearQueuedMilestones(): void;

  // FSM-validated transitions
  transitionFeature(featureId: FeatureId, patch: FeatureTransitionPatch): void;
  transitionTask(taskId: TaskId, patch: TaskTransitionPatch): void;

  // Merge-train metadata (used by MergeTrainCoordinator)
  updateMergeTrainState(featureId: FeatureId, fields: MergeTrainUpdate): void;
  replaceUsageRollups(patch: UsageRollupPatch): void;
}
```

## Orchestrator Coordination Model

> **Implementation status**: The coordination model below is partly architectural and partly already implemented. Current code includes the scheduler tick loop, combined-graph construction, graph metrics, ready-work prioritization, FSM transition validators, and baseline pre-execution `splitFeature()` / `mergeFeatures()` mutations. Future extensions called out explicitly as candidates remain deferred.

The orchestrator uses a **hybrid serial core with async feature phases** (Direction D). All state-mutating coordination flows through a single serial event queue, while feature-phase agent runs (planning, verifying, summarizing, replanning) execute asynchronously and post results back as events. Those feature phases are not a separate execution plane: architecturally they share the same run/session model as task execution (`agent_runs`, `session_id`, retry/backoff, help/approval/manual waits, and recovery), even if the current concrete runtime implementation reaches them through a different adapter surface.

### Serial Event Queue

All orchestrator mutations flow through a single FIFO queue. Each event is processed to completion before the next starts. This eliminates concurrency races without locking or CAS complexity.

Event sources:
- **Worker IPC messages**: task results, errors, progress, help requests, approval requests, assistant output — arrive asynchronously from worker processes and are enqueued.
- **Feature-phase completions**: planning/verifying/summarizing/replanning agents run async and post result or error events back into the queue.
- **Shutdown signal**: triggers graceful stop of the scheduler loop.

### Tick Phases

Each scheduler tick processes the event queue and dispatches new work:

```
1. Drain events     — dequeue all pending events, process each serially
2. Update state     — apply state transitions (validated by core/fsm guards)
3. Check conflicts  — detect reservation overlaps (runtime overlaps are push-based via write prehook)
4. Compute frontier — build combined graph, compute metrics, find ready work
5. Sort             — apply priority ordering to ready work
6. Dispatch         — send work to available workers via RuntimePort
```

### Conflict Detection Timing

Overlap detection uses two layers:

- **Reservation overlap** (tick-based): On each scheduler tick, the scheduler checks write-path reservations of ready work against running tasks. This is a scheduling-time penalty, not a hard block. Detection latency is bounded by the tick interval, which is acceptable for the local-machine baseline because task worktrees isolate blast radius.
- **Runtime overlap** (push-based): When a task attempts to write a file, the write prehook tries to claim an active path lock through the orchestrator. If the path is already locked by another task, the incident is routed into the normal coordination flow immediately. See [conflict-coordination](../operations/conflict-coordination.md) and [worker-model](./worker-model.md) for the write-prehook mechanics.

Additional reservation-level detection could be made push-based in the future. See [push-based conflict detection](../optimization-candidates/push-based-conflict-detection.md) for that optimization candidate.

### State Transition Guards

State transitions are validated by pure guard functions in `core/fsm/` before being applied. Guards check both axes (work-control and collab-control) together — for example, `executing → ci_check` must satisfy the feature composite guard. SQL constraint hardening may be added later as a safety net but does not replace the orchestrator guards.

### Feature-Phase Concurrency

Feature-phase agent runs do not block the tick. When the scheduler decides a feature needs planning, verification, or summarization, it dispatches the phase agent and continues processing. The phase agent posts a completion or error event back into the queue, which a future tick processes to advance the feature lifecycle.

This means:
- Multiple features can have active planning/verification/summarization concurrently.
- Task execution and feature-phase work share the same worker pool and compete for the same slots.
- The tick loop never awaits a feature-phase result inline.

## Load Balancing: Combined Critical Path

### Combined Feature+Task Graph

Critical path weights are computed over a **virtual combined graph** that spans both feature and task DAG layers, not just the task DAG in isolation. This ensures that a task blocking a downstream feature correctly reflects the full weight of that feature's downstream work.

The combined graph is constructed as a derived view:
- Features in pre-execution phases (discussing, researching, planning) appear as single weighted nodes with estimated weight.
- Features in executing state expand to their concrete task nodes.
- Feature→feature dependency edges route through terminal tasks of the upstream feature to root tasks of the dependent feature.
- Feature-phase nodes (verify, summarize) appear as virtual nodes with edges to/from their feature's tasks.

After each graph mutation, recompute the combined graph.

### Graph Metrics

Two O(V+E) passes over the combined DAG:

- **Max depth** (reverse topological DP): each node's weight = own weight + max(successor weights). This is the critical path weight — higher values mean more downstream work depends on this node. Used as the primary scheduling metric.
- **Longest predecessor distance** (forward topological DP): each node's distance = max(distance(pred) + pred.weight). Estimates how much predecessor work must complete before a node becomes reachable. Available for future metrics and TUI predictions.

```typescript
interface CombinedGraphNode {
  id: string;             // synthetic namespaced ID (virtual:f-1, virtual:f-1:post, task:f-1:t-1)
  weight: number;         // estimated or actual weight
  type: 'virtual' | 'task';
  featureId: FeatureId;
  taskId?: TaskId;        // present when type is 'task'
  successors: string[];   // downstream node ids
  predecessors: string[]; // upstream node ids
}

interface CombinedGraph {
  nodes: Map<string, CombinedGraphNode>;
}

interface NodeMetrics {
  maxDepth: number;       // critical path weight (reverse DP)
  distance: number;       // longest predecessor distance (forward DP)
}

interface GraphMetrics {
  nodeMetrics: Map<string, NodeMetrics>;
}

function buildCombinedGraph(graph: FeatureGraph): CombinedGraph;
function computeGraphMetrics(combinedGraph: CombinedGraph): GraphMetrics;
```

### Work-Type Priority Tiers

A work-type tier sort key sits between milestone position and critical path weight. It groups `AgentRunPhase` values into scheduling priority buckets:

| Tier | Priority | Phases | Rationale |
|------|----------|--------|-----------|
| 1 (highest) | verify | `verify`, `ci_check` | Closest to feature completion; unblocks merge queue |
| 2 | execute | `execute` | Makes progress on planned work; non-tail tasks naturally sort above tail tasks by critical path weight |
| 3 | plan | `plan`, `discuss`, `research`, `replan` | Starts new feature work; produces future tasks |
| 4 (lowest) | summarize | `summarize` | Post-merge; blocks nothing |

The principle: **prefer completing features over starting new ones**.

### Scheduling Priority Order

When workers are scarce, ready work is sorted by:

| Sort Key | Source | Direction |
|----------|--------|-----------|
| 1. Milestone queue position | `queuedMilestones()` | Lower position first |
| 2. Work-type tier | `workTypeTierOf(phase)` | Higher tier first |
| 3. Critical path weight | Combined graph max depth | Higher weight first |
| 4. Partially-failed deprioritization | Feature derived status | Non-failed first |
| 5. Reservation overlap penalty | Write-path intersection | Non-overlapping first |
| 6. Retry-eligible before fresh | `run.runStatus === 'retry_await' && retryAt <= now` | Retry first |
| 7. Stable fallback | age (when the unit became ready, tracked by scheduler) | Older first |

When workers are plentiful, everything ready runs.

Work whose milestone is not queued falls into the `∞` bucket, so it still runs when higher-priority queued buckets do not supply enough runnable work.

Tasks whose execution run is currently `await_response` or `await_approval` are not dispatchable and should surface as derived `blocked` UI state instead. A run in `retry_await` is not dispatchable before `retryAt`, but becomes eligible again once that backoff window expires.

### Cross-Milestone Dependency Handling

When a feature in a higher-priority milestone is blocked by an incomplete feature in a lower-priority milestone, the scheduler pulls the blocking feature's work forward (dependency satisfaction overrides milestone ordering). This also emits a scheduling priority warning, because milestone priority inversion suggests the milestone decomposition may need revision. See [warnings](../operations/warnings.md).

### Schedulable Units

The scheduler operates on a unified dispatch abstraction that covers both task execution and feature-phase agent work:

```typescript
type SchedulableUnit =
  | { kind: 'task'; task: Task; featureId: FeatureId }
  | { kind: 'feature_phase'; feature: Feature; phase: AgentRunPhase };
```

Both kinds compete for the same worker pool and follow the same priority ordering. The scheduler computes a single merged frontier of ready work from both task readiness (DAG + run status + overlap) and feature-phase readiness (lifecycle state + dependency completion).

## Scheduler Loop

```typescript
type SchedulerEvent =
  | { type: 'worker_message'; message: WorkerToOrchestratorMessage }
  | { type: 'feature_phase_complete'; featureId: FeatureId; phase: AgentRunPhase; summary: string; issues?: VerifyIssue[] }
  | { type: 'feature_phase_error'; featureId: FeatureId; phase: AgentRunPhase; error: string }
  | { type: 'shutdown' };

async function schedulerLoop(
  graph: FeatureGraph,
  ports: OrchestratorPorts,
  events: SchedulerEvent[],
) {
  while (!graph.isComplete()) {
    // 1. Drain events
    while (events.length > 0) {
      const event = events.shift()!;
      if (event.type === 'shutdown') return;

      if (event.type === 'worker_message') {
        // Update graph/run state based on worker result, error, or request
        handleWorkerMessage(graph, ports.store, event.message);
      } else if (event.type === 'feature_phase_complete') {
        // Advance feature lifecycle (e.g., planning → executing)
        advanceFeatureLifecycle(graph, ports.store, event.featureId, event.phase, event.summary);
      } else if (event.type === 'feature_phase_error') {
        handleFeaturePhaseError(graph, ports.store, event.featureId, event.phase, event.error);
      }
    }

    // 2. Check reservation overlaps (runtime overlaps are push-based via write prehook)
    detectReservationOverlaps(graph, ports);

    // 3. Compute frontier and sort
    const now = Date.now();
    const combinedGraph = buildCombinedGraph(graph);
    const metrics = computeGraphMetrics(combinedGraph);
    const ready = prioritizeReadyWork(graph, runs, metrics, now);

    // 4. Dispatch to available workers
    for (const unit of ready.slice(0, idleWorkerCount)) {
      if (unit.kind === 'task') {
        // Look up or create the execution run record for this task
        // Build dispatch payload (start or resume) from run state
        const dispatch: TaskRuntimeDispatch = { mode: 'start', agentRunId: run.id };
        const result = await ports.runtime.dispatchTask(unit.task, dispatch);

        if (result.kind === 'not_resumable') {
          // Fall back to fresh start on next tick
          continue;
        }

        // Mark run as running in the store
        await ports.store.updateAgentRun(run.id, { runStatus: 'running' });
      } else {
        // Dispatch feature-phase agent work (planning, verifying, etc.)
        // Phase agent runs async; result posts back as SchedulerEvent
      }
    }

    // 5. Wait for next event or tick interval
    await waitForEventOrTimeout(events);
  }
}
```

This pseudocode illustrates the intended tick model. API homes for the pseudocode variables: `runs` → `Store.listAgentRuns()` / `Store.getAgentRun()`, `run` creation → `Store.createAgentRun()`, run updates → `Store.updateAgentRun()`, and `idleWorkerCount` → `RuntimePort.idleWorkerCount()`. The actual implementation will be a `SchedulerLoop` class with an `enqueue()` method for posting events and `run()`/`stop()` for lifecycle control.

Planner note: this works best when prerequisite-shaping tasks
(schemas, interfaces, shared contracts,
generated sources of truth) are placed near the front of the
chain and expressed as explicit dependencies.
Front-loading dependency-establishing work makes the critical
path more faithful to real downstream constraints.

Where a contract is a real upstream dependency for multiple
later features, that front-loading may justify splitting the
plan into a dedicated interface feature plus dependent
implementation features.
Where the contract is only internal scaffolding for one feature,
keep it as early tasks inside the same feature rather than
paying extra merge-train and verification overhead for a
premature feature split.

## Collaboration Control: Merge Train

Completed feature branches do not merge directly to `main`. Instead, merge-train ordering remains feature-owned: queue eligibility and ordering derive from feature merge-train fields plus dependency legality and current milestone steering context.

### Invariant: `main` is never in a bad state

The merge train exists to protect `main`. A feature branch only updates `main` after it has rebased onto the current `main`, run merge-train verification against that rebased state, and passed. If rebase fails or verification fails, the feature is ejected from the queue (`integrating → branch_open`, `mergeTrainReentryCount` increments) and repair work lands on the feature branch before it may re-queue. `main` never advances to a state that has not passed merge-train verification at its post-rebase tip.

Queue rules:
1. Only features whose feature deps are already merged to `main` may integrate.
2. User-queued milestones steer scheduler selection before
   feature work reaches the merge train; they do not bypass
   dependency legality, and multiple queued milestones are
   compared by queue position.
3. Once features enter the integration queue, ordering is
   serialized and based on dependency legality plus queue policy;
   milestone steering does not automatically define merge
   ordering.
4. Baseline manual merge-train steering is intentionally limited
   to a simple override bucket: explicitly ordered queued features
   sort first by `mergeTrainManualPosition`, and the remaining queued features
   use automatic priority (`mergeTrainReentryCount` desc, then current queue
   entry order via `mergeTrainEnteredAt` / `mergeTrainEntrySeq`). Fully arbitrary
   persistent manual ordering is deferred as a feature candidate
   because it adds persistence/update complexity. See
   [Feature Candidate: Arbitrary Merge-Train Manual Ordering](../feature-candidates/arbitrary-merge-train-manual-ordering.md).
5. The queue head rebases onto the latest `main`,
   runs merge-train verification, and either merges or is
   removed from the queue for repair work on the same
   feature branch.
6. Cross-feature conflicts are surfaced here,
   not by task-level file resets.
   Reservation overlap only penalizes scheduling;
   runtime overlap uses the feature-pair coordination protocol
   described in [conflict coordination](../operations/conflict-coordination.md).
