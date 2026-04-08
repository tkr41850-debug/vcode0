# gsd2 File-Lock Conflict Resolution

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the high-level architecture index.

## File-Lock Conflict Resolution

Workers run in isolated git worktrees but may edit the same files (e.g. shared config, index files). The orchestrator periodically scans all active worktrees for changed files and detects overlaps.

### Mechanism

```
Orchestrator polls every N seconds (default: 30):
  1. For each active worktree, run: git diff --name-only HEAD
  2. Build map: file → [worktree1, worktree2, ...]
  3. For any file touched by 2+ worktrees:
     a. Count changes per worktree (git diff --stat)
     b. Suspend the worktree with FEWER changes (SIGSTOP to child process)
     c. Record the suspension in SQLite with reason + suspended files
     d. Notify suspended worker via IPC before SIGSTOP:
        { type: "suspend", reason: "file_lock", files: ["src/index.ts"] }
```

### Resolution

When the larger-change worktree completes its task:
1. Merge its branch to main
2. For each suspended worktree that was blocked on those files:
   a. Rebase worktree branch onto updated main
   b. If rebase has conflicts on the locked files: reset those files to main's version, record which files were reset
   c. Send resume IPC message to worker:
      ```
      { type: "resume", filesReset: ["src/index.ts"], reason: "file_lock released" }
      ```
   d. SIGCONT the child process
3. Worker agent receives the resume message as a steering injection and continues with awareness of what changed

### Worker-side handling

The `submit` tool checks for a pending resume message before running verification. If files were reset, the failure message includes which files need re-examination.

The orchestrator injects the resume notification as a pi-sdk `steer()` call after SIGCONT:

```typescript
agent.steer({
  role: "user",
  content: [{ type: "text", text:
    `Work was paused due to a file edit lock on: ${filesReset.join(", ")}.\n` +
    `These files were reset to the merged version from another task. ` +
    `Please review the current state of these files and continue your work.`
  }],
  timestamp: Date.now(),
});
```

### SQLite

Suspension fields are part of the main `tasks` schema (see [persistence.md](./persistence.md)).
