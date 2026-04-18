# Feature Candidate: In-Flight Feature Split & Merge

## Status

Future feature candidate. Do not treat this as part of the baseline architecture yet.

## Baseline

The baseline `splitFeature` and `mergeFeatures` operations only work on features that are still pre-execution and pre-branch (`workControl` in `discussing`, `researching`, or `planning`, and `collabControl = none`). At this stage, splitting redistributes description and dependency edges only, and tasks are planned fresh on each resulting sub-feature. If planning already created tasks, baseline split/merge discards those planned tasks instead of trying to salvage or redistribute them. Merging unions descriptions and dependency edges.

This avoids the complexity of redistributing in-progress work, suspending running agents, or reconciling partial task results.

## Candidate

A later version could support splitting and merging features that already have started task work or that already reached execution-oriented phases such as `executing` or `replanning`. That would enable mid-flight replanning scenarios where a feature turns out to be larger or smaller than expected without discarding already-planned or already-running work.

Key challenges for in-flight split:
- Redistributing existing tasks across sub-features
- Suspending in-progress tasks that need reassignment
- Preserving task results for completed tasks in the correct sub-feature
- Handling feature branch divergence (each sub-feature needs its own branch)
- Worktree reassignment for active tasks

Key challenges for in-flight merge:
- Reconciling overlapping or conflicting task work across feature branches
- Merging partially-completed task sets with dependency edges that span the original features
- Combining feature branches that may have diverged from each other

## Refinement: Command/Changeset Pattern

The command/changeset pattern is worth considering as a refinement for these multi-entity mutations. It keeps FeatureGraph pure, gives the coordinator explicit store operations per mutation (solving the "coordinator must know persistence shape" problem), and naturally batches multi-entity mutations for transactional writes. The graph produces the changeset, the coordinator persists it, then tells the graph to apply.

But that's added complexity. The current approach — `PersistentFeatureGraph` decorator with direct SQLite transactions — works for the baseline because pre-execution split/merge is still a multi-entity mutation (new features, updated deps, removed original, and planned-task deletion). The decorator wraps these in a single SQLite transaction. In-flight split/merge would increase the number of entities touched per mutation significantly, which may justify graduating to an explicit changeset model at that point.

## Why Deferred

This feature is deferred because it increases:
- Graph mutation complexity (task redistribution, partial result handling)
- Persistence transaction scope (many more rows per operation)
- Runtime coordination (suspending/resuming agents mid-task)
- Git complexity (branch splitting, worktree reassignment)
- Recovery complexity (more intermediate states to handle on crash)

The baseline pre-execution and pre-branch guard captures the main replanning need (restructure before committing to task-level work) without taking on the full complexity cost.
