# test_feature_branch_lifecycle

## Goal

Capture the expected lifecycle of a feature branch and its task worktrees.

## Scenarios

### Feature branch opens when work begins
- Given a feature whose feature dependencies are satisfied
- When feature work control enters `executing`
- Then the orchestrator creates `feature/<feature-id>` from the current `main`
- And feature collaboration control becomes `branch_open`

### Task worktree branches from feature branch
- Given a feature with an open feature branch
- When a task is dispatched
- Then its worktree branch is created from the current HEAD of the feature branch
- And task collaboration control becomes `branch_open`

### Task merges back into feature branch
- Given a task completes verification successfully
- When the task is submitted
- Then the task worktree is squash-merged into the feature branch
- And the task is not merged directly to `main`
- And task collaboration control becomes `merged`

### Feature branch is cleaned up after integration
- Given all tasks in a feature have merged into the feature branch
- And feature work control has reached `work_complete`
- And the feature passes integration verification in the merge train
- When the feature lands on `main`
- Then the feature branch is deleted
- And feature collaboration control becomes `merged`
