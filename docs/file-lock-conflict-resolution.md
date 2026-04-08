# gsd2 File-Lock Conflict Resolution

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the high-level architecture index.

## Scope

The file-lock system is a **same-feature collaboration-control** mechanism. It coordinates overlapping writes between task worktrees that belong to the same feature branch. Cross-feature conflicts are not resolved here; they surface when a feature branch enters the merge train.

## Same-Feature File-Lock Resolution

Workers run in isolated git worktrees and may edit the same files inside a feature. The orchestrator periodically scans active worktrees for overlapping writes within each feature branch.

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
   b. If the rebase auto-resolves cleanly with `ort` merge or similar, send a normal resume message and continue
   c. If the rebase cannot be auto-resolved, do **not** reset files; keep the task in `conflict` collaboration control and inject the exact conflict context to the agent
   d. SIGCONT the child process only after the agent has received the steering context
3. Worker agent resumes with awareness of the merged changes or the explicit conflict it now needs to resolve

> TODO: tentative details (likely complex). The precise conflict-classification and escalation policy in this area is expected to need tuning from user feedback. The current document captures the intended direction, not a finalized algorithm.

### Worker-side handling

The `submit` tool checks for pending collaboration-control messages before running verification. A normal resume explains what landed on the feature branch. An unresolved merge conflict is surfaced as a steering injection so the agent can inspect the current file state and resolve it intentionally.

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

## Cross-Feature Conflicts

If two different feature branches touch the same file, the file-lock system does **not** suspend one task and reset it to `main`. Those overlaps are allowed to proceed independently until feature integration time.

Cross-feature conflict handling:
1. Each feature finishes work on its own branch.
2. The completed feature enters `merge_queued` collaboration control.
3. The merge train rebases the feature branch onto the latest `main`.
4. If rebase or integration checks fail because of cross-feature overlap, the feature enters `conflict` collaboration control and usually `replanning` work control.

## SQLite

Suspension fields are part of the main `tasks` schema (see [persistence.md](./persistence.md)). They are raw collaboration-control details that back `suspended` / `conflict` task states.
