# Verification and Recovery

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for the high-level architecture overview.

## Work Control vs Collaboration Control

This document uses two main state axes plus a run/session overlay:
- **Work control** — planning and execution progress (`discussing`, `researching`, `planning`, `executing`, `feature_ci`, `verifying`, `awaiting_merge`, `summarizing`, `executing_repair`, `replanning`, `work_complete`)
- **Collaboration control** — branch / merge / suspension / conflict coordination (`none`, `branch_open`, `merge_queued`, `integrating`, `merged`, task-level `suspended`, feature/task `conflict`)
- **Run/session state** — retry windows, help/approval waits, and manual ownership on `agent_runs`

A task becoming **stuck** is a work-control problem. A task or feature entering **conflict** is a collaboration-control problem. Merge progress stays in collaboration control; work control waits in `awaiting_merge` until collaboration control reaches `merged`. Retry/backoff, help waits, approval waits, and manual takeover do not add new task enums; they live on the execution run and surface as derived blocked/reporting state when relevant.

## Retry: Exponential Backoff up to 1 Week

Run-level retry is handled by the orchestrator for transient failures only. Task execution runs and feature-phase runs both use the same backoff model when a session crashes or the provider fails transiently. Deterministic verification failures do not use retry backoff; they create repair work or return the run to normal execution flow instead.

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
- on transient failure: set the affected run's `run_status = "retry_await"` and write `retry_at`
- while waiting: `restart_count` does not change yet
- when the scheduler actually starts the retry run: increment `restart_count` and transition to `running`
- if the retry ceiling is exhausted: set the affected run's `run_status = "failed"`
- if repeated transient failures indicate an unproductive crash loop, set `attention = "crashloop_backoff"` in addition to the backoff timer so the TUI can surface that state distinctly
- `await_response` and `await_approval` remain `run_status` values for human-waiting cases; they are not duplicated in `attention`

Retry state persists in SQLite so retries survive orchestrator restarts.

## Verification: Task Submit vs Feature CI vs Feature Verify vs Merge Train

Task completion is a two-step closeout. Workers first call `submit()` to run light task-local preflight checks and receive structured failure feedback when those checks do not pass. If `submit()` reaches an acceptable result for the task's policy, the worker performs a quick final review and then calls `confirm()` to terminate the session and merge the task branch into the feature branch. Feature-level heavy CI runs later on the feature branch in `feature_ci`, followed by agent-level spec review in `verifying`, and finally merge-train verification after rebasing onto the latest `main`.

Task-level policy precedence is: `task policy > feature policy > strict`. Feature-level heavy CI uses `feature policy > strict`. Merge-train checks use `mergeTrain` config > strict.

