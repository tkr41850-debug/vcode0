# Verification and Recovery

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the high-level architecture index.

## Work Control vs Collaboration Control

This document uses two state axes:
- **Work control** — planning and execution progress (`executing`, `verifying`, `replanning`, `work_complete`)
- **Collaboration control** — branch / merge / suspension / conflict coordination (`branch_open`, `merge_queued`, `integrating`, `conflict`, `merged`)

A task becoming **stuck** is a work-control problem. A task or feature entering **conflict** is a collaboration-control problem.

## Retry: Exponential Backoff up to 1 Week

Task-level retry is handled by the orchestrator. When a task hits a transient failure, it enters `retry_await` and receives a `retry_at` timestamp. The scheduler treats that task as retry-eligible only once the stored timestamp is in the past. If the stored `retry_at` would land beyond the 1-week ceiling, the task becomes `failed` instead (`failed` means no more progress under the baseline automatic policy).

```typescript
interface RetryPolicy {
  baseDelayMs: number;   // default: 1000
  maxDelayMs: number;    // default: 7 * 24 * 60 * 60 * 1000 (1 week)
  jitter: boolean;       // default: true (±10%)
}

function nextRetryAt(now: number, restartCount: number, policy: RetryPolicy): number {
  const exp = policy.baseDelayMs * 2 ** restartCount;
  const capped = Math.min(exp, policy.maxDelayMs);
  const delay = policy.jitter ? capped * (0.9 + Math.random() * 0.2) : capped;
  return now + delay;
}
```

Retry triggers: provider overload, rate limit, quota exhausted, 5xx, network errors.
No retry: verification failures (agent must fix and resubmit).

Baseline state rules:
- on transient failure: set `status = "retry_await"` and write `retry_at`
- while waiting: `restart_count` does not change yet
- when the scheduler actually starts the retry run: increment `restart_count` and transition to `running`
- if `retry_at` is beyond the 1-week ceiling: set `status = "failed"`

Retry state persists in SQLite so retries survive orchestrator restarts.

## Verification: Task Submit vs Feature Verify vs Merge Train

Workers complete by calling a `submit` tool — the only way to mark a task done. Submit runs light task-level checks before accepting. Failures are returned as tool result text; the agent loop continues and must fix issues before resubmitting. Full integration verification runs later at the feature level before the feature branch can merge to `main`, and then runs again in the merge train after rebasing onto the latest `main`.

```typescript
const submitTool: AgentTool = {
  name: "submit",
  label: "Submit task",
  description: "Mark this task complete. Runs light task checks first.",
  schema: Type.Object({
    summary: Type.String(),
    filesChanged: Type.Array(Type.String()),
  }),
  execute: async (toolCallId, { summary, filesChanged }, signal) => {
    const checks = await runTaskVerificationChecks(filesChanged, signal);
    if (checks.failed.length > 0) {
      return {
        content: [{ type: "text", text:
          `Task verification failed. Fix these issues before submitting:\n\n${formatFailures(checks.failed)}`
        }],
        details: { verified: false, failures: checks.failed },
      };
    }
    ipc.send({ type: "result", taskId, summary, filesChanged });
    return {
      content: [{ type: "text", text: "Task submitted successfully." }],
      details: { verified: true },
    };
  },
};
```

### Verification Config

All verification layers are configured as editable command lists in `.gvc0/config.json`. The commands shown below are only examples; actual projects may use different tools and ecosystems (`npm`, `cargo`, `go test`, `pytest`, `mix`, etc.).

```jsonc
// .gvc0/config.json
{
  "verification": {
    "task": {
      "checks": [
        { "description": "Targeted unit tests", "command": "npm test -- --runInBand --findRelatedTests" },
        { "description": "Changed-file lint",    "command": "eslint" }
      ],
      "timeoutSecs": 60,
      "continueOnFail": false
    },
    "feature": {
      "checks": [
        { "description": "TypeScript compiles", "command": "tsc --noEmit" },
        { "description": "Full test suite",      "command": "npm test" },
        { "description": "Lint clean",           "command": "eslint src/" }
      ],
      "timeoutSecs": 600,
      "continueOnFail": false
    },
    "mergeTrain": {
      "checks": [
        { "description": "TypeScript compiles", "command": "tsc --noEmit" },
        { "description": "Full test suite",      "command": "npm test" },
        { "description": "Lint clean",           "command": "eslint src/" }
      ],
      "timeoutSecs": 600,
      "continueOnFail": false
    }
  }
}
```

