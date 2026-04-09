# test_graph_contracts

## Goal

Capture the contract of `FeatureGraph` as the authoritative mutable DAG surface and read model for milestones, features, tasks, and integration queue state.

## Scenarios

### Snapshot reflects the current authoritative graph state
- Given milestones, features, tasks, dependencies, and merge-queue entries exist in the graph
- When `snapshot()` is requested
- Then the returned `GraphSnapshot` contains the current graph contents needed to persist or reload the model
- And it reflects the same authoritative state represented by the in-memory milestone, feature, and task maps

### Invalid mutations reject without partial graph corruption
- Given a requested graph mutation would violate a graph invariant
- When the mutation is applied through the `FeatureGraph` surface
- Then the operation is rejected with `GraphValidationError`
- And the graph remains in its previously valid state
- And no partial dependency, task, or feature edits leak through

### Readiness views are derived from the current DAG
- Given some features or tasks still have unresolved dependencies while others are clear to run
- When `readyFeatures()` or `readyTasks()` is evaluated
- Then each method returns only the units currently unblocked by the graph
- And those views update after graph mutations rather than remaining stale snapshots

### Critical path is recomputed from the current task graph
- Given task weights or dependencies change within a feature
- When `criticalPath()` is evaluated again
- Then the returned path reflects the current task graph rather than an outdated earlier ordering
- And scheduling code can treat it as a derived view over the authoritative graph state

### Integration queue and queued milestones are explicit graph views
- Given milestones have been queued and features have been enqueued for merge
- When `queuedMilestones()` or `integrationQueue()` is read
- Then those methods expose the current explicit queue state
- And queue membership is not inferred solely from generic feature completion

### Completion and milestone queue reset are derived graph operations
- Given the graph still has incomplete work and explicit milestone steering may already be queued
- When `isComplete()` or `clearQueuedMilestones()` is invoked
- Then `isComplete()` reflects the current graph state rather than a stale cached answer
- And `clearQueuedMilestones()` removes explicit milestone steering without mutating the dependency graph or merge queue itself

### Feature and task mutation APIs preserve containment rules
- Given a caller creates, edits, splits, merges, reorders, or removes graph units through `FeatureGraph`
- When the mutation succeeds
- Then feature-level changes preserve the feature DAG model
- And task-level changes remain scoped to the owning feature rather than creating cross-feature task structure
