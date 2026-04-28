# test_graph_contracts

## Goal

Capture the contract of `FeatureGraph` as the authoritative mutable DAG surface and read model for milestones, features, tasks, and milestone steering state.

## Scenarios

### Recovery/load state reflects the current authoritative graph state
- Given milestones, features, tasks, and dependencies exist in the graph
- When the graph is loaded for persistence or recovery
- Then the resulting graph state contains the current graph contents needed to persist or reload the model
- And it reflects the same authoritative state represented by the in-memory milestone, feature, and task maps

### Invalid mutations reject without partial graph corruption
- Given a requested graph mutation would violate a graph invariant
- When the mutation is applied through the `FeatureGraph` surface
- Then the operation is rejected with `GraphValidationError`
- And the graph remains in its previously valid state
- And no partial dependency, task, or feature edits leak through

### Readiness views return graph-ready work
- Given some features or tasks still have unresolved dependencies while others are clear to run
- When `readyFeatures()` or `readyTasks()` is evaluated
- Then each method returns only units whose graph state is ready: dependencies satisfied, owning feature not cancelled, and local lifecycle state eligible before later scheduler/run-state filtering
- And those views update after graph mutations rather than remaining stale snapshots

### Graph metrics are derived by the scheduling module
- Given task weights or dependencies change within a feature
- When `buildCombinedGraph()` and `computeGraphMetrics()` from `@core/scheduling` are evaluated
- Then the resulting metrics (max depth, longest weighted predecessor distance) reflect the current graph state
- And the scheduling module treats these as derived views over the authoritative `FeatureGraph`
- Note: tested via `test_scheduler_frontier_priority.md` scenarios rather than graph contract tests

### Queued milestones are explicit graph views
- Given milestones have been queued and features may be ready for merge
- When `queuedMilestones()` is read
- Then it exposes the current explicit milestone steering state
- And merge-train eligibility is not inferred solely from generic feature completion

### Completion and milestone queue reset are derived graph operations
- Given the graph still has incomplete work and explicit milestone steering may already be queued
- When `isComplete()` or `clearQueuedMilestones()` is invoked
- Then `isComplete()` reflects the current graph state rather than a stale cached answer
- And `clearQueuedMilestones()` removes explicit milestone steering without mutating the dependency graph or merge queue itself

### Feature and task mutation APIs preserve containment rules
- Given a caller creates, edits, reorders, or removes graph units through `FeatureGraph`
- When the mutation succeeds
- Then feature-level changes preserve the feature DAG model
- And task-level changes remain scoped to the owning feature rather than creating cross-feature task structure
