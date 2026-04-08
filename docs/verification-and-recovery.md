# gsd2 Verification and Recovery

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the high-level architecture index.

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
Retry state persisted in SQLite so retries survive orchestrator restarts.

## Verification: The `submit` Tool

Workers complete by calling a `submit` tool — the only way to mark a task done. Submit runs verification checks before accepting. Failures are returned as tool result text; the agent loop continues and must fix issues before resubmitting.

```typescript
const submitTool: AgentTool = {
  name: "submit",
  label: "Submit task",
  description: "Mark this task complete. Runs verification checks first.",
  schema: Type.Object({
    summary: Type.String(),
    filesChanged: Type.Array(Type.String()),
  }),
  execute: async (toolCallId, { summary, filesChanged }, signal) => {
    const checks = await runVerificationChecks(signal);
    if (checks.failed.length > 0) {
      return {
        content: [{ type: "text", text:
          `Verification failed. Fix these issues before submitting:\n\n${formatFailures(checks.failed)}`
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
    "checks": [
      { "description": "TypeScript compiles", "command": "tsc --noEmit" },
      { "description": "Tests pass",          "command": "npm test" },
      { "description": "Lint clean",          "command": "eslint src/" }
    ],
    "timeoutSecs": 120,
    "continueOnFail": false
  }
}
```

Each check runs in the task's worktree. stdout+stderr is captured and included in the failure message fed back to the agent.

## Stuck Detection

A task is "stuck" when it repeatedly fails verification and resubmits without making progress. Detected by counting consecutive submit-failures per task.

```typescript
interface StuckPolicy {
  maxConsecutiveFailures: number;  // default: 5
}
```

When `maxConsecutiveFailures` is reached:
1. Worker is suspended (SIGSTOP)
2. Task enters `blocked` status in the DAG
3. TUI highlights the task with `⊘ blocked` and shows the last verification failure
4. User can: **steer** (inject a message and resume), **skip** (cancel the task), or **replan** (trigger replanning for the feature)

## Replanning

Triggered manually (user presses `p` on a blocked/failed feature) or automatically when a feature fails after exhausting retries.

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
