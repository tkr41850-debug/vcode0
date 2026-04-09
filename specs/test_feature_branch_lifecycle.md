# test_feature_branch_lifecycle

## Goal

Capture the expected lifecycle of a feature branch and its task worktrees.

## Scenarios

### Feature branch opens when requested
- Given a feature whose feature dependencies are satisfied
- When the orchestrator requests a feature branch for that feature
- Then it creates `feat-<feature-id>` from the current `main`
- And opens the feature worktree
- And feature collaboration control becomes `branch_open`

### Task worktree branches from feature branch
- Given a feature with an open feature branch
- When a task is dispatched
- Then its worktree branch `feat-<feature-id>-task-<task-id>` is created from the current HEAD of the feature branch
- And task collaboration control becomes `branch_open`

### Task merges back into feature branch
- Given a task passes `submit()` preflight successfully
- When the task is finalized with `confirm()`
- Then the task worktree is squash-merged into the feature branch
- And the task is not merged directly to `main`
- And task collaboration control becomes `merged`

### Feature enters merge queue only after feature CI and spec verification pass
- Given all tasks in a feature have merged into the feature branch
- And feature work control has reached `feature_ci`
- When heavy feature CI passes and agent-level `verifying` also passes
- Then feature work control becomes `awaiting_merge`
- And the feature enters `merge_queued` only after that

### Task worktrees are retained until feature merge or GC
- Given a task has already merged back into its feature branch
- When the feature has not yet landed on `main`
- Then the task worktree is retained for replay/recovery
- Or later removed only through garbage collection / snapshot policy

### Feature branch is cleaned up after integration
- Given all tasks in a feature have merged into the feature branch
- And feature work control is `awaiting_merge`
- And the feature passes merge-train verification
- When the feature lands on `main`
- Then feature collaboration control becomes `merged`
- And the feature later either runs blocking `summarizing` and writes summary text or skips summarizing and reaches `work_complete` with no summary text
- And the feature branch is deleted
