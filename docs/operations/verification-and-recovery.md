# Verification and Recovery

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for the high-level architecture overview.

## Work Control vs Collaboration Control

This document uses two main state axes plus a run/session overlay:
- **Work control** — planning and execution progress (`discussing`, `researching`, `planning`, `executing`, `ci_check`, `verifying`, `awaiting_merge`, `summarizing`, `executing_repair`, `replanning`, `work_complete`)
- **Collaboration control** — branch / merge / suspension / conflict coordination (`none`, `branch_open`, `merge_queued`, `integrating`, `merged`, task-level `suspended`, feature/task `conflict`)
- **Run/session state** — retry windows, help/approval waits, and manual ownership on `agent_runs`

A task becoming **stuck** is a work-control problem. A task or feature entering **conflict** is a collaboration-control problem. Merge progress stays in collaboration control; work control waits in `awaiting_merge` until collaboration control reaches `merged`. Retry/backoff, help waits, approval waits, and manual takeover do not add new task enums; they live on the execution run and surface as derived blocked/reporting state when relevant. Cancelled tasks are terminal for active recovery/dispatch even if they still retain suspension metadata from earlier overlap handling.

## Retry: Exponential Backoff up to 1 Week

Run-level retry is handled by the orchestrator for transient failures only. Task execution runs and feature-phase runs share the same run/session model and backoff concepts when a session crashes or the provider fails transiently. Current baseline wiring persists both task and feature-phase message history through shared session-store backing under `.gvc0/sessions/`, but startup orphan recovery is currently task-run focused rather than a full feature-phase recovery pass. Deterministic verification failures do not use retry backoff; they create repair work or return the run to normal execution flow instead.

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

## Verification: Task Submit vs Feature CI vs `verifying` vs Merge Train

Current code separates worker closeout from feature-level verification.

- Worker `submit(summary, filesChanged)` is the explicit task-complete signal. It emits the terminal task result payload that the orchestrator records.
- Worker `confirm()` is a lightweight acknowledgement tool. It emits progress text for operator visibility, but it does not take arguments and does not merge or land work by itself.
- In the worker runtime, terminal results carry `completionKind: 'submitted' | 'implicit'`. The orchestrator treats only `completionKind === 'submitted'` as landed task work and uses that to mark the task merged into the feature branch.
- Feature-level shell verification runs later in `ci_check` on the feature worktree.
- Agent-level semantic review runs later in `verifying`.
- Merge-train verification remains part of the architecture/config surface, but the currently wired verification executor is the feature-level `ci_check` path.

### Verification Config

Verification layers are configured as editable command lists in `.gvc0/config.json`. The commands shown below are examples only; actual projects may use different tools and ecosystems (`npm`, `cargo`, `go test`, `pytest`, `mix`, etc.).

Current wiring:
- `verification.feature` is executed by the current `VerificationService` during `ci_check`.
- `verification.task` and `verification.mergeTrain` are parsed and available in config shape, including merge-train fallback to `verification.feature`, but this document should not treat them as fully wired automatic execution paths unless that behavior is implemented.

