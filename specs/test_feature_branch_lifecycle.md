# test_feature_branch_lifecycle

## Goal

Capture the expected lifecycle of a feature branch and its task worktrees.

## Scenarios

### Feature branch opens when requested
- Given a feature whose feature dependencies are satisfied
- When the orchestrator requests a feature branch for that feature
- Then it creates `feat-<name>-<feature-id>` from the current `main`
- And opens the feature worktree
- And feature collaboration control becomes `branch_open`

### Task worktree branches from feature branch
- Given a feature with an open feature branch
- When a task is dispatched
- Then its worktree branch `feat-<name>-<feature-id>-<task-id>` is created from the current HEAD of the feature branch
- And task collaboration control becomes `branch_open`

### Task dispatch creates an execution run
- Given a ready task is about to be dispatched
- When the scheduler assigns it to a worker
- Then the orchestrator creates or reuses its execution run
- And that run moves to `running` under system ownership

### Transient task failure updates the execution run first
- Given a dispatched task hits a transient failure
- When the orchestrator handles that failure
- Then `tasks.status` returns to `ready`
- And the execution run moves to `retry_await`
- And retry timing is stored on the run rather than on the task enum
- And readiness/blocking while waiting is covered separately by `test_agent_run_wait_states`

### Retry restart increments restart count on actual redispatch
- Given a task execution run is `retry_await`
- And its backoff window has expired
- When the scheduler dispatches that retry
- Then `restart_count` increments at retry start
- And the run returns to `running`

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
- And feature-branch cleanup happens as part of that integration outcome
- And the feature later either runs blocking `summarizing` and writes summary text or skips summarizing and reaches `work_complete` with no summary text

### Feature cancellation stops active work immediately
- Given a feature has active in-flight task runs
- When the user cancels that feature
- Then feature collaboration control becomes `cancelled`
- And all in-flight tasks for that feature are killed immediately
- And the feature stays out of normal scheduling until it is explicitly restored
- And restoring the feature returns collaboration control to `branch_open` when work remains or `merge_queued` when all feature work is already complete