Task checks run in the task's worktree and are intentionally light/local. Feature checks run in the feature branch during the `verifying` phase and are expected to provide full-repo confidence before queueing for integration. Merge-train checks run again after rebasing the feature branch onto the latest `main`, and provide final landing confidence. Verification commands should run through the same Node.js child-process execution layer used elsewhere in the orchestrator, while git rebases/merges continue to use `simple-git`, so stdout+stderr can be captured and included in the failure message fed back to the agent. Slow-check warnings and feature-churn warnings are described in [Warnings](./warnings.md). Upstream sync recommendation and conflict escalation behavior are described in [Conflict Steering](./conflict-steering.md).

### Feature Verification Outcome

A feature may enter the merge queue only after its configured `verification.feature.checks` pass on the feature branch.

If feature verification fails before queueing:
1. Keep the feature on the same feature branch.
2. Add a task to fix the reported verification issues.
3. Return the feature to normal execution on that branch.
4. Rerun `verification.feature.checks` after the fix task lands.

## Integration Queue

Task completion does not land work on `main` directly. Instead:
1. The task merges into the feature branch.
2. When feature work control reaches `work_complete`, run `verification.feature.checks` on the feature branch.
3. If feature verification passes, collaboration control becomes `merge_queued`.
4. The merge train serializes feature-branch integration into `main`.
5. The queue head rebases onto the latest `main` and runs the configured `mergeTrain.checks` command list.
6. If integration rebases and merge-train checks pass, collaboration control becomes `merged`.
7. If merge-train verification fails, remove the feature from the merge train and add a task on the same feature branch to fix the reported issues.
8. Once that repair task is added, the feature is no longer `work_complete` / merge-ready and returns to normal branch work.
9. After the repair task lands, rerun `verification.feature.checks` on the feature branch.
10. Only if feature verification passes again may the feature re-enter the merge train under the normal automatic queue policy (or explicit manual override bucket, if one is set).
11. If rebasing onto the latest `main` or subsequent repair work keeps failing in a way that indicates structural mismatch, escalate to replanning.

## Conflict Outcome Rules

### Same-Feature Task Conflict

When a same-feature task enters collaboration-control `conflict` after auto-rebase fails:
1. Steer the existing task agent in the real conflicted worktree.
2. If the agent resolves the conflict and later passes task `submit` verification, clear the task's `conflict` collaboration state and continue the normal task completion path.
3. If the agent resolves the merge but ordinary task verification fails, treat that as normal task work rather than a continuing collaboration conflict.
4. If the agent makes no meaningful progress, keep the task in `conflict` and escalate to targeted repair work, replanning, or user intervention.

### Cross-Feature Integration Conflict

When feature integration fails at rebase or merge-train verification:
1. Set feature collaboration control to `conflict` and remove the feature from the merge queue.
2. Create repair work on the same feature branch.
3. Once repair lands, rerun `verification.feature.checks` on that feature branch.
4. Only if feature verification passes again may the feature return to `work_complete`, clear `conflict`, and re-enter `merge_queued`.
5. If repair repeatedly fails or indicates structural mismatch, move feature work control to `replanning`. 

## Stuck Detection

A task is **stuck** when it repeatedly fails verification and resubmits without making progress. This is a work-control condition, not a dependency-waiting or merge-conflict label.

```typescript
interface StuckPolicy {
  maxConsecutiveFailures: number;  // default: 5
}
```

When `maxConsecutiveFailures` is reached:
1. Worker is suspended from further execution attempts
2. Task enters `stuck` status
3. Feature work control enters `replanning`
4. TUI highlights the task with the last verification failure and indicates that intervention is needed
5. User can: **steer** (inject a message and resume), **skip** (cancel the task), or **replan** (trigger replanning for the feature)

## Replanning

Triggered manually (user presses `p` on a stuck/conflicted feature) or automatically when a feature fails after exhausting retries or cannot integrate cleanly.

The replanner is a pi-sdk `Agent` with the same feature-graph tools as the planner, plus read access to the current graph state and the failure context. It can:
- Split the failed feature into smaller subfeatures
- Add/remove dependencies
- Edit task descriptions
- Cancel the feature and add an alternative

Running workers are not interrupted during replanning. The replanner only mutates pending/failed nodes.

```typescript
// Replanner prompt includes:
// - Current graph state (serialized)
// - Failed feature + its tasks + last error output
// - Instruction: "Restructure this feature to make it achievable"
```

After replanning, the scheduler re-evaluates the frontier and dispatches newly ready tasks.