```jsonc
// .gvc0/config.json
{
  "verification": {
    "task": {
      "checks": [
        { "description": "Unit test suite", "command": "npm run test:unit" },
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

Feature checks run in the feature branch during `ci_check` and are the current heavy branch-level gate before spec review. `verifying` is an agent-level review that checks whether the feature branch meets the feature spec. `verification.mergeTrain` inherits `verification.feature` only when the merge-train layer is omitted entirely; an explicit empty `verification.mergeTrain.checks` stays empty instead of inheriting. Empty effective check lists are advisory-only: the phase still passes, but the orchestrator emits a warning because verification ran without configured commands. Timeouts are configurable per verification layer; the 60s / 600s values shown above are baseline examples for local-machine workflows. Support for substantially longer-running verification windows is deferred. See [Feature Candidate: Long Verification Timeouts](../feature-candidates/long-verification-timeouts.md). Slow-check warnings and feature-churn warnings are described in [Warnings](./warnings.md). Upstream sync recommendation and conflict escalation behavior are described in [Conflict Coordination](./conflict-coordination.md).

### Feature CI and `verifying` Outcomes

A feature reaches `ci_check` after the last task or repair task lands on the feature branch. By default the branch should be green before the feature may leave `ci_check` and enter `verifying`, though a loose feature policy may relax that boundary.

If `ci_check` fails:
1. Keep the feature on the same feature branch.
2. Move feature work control to `executing_repair`.
3. The orchestrator adds a repair task to fix the reported branch-level issues.
4. Return to `ci_check` after the repair task lands.

If `verifying` finds that the code does not satisfy the feature spec:
1. Keep the feature on the same feature branch.
2. The verify agent emits typed `VerifyIssue[]` via the `raiseIssue` tool; the run's terminal payload carries the accumulated list and the orchestrator persists it onto `features.verify_issues`. A `verifier_issue_raised` event is written per call for audit.
3. If the verify run emits no blocking/concern issues the feature moves to `awaiting_merge`; otherwise feature work control moves to `replanning` (the replanner consumes `verifyIssues` and proposes the next task set rather than the orchestrator creating a repair task directly). `nit`-severity issues are non-blocking: they still land on `features.verify_issues` and surface in the verification summary, but do not force `repair_needed`. See [Verify Nit Task Pool](../feature-candidates/verify-nit-task-pool.md) for the eventual mechanism to route these into post-merge follow-up work.
4. On approved replan, `verifyIssues` clears; new/modified tasks land on the same feature branch.
5. Return to `ci_check` after repair tasks land.

### Typed `VerifyIssue` Shape

```typescript
interface VerifyIssue {
  id: string;
  severity: 'blocking' | 'concern' | 'nit';
  location?: string;
  description: string;
  suggestedFix?: string;
}
```

### Verify-Replan Crashloop Warning

Repeated `verify → replan → verify` cycles without progress emit a
`verify_replan_loop` warning. The evaluator walks the feature's
`feature_phase_completed` events backwards, counting verify failures
since the last `plan`/`replan` completion. When the count reaches
`warnings.verifyReplanLoopThreshold` (default `3`), a
`warning_emitted` event fires with `{ category: 'verify_replan_loop',
failedVerifyCount }`. The warning resets naturally when the next
replan completes. The threshold is configurable in `.gvc0/config.json`
under `warnings.verifyReplanLoopThreshold`.

## Merge Train

Task completion does not land work on `main` directly. Instead:
1. The worker emits a terminal task result; only `completionKind === 'submitted'` is treated as landed task work on the feature branch.
2. After the last task or repair task lands, the feature runs branch checks in `ci_check`.
3. If `ci_check` passes, the feature runs agent-level spec review in `verifying`.
4. If `verifying` passes, feature work control becomes `awaiting_merge`.
5. Only then may collaboration control become `merge_queued`.
6. The merge train serializes feature-branch integration into `main`.
7. The queue head moves through integration on top of the latest `main`; merge-train verification remains an architectural/config layer, but the current wired verification executor is the feature-level `ci_check` path.
8. If integration succeeds, collaboration control becomes `merged`.
9. Once collaboration control reaches `merged`, the feature normally enters blocking `summarizing`, writes its summary text, and only then reaches `work_complete`; in budget mode it may instead move directly to `work_complete` without writing summary text.
10. If integration fails, remove the feature from the merge train, set collaboration control to `conflict`, and have the orchestrator add repair work on the same feature branch.
11. Once that repair task is added, feature work control moves to `executing_repair` and later returns through `ci_check` and `verifying` again.
12. Only if that path passes again may the feature return to `awaiting_merge`, clear `conflict`, and re-enter `merge_queued` under the normal automatic queue policy (or explicit manual override bucket, if one is set).
13. If rebasing onto the latest `main` or subsequent repair work keeps failing in a way that indicates structural mismatch, escalate to `replanning`.

## Conflict Outcome Rules

### Same-Feature Task Conflict

When a same-feature task enters collaboration-control `conflict` after auto-rebase fails:
1. Steer the existing task agent in the real conflicted worktree.
2. If the agent resolves the conflict and later lands the task normally, clear the task's `conflict` collaboration state and continue the normal task completion path.
3. If the agent resolves the merge but still needs additional code changes, treat that as normal task work rather than a continuing collaboration conflict.
4. If the agent makes no meaningful progress, keep the task in `conflict` and escalate to targeted repair work, replanning, or user intervention.

### Cross-Feature Integration Conflict

When feature integration fails at rebase or merge-train verification:
1. Set feature collaboration control to `conflict` and remove the feature from the merge train.
2. Suspend all non-repair task runs for that feature while the feature remains in `conflict`.
3. The orchestrator creates repair work on the same feature branch and moves feature work control to `executing_repair`.
4. Once repair lands, rerun the normal `ci_check -> verifying` path on that feature branch.
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
6. The operator may later trigger `release_to_scheduler` to return the run to scheduler-owned execution once manual intervention is complete. The run returns to `ready` with `owner = "system"` only if no unanswered `request_help()` query remains on `payload_json`; otherwise it stays `await_response` with manual ownership until the help query is answered.
7. Alternatively, the user may move the feature into `replanning`; the replanner proposal enters `await_approval`, and if approved the original stuck task returns to `ready`

## Help / Approval / Replanning

Task execution runs and feature-phase runs may call `request_help(query)` when they hit a semantic blocker that is not a transient provider failure. `request_help()` pauses the run immediately, stores the query in `payload_json`, and moves the run to `await_response` with manual ownership. The TUI may either answer the request directly through a typed runtime help-response message or attach to the live session and continue it in `running/manual` mode.

Manual drop-in interaction uses the same runtime control path: the orchestrator forwards plain-text `manual_input`, and the worker may stream plain-text `assistant_output` back while the run remains under manual ownership. The operator returns the run to automatic execution by triggering `release_to_scheduler`, which clears manual ownership only when no unanswered `request_help()` state remains on the run. Approval requests likewise stay run-owned: a worker emits `request_approval`, the orchestrator persists the waiting state on `agent_runs`, and later sends a typed `approval_decision` such as `approved`, `approve_always` when supported, `reject`, or `discuss`.

Replanning is triggered when a feature enters the `replanning` phase, either after repair escalation in the orchestrator or through the current TUI proposal/approval flow for a selected replanning feature.

The replanner is a pi-sdk `Agent` with the same proposal-graph tools as the planner, plus read access to the current graph state and the failure context. It can:
- Split the failed feature into smaller subfeatures
- Add/remove/change dependencies
- Edit task descriptions
- Cancel the feature and add an alternative

Like planning, replanning operates on a temporary proposal graph rather than mutating the authoritative graph directly. Each tool call updates only the proposal graph and appends a tracked modification record so the resulting draft can be reviewed as both a graph snapshot and a mutation log.

A replanning proposal is stored in `payload_json` and surfaced as `await_approval`. If the user approves it, the recorded graph mutation sequence is applied to the authoritative graph and the original stuck task returns to `ready` unless the approved plan explicitly replaces or cancels that task. If the user rejects it, the authoritative graph stays unchanged.

```typescript
// Replanner prompt includes:
// - Current graph state (serialized)
// - Failed feature + its tasks + last error output
// - Instruction: "Restructure this feature to make it achievable"
```

After replanning approval, the scheduler re-evaluates the frontier and dispatches newly ready tasks.