```typescript
const submitTool: AgentTool = {
  name: "submit",
  label: "Run task preflight",
  description: "Run task-local preflight checks and report failures.",
  schema: Type.Object({
    summary: Type.String(),
    filesChanged: Type.Array(Type.String()),
  }),
  execute: async (toolCallId, { summary, filesChanged }, signal) => {
    const checks = await runTaskVerificationChecks(filesChanged, signal);
    if (checks.failed.length > 0) {
      return {
        content: [{ type: "text", text:
          `Task preflight failed. Fix these issues before confirming:\n\n${formatFailures(checks.failed)}`
        }],
        details: { readyToConfirm: false, failures: checks.failed },
      };
    }
    return {
      content: [{ type: "text", text: "Checks passed. Run a quick review and use confirm() if no changes are needed." }],
      details: { readyToConfirm: true },
    };
  },
};

const confirmTool: AgentTool = {
  name: "confirm",
  label: "Finalize task",
  description: "Terminate the task session and merge the task branch into the feature branch after submit() has passed.",
  schema: Type.Object({
    summary: Type.String(),
    filesChanged: Type.Array(Type.String()),
  }),
  execute: async (_toolCallId, args, _signal) => {
    if (!taskRunIsReadyToConfirm(taskId)) {
      return {
        content: [{ type: "text", text: "confirm() is not available yet. Run submit() first and resolve any reported failures." }],
        details: { confirmed: false },
      };
    }
    ipc.send({ type: "result", taskId, summary: args.summary, filesChanged: args.filesChanged });
    return {
      content: [{ type: "text", text: "Task confirmed successfully." }],
      details: { confirmed: true },
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

Task checks run in the task's worktree and are intentionally light/local. They may be loose enough to support workflows like red-test-first TDD, but `submit()` must still return concrete failed checks so the agent sees what remains. Feature checks run in the feature branch during `feature_ci` and are the heavy branch-level gate before spec review. `verifying` is an agent-level review that checks whether the feature branch meets the feature spec. Merge-train checks run again after rebasing the feature branch onto the latest `main`, and provide final landing confidence. Verification commands should run through the same Node.js child-process execution layer used elsewhere in the orchestrator, while git rebases/merges continue to use `simple-git`, so stdout+stderr can be captured and included in the failure message fed back to the agent. Timeouts are configurable per verification layer; the 60s / 600s values shown above are only baseline examples for local-machine workflows. Support for substantially longer-running verification windows is deferred. See [Feature Candidate: Long Verification Timeouts](../feature-candidates/long-verification-timeouts.md). Slow-check warnings and feature-churn warnings are described in [Warnings](./warnings.md). Upstream sync recommendation and conflict escalation behavior are described in [Conflict Coordination](./conflict-coordination.md).

### Feature CI and Spec-Review Outcome

A feature reaches `feature_ci` after the last task or repair task lands on the feature branch. By default the branch should be green before the feature may leave `feature_ci` and enter `verifying`, though a loose feature policy may relax that boundary.

If `feature_ci` fails:
1. Keep the feature on the same feature branch.
2. Move feature work control to `executing_repair`.
3. The orchestrator adds a repair task to fix the reported branch-level issues.
4. Return to `feature_ci` after the repair task lands.

If `verifying` finds that the code does not satisfy the feature spec:
1. Keep the feature on the same feature branch.
2. Move feature work control to `executing_repair`.
3. The orchestrator adds a repair task to fix the reported spec gaps.
4. Return to `feature_ci` after the repair task lands.

## Integration Queue

Task completion does not land work on `main` directly. Instead:
1. The task calls `confirm()` and merges into the feature branch.
2. After the last task or repair task lands, the feature runs heavy branch checks in `feature_ci`.
3. If `feature_ci` passes, the feature runs agent-level spec review in `verifying`.
4. If `verifying` passes, feature work control becomes `awaiting_merge`.
5. Only then may collaboration control become `merge_queued`.
6. The merge train serializes feature-branch integration into `main`.
7. The queue head rebases onto the latest `main` and runs the configured `mergeTrain.checks` command list.
8. If integration rebases and merge-train checks pass, collaboration control becomes `merged`.
9. Once collaboration control reaches `merged`, the feature normally enters blocking `summarizing`, writes its summary text, and only then reaches `work_complete`; in budget mode it may instead move directly to `work_complete` without writing summary text.
10. If merge-train verification fails, remove the feature from the merge train, set collaboration control to `conflict`, and have the orchestrator add repair work on the same feature branch.
11. Once that repair task is added, feature work control moves to `executing_repair` and later returns through `feature_ci` and `verifying` again.
12. Only if that path passes again may the feature return to `awaiting_merge`, clear `conflict`, and re-enter `merge_queued` under the normal automatic queue policy (or explicit manual override bucket, if one is set).
13. If rebasing onto the latest `main` or subsequent repair work keeps failing in a way that indicates structural mismatch, escalate to `replanning`.

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
2. Suspend all non-repair task runs for that feature while the feature remains in `conflict`.
3. The orchestrator creates repair work on the same feature branch and moves feature work control to `executing_repair`.
4. Once repair lands, rerun the normal `feature_ci -> verifying` path on that feature branch.
5. Only if that path passes again may the feature return to `awaiting_merge`, clear `conflict`, and re-enter `merge_queued`.
6. If repair repeatedly fails or indicates structural mismatch, move feature work control to `replanning`.

## Stuck Detection

A task is **stuck** when it repeatedly fails verification and resubmits without making progress. This is a work-control condition, not a dependency-waiting or merge-conflict label.

```typescript
interface StuckPolicy {
  maxConsecutiveFailures: number;  // default: 5
}
```

When `maxConsecutiveFailures` is reached:
1. Task execution stops under automatic system ownership
2. Task enters `stuck` status
3. TUI highlights the task with the last verification failure and indicates that intervention is needed
4. User may attach directly, moving the run to `running` with `owner = "manual"`
5. If the user exits without finishing, the run becomes `await_response` with `owner = "manual"`
6. The user may call `release_to_scheduler`; if there is no unanswered `request_help()`, the run returns to `ready` with `owner = "system"`, otherwise it remains `await_response` / manual because it still needs a human answer
7. Alternatively, the user may trigger feature `replanning`; the replanner proposal enters `await_approval`, and if approved the original stuck task returns to `ready`

## Help / Approval / Replanning

Task execution runs and feature-phase runs may call `request_help(query)` when they hit a semantic blocker that is not a transient provider failure. `request_help()` pauses the run immediately, stores the query in `payload_json`, and moves the run to `await_response` with manual ownership. The TUI may either answer the request directly or attach to the live session and continue it in `running/manual` mode.

Replanning is triggered manually (user presses `p` on a stuck/conflicted feature) or automatically when a feature cannot integrate cleanly after repair attempts.

The replanner is a pi-sdk `Agent` with the same feature-graph tools as the planner, plus read access to the current graph state and the failure context. It can:
- Split the failed feature into smaller subfeatures
- Add/remove dependencies
- Edit task descriptions
- Cancel the feature and add an alternative

A replanning proposal is stored in `payload_json` and surfaced as `await_approval`. If the user approves it, the graph mutation is applied and the original stuck task returns to `ready` unless the approved plan explicitly replaces or cancels that task.

```typescript
// Replanner prompt includes:
// - Current graph state (serialized)
// - Failed feature + its tasks + last error output
// - Instruction: "Restructure this feature to make it achievable"
```

After replanning approval, the scheduler re-evaluates the frontier and dispatches newly ready tasks.
