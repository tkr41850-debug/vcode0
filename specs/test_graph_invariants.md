# test_graph_invariants

## Goal

Capture the core graph mutation rules that must hold for the feature DAG and feature-local task DAG.

## Scenarios

### Feature dependency cycle is rejected
- Given two or more features already form an acyclic dependency chain
- When a new feature dependency would introduce a cycle
- Then the mutation is rejected
- And the feature graph remains unchanged

### Cross-feature task dependency is rejected
- Given two tasks belong to different features
- When the planner or replanner tries to add a task dependency between them
- Then the mutation is rejected
- And task dependencies remain feature-local only

### Missing dependency target is rejected
- Given a planner or replanner mutation references a feature or task id that does not exist
- When the graph validates that mutation
- Then the mutation is rejected
- And no dangling dependency edge is persisted

### Illegal mutation on merged or cancelled feature is rejected
- Given a feature is already `cancelled` or overall `done` after reaching collaboration state `merged`
- When a mutation tries to add tasks or otherwise reopen normal planning work on that feature
- Then the mutation is rejected
- And the feature state remains unchanged

### Milestones are not valid dependency endpoints
- Given milestones are organizational and steering units only
- When a mutation tries to add a dependency to or from a milestone
- Then the mutation is rejected
- And milestone membership does not create execution edges

### Each feature belongs to exactly one milestone
- Given a feature already belongs to one milestone
- When a mutation tries to make that feature belong to multiple milestones at once
- Then the mutation is rejected
- And the feature remains attached to exactly one milestone
