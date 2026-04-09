# File-Lock Conflict Resolution

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the high-level architecture index.

## Scope

The file-lock system is primarily a **same-feature collaboration-control** mechanism. It coordinates overlapping writes between task worktrees that belong to the same feature branch. Cross-feature overlap has its own feature-pair protocol in this document and is finally reconciled at feature integration time. The higher-level sync recommendation and conflict escalation ladder lives in [Conflict Steering](./conflict-steering.md).

## Same-Feature File-Lock Resolution

Workers run in isolated git worktrees and may edit the same files inside a feature. Git operations in this baseline should use `simple-git`, while worker pause/resume continues to use normal Node.js process signals for local child processes. Before runtime overlap detection kicks in, the planner reserves expected edit paths per task and the write-tool prehook checks attempted write paths against those reservations. The orchestrator then periodically scans active worktrees for actual overlapping writes within each feature branch.

### Mechanism

```text
Orchestrator polls every N seconds (default: 30):
  1. Group active worktrees by feature branch
  2. For each worktree in the feature, run: git diff --name-only HEAD
  3. Build map: file → [task-worktree1, task-worktree2, ...]
  4. For any file touched by 2+ worktrees in the same feature:
     a. Count changes per worktree (git diff --stat)
     b. Suspend the worktree with FEWER changes (SIGSTOP to child process)
     c. Record the suspension in SQLite with reason + suspended files
     d. Notify suspended worker via IPC before SIGSTOP:
        { type: "suspend", reason: "file_lock", files: ["src/index.ts"] }
```

### Resolution

When the dominant task completes its work:
1. Merge its task worktree branch into the feature branch
2. For each suspended worktree waiting on those files:
   a. Rebase the worktree branch onto the updated feature branch
   b. If the rebase auto-resolves cleanly with `ort` merge or similar, optionally run a cheap sanity check such as `git diff --check`, send a normal resume message, and continue
   c. If the rebase cannot be auto-resolved, do **not** reset files, do **not** auto-pick `ours` / `theirs`, keep the task in `conflict` collaboration control, and inject the exact conflict context to the agent
   d. SIGCONT the child process only after the agent has received the steering context
3. Worker agent resumes with awareness of the merged changes or the explicit conflict it now needs to resolve

This baseline is intentionally fail-closed:
- Stage 1 is mechanical only and accepts only clean git resolution.
- Stage 2 is agent reconciliation in the real conflicted worktree.
- Destructive resets are not part of the baseline policy.

### Worker-side handling

The `submit` tool checks for pending collaboration-control messages before running verification. A normal resume explains what landed on the feature branch. An unresolved merge conflict is surfaced as a steering injection so the agent can inspect the current file state and resolve it intentionally. Normal task verification still happens later at `submit`; resume itself does not force the full task verification command list.

### Stage-2 Conflict Context

For same-feature task conflicts, the orchestrator should inject at least:
- conflict type (`same_feature_task_rebase`)
- task id, feature id, task branch, and rebase target branch / SHA
- file-lock pause reason and overlapped file paths
- dominant task summary and changed files
- conflicted/unmerged file list from the current git state
- reserved write paths for the task
- relevant dependency outputs already available to the task
- last task verification result, if any

The injected summary is only orientation. The conflicted worktree remains authoritative, and the agent is expected to inspect and repair the real current file state.

### Same-Feature Outcome Rules

After same-feature conflict steering begins:
1. If the agent resolves the conflict and later passes normal task `submit` verification, clear task collaboration control from `conflict` and return the task to the normal completion path.
2. If the agent resolves merge markers but ordinary task verification still fails, treat that as normal task work rather than a continuing collaboration conflict; the task stays in the usual execution / verification loop and may eventually become `stuck` under the normal stuck policy.
3. If the agent makes no meaningful progress on the conflict, keep task collaboration control at `conflict` and escalate to targeted repair work, replanning, or user intervention.

The first response should remain task-local: steer the existing task agent before escalating to heavier feature-level recovery.

Normal resume after clean auto-merge:

```typescript
agent.steer({
  role: "user",
  content: [{ type: "text", text:
    `Work was paused due to a file edit lock on: ${files.join(", ")}\.\n` +
    `Another task has merged its changes into the feature branch. ` +
    `Your worktree has been rebased successfully; review the current file state and continue.`
  }],
  timestamp: Date.now(),
});
```

Conflict steering after auto-merge fails:

```typescript
agent.steer({
  role: "user",
  content: [{ type: "text", text:
    `Work was paused due to a file edit conflict on: ${files.join(", ")}\.\n` +
    `An automatic merge could not resolve the overlap. ` +
    `Please inspect the rebased worktree, resolve the conflict against the current feature branch, and continue.`
  }],
  timestamp: Date.now(),
});
```

## Cross-Feature Overlap Protocol

Cross-feature overlap is handled more conservatively than same-feature file locks. Detection may come from any of three sources: planner reservations, write-prehook path checks, or actual git overlap. Reservation overlap alone is only a scheduling penalty. Runtime overlap from the write prehook or git state triggers active coordination.

### Runtime Coordination Algorithm

1. Detect an overlap incident between two features using normalized project-root-relative file paths.
2. Choose **primary** and **secondary** once per feature pair, not per file, to avoid split-brain ownership. Ranking order:
   a. explicit dependency predecessor wins
   b. nearer-to-merge feature wins (`integrating` > `merge_queued` > `verifying` > `executing`)
   c. older feature request / branch-open time wins
   d. feature blocking more downstream dependents wins
   e. larger changed-line count wins
   f. lexical feature id is the final tie-breaker
3. Pause only the secondary feature's tasks that touch the overlapped paths.
4. When a paused task exits execute mode, release its active path locks; reservations remain as planning metadata.
5. Let the primary feature continue.
6. If the secondary feature remains blocked on the primary for more than 8 hours, raise a warning.
7. After the primary feature merges into `main`, rebase the secondary feature branch onto the updated `main`.
8. If that rebase succeeds, notify the paused secondary tasks, have them rebase their task worktrees onto the updated feature branch, reacquire active path locks lazily on future writes, and resume.
9. If the feature-branch rebase fails, create an integration repair task on the secondary feature branch and keep affected tasks paused until it lands.
10. If `ort` merge and the configured verification checks pass, continue normally; otherwise escalate to replanning.

Glob reservations remain available as an escape hatch, but they are intentionally heavy-handed and should be used sparingly.

## SQLite

Suspension fields are part of the main `tasks` schema (see [persistence.md](./persistence.md)). They are raw collaboration-control details that back `suspended` / `conflict` task states.
