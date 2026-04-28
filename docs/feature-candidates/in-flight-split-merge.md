# Feature Candidate: In-Flight Feature Split & Merge

## Status

Future feature candidate. Do not treat this as part of baseline architecture yet.

## Baseline

Feature restructuring already goes through proposal approval, not direct `FeatureGraph` split/merge primitives.

Today, planner or replanner can still express "split this feature" or "merge these features" before task work starts by composing proposal ops:
- `remove_feature(...)`
- `add_feature(...)`
- `edit_feature(...)`
- dependency rewrites

That works for pre-execution reshaping because no started task work, task results, branch divergence, or live worktree ownership needs to be preserved.

## Candidate

Later version could extend proposal-driven restructuring to features that already have started task work or already reached execution-oriented phases such as `executing` or `replanning`. That would enable mid-flight replanning when a feature turns out larger or smaller than expected without discarding already-planned or already-running work.

Key challenges for in-flight split:
- Redistributing existing tasks across sub-features
- Suspending in-progress tasks that need reassignment
- Preserving task results for completed tasks in correct sub-feature
- Handling feature branch divergence (each sub-feature needs its own branch)
- Worktree reassignment for active tasks

Key challenges for in-flight merge:
- Reconciling overlapping or conflicting task work across feature branches
- Merging partially completed task sets with dependency edges that span original features
- Combining feature branches that may have diverged from each other

## Refinement: Command/Changeset Pattern

Command/changeset pattern is worth considering as refinement for these multi-entity restructures. It keeps `FeatureGraph` pure, gives coordinator explicit store operations per mutation, and naturally batches multi-entity changes for transactional writes. Graph would produce changeset, coordinator would persist it, then tell graph to apply.

That is added complexity. Current approach — `PersistentFeatureGraph` decorator with direct SQLite transactions plus proposal approval — is enough for baseline because pre-start restructuring still touches bounded set of entities. In-flight restructuring would touch many more rows and runtime-owned resources, which may justify explicit changeset model at that point.

## Why Deferred

This feature is deferred because it increases:
- Graph mutation complexity (task redistribution, partial result handling)
- Persistence transaction scope (many more rows per operation)
- Runtime coordination (suspending/resuming agents mid-task)
- Git complexity (branch splitting, worktree reassignment)
- Recovery complexity (more intermediate states to handle on crash)

Current proposal-driven pre-start restructuring captures main replanning need (reshape work before committing to task-level execution) without taking on full complexity cost.
