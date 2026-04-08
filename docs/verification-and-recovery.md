# gsd2 Verification and Recovery

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the high-level architecture index.

## Work Control vs Collaboration Control

This document uses two state axes:
- **Work control** — planning and execution progress (`executing`, `verifying`, `replanning`, `work_complete`)
- **Collaboration control** — branch / merge / suspension / conflict coordination (`branch_open`, `merge_queued`, `integrating`, `conflict`, `merged`)

A task becoming **stuck** is a work-control problem. A task or feature entering **conflict** is a collaboration-control problem.

## Retry: Exponential Backoff up to 1 Week

Task-level retry is handled by the orchestrator. When a task fails, the orchestrator schedules a retry with exponential backoff. The ceiling is 1 week to handle quota resets.

```typescript
interface RetryPolicy {
  baseDelayMs: number;   // default: 1000
  maxDelayMs: number;    // default: 7 * 24 * 60 * 60 * 1000 (1 week)
  jitter: boolean;       // default: true (±10%)
}

function nextRetryDelay(attempt: number, policy: RetryPolicy): number {
  const exp = policy.baseDelayMs * 2 ** attempt;
  const capped = Math.min(exp, policy.maxDelayMs);
  return policy.jitter ? capped * (0.9 + Math.random() * 0.2) : capped;
}
```

Retry triggers: provider overload, rate limit, quota exhausted, 5xx, network errors.
No retry: verification failures (agent must fix and resubmit).
Retry state persists in SQLite so retries survive orchestrator restarts.

## Verification: Task Submit vs Feature Verify

Workers complete by calling a `submit` tool — the only way to mark a task done. Submit runs light task-level checks before accepting. Failures are returned as tool result text; the agent loop continues and must fix issues before resubmitting. Full integration verification runs later at the feature level before the feature branch can merge to `main`.

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

```jsonc
// .gsd2/config.json
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
    }
  }
}
```

Task checks run in the task's worktree and are intentionally light/local. stdout+stderr is captured and included in the failure message fed back to the agent. Feature checks run in the feature branch during the `verifying` phase and are expected to provide full-repo confidence before merge.

## Integration Queue

Task completion does not land work on `main` directly. Instead:
1. The task merges into the feature branch.
2. When feature work control reaches `work_complete`, feature collaboration control becomes `merge_queued`.
3. The merge train serializes feature-branch integration into `main`.
4. If integration rebases and checks pass, collaboration control becomes `merged`.
5. If integration fails because of a cross-feature conflict, collaboration control becomes `conflict`. Whether work control stays `work_complete` or moves to `replanning` is still a tentative policy detail and depends on the eventual conflict-classification rules.

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
