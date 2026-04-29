# Verification and Recovery

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for the high-level architecture overview.

## Work Control vs Collaboration Control

This document uses two main state axes plus a run/session overlay:
- **Work control** — planning and execution progress (`discussing`, `researching`, `planning`, `executing`, `ci_check`, `verifying`, `awaiting_merge`, `summarizing`, `replanning`, `work_complete`)
- **Collaboration control** — branch / merge / suspension / conflict coordination (`none`, `branch_open`, `merge_queued`, `integrating`, `merged`, task-level `suspended`, feature/task `conflict`)
- **Run/session state** — retry windows, help/approval waits, and manual ownership on `agent_runs`

A task becoming **stuck** is a work_control problem. A task or feature entering **conflict** is a collaboration_control problem. Merge progress stays in collaboration_control; work_control waits in `awaiting_merge` until collaboration_control reaches `merged`. Retry/backoff, help waits, approval waits, and manual takeover do not add new task enums; they live on the execution run and surface as derived blocked/reporting state when relevant. Cancelled tasks are terminal for active recovery/dispatch even if they still retain suspension metadata from earlier overlap handling.

## Retry: Exponential Backoff up to 1 Week

Run-level retry is handled by the orchestrator for transient failures only. Task execution runs and feature-phase runs share the same run/session model and backoff concepts when a session crashes or the provider fails transiently. Current baseline wiring persists both task and feature-phase message history through shared session-store backing under `.gvc0/sessions/`, and startup orphan recovery handles both scopes through the shared `dispatchRun(...)` path. For local pi-sdk runs, recovery checks persisted `workerPid` + `workerBootEpoch`, confirms ownership via `/proc/<pid>/environ` markers, kills stale workers from older orchestrator boots, then resumes or redispatches. Deterministic verification failures do not use retry backoff; they route through replanning or return the run to normal execution flow instead.

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
- Feature-level shell verification runs in `ci_check` on the feature worktree — once pre-verify, then again post-rebase inside the integration executor on top of the rebased branch.
- Agent-level semantic review runs later in `verifying`.
- The integration executor runs rebase → post-rebase `ci_check` → verify `main` still matches `expectedParentSha` → `git merge --no-ff`; both pre-verify and post-rebase `ci_check` reuse `verification.feature`.

### Verification Config

Verification layers are configured as editable command lists in `.gvc0/config.json`. The commands shown below are examples only; actual projects may use different tools and ecosystems (`npm`, `cargo`, `go test`, `pytest`, `mix`, etc.).

Current wiring:
- `verification.feature` is executed during pre-verify `ci_check` and during post-rebase `ci_check` inside the integration executor. The integration marker stores a JSON snapshot of the current verification config, but current post-rebase execution still rereads live config through `VerificationService`.
- `verification.task` is executed as the task-level lightweight check.

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
    }
  }
}
```

Feature checks run in the feature branch during `ci_check` and are the heavy branch-level gate before spec review. `verifying` is an agent-level review that checks whether the feature branch meets the feature spec. There is no separate `verification.mergeTrain` layer — post-rebase `ci_check` currently reruns the same `verification.feature` layer via `VerificationService`. Empty effective check lists are advisory-only: the phase still passes, but the orchestrator emits a warning because verification ran without configured commands (deduped per integration cycle — see [Warnings](./warnings.md)). Timeouts are configurable per verification layer; the 60s / 600s values shown above are baseline examples for local-machine workflows. Support for substantially longer-running verification windows is deferred. See [Feature Candidate: Long Verification Timeouts](../feature-candidates/lifecycle/long-verification-timeouts.md). Slow-check warnings and feature-churn warnings are described in [Warnings](./warnings.md). Upstream sync recommendation and conflict escalation behavior are described in [Conflict Coordination](./conflict-coordination.md).

### Unified Failure Routing to Replanning

All verify-shaped failures route through `replanning` with a typed `VerifyIssue[]` payload. There is no direct repair-task creation from verification outcomes. The source values are:

- `source: 'verify'` — agent-level review found the branch does not satisfy the feature spec.
- `source: 'ci_check'` — shell verification failed. `phase: 'feature'` for pre-verify, `phase: 'post_rebase'` for the in-executor run.
- `source: 'rebase'` — rebasing the feature branch onto latest `main` conflicted during integration. The downstream blocked feature (not the just-merged one) receives these issues when cross-feature overlap release surfaces a conflict.

A feature reaches `ci_check` after the last task lands on the feature branch, or after approved replan work lands. By default the branch should be green before the feature may leave `ci_check` and enter `verifying`, though a loose feature policy may relax that boundary.

If `ci_check` fails (pre-verify or post-rebase):
1. Keep the feature on the same feature branch.
2. Move feature work control to `replanning`; persist `VerifyIssue[]` with `source: 'ci_check'` onto `features.verify_issues`.
3. If the failure happened during integration (post-rebase), also eject the feature from the merge queue.
4. The replanner proposes follow-up graph changes keyed off `checkName` + `command`; new or modified tasks land on the same feature branch, and proposal-driven feature/dependency edits stay in the same approval flow.
5. Return to `ci_check` after approved replan tasks land.

If `verifying` finds that the code does not satisfy the feature spec:
1. Keep the feature on the same feature branch.
2. The verify agent emits typed `VerifyIssue[]` via the `raiseIssue` tool; the run's terminal payload carries the accumulated list and the orchestrator persists it onto `features.verify_issues` with `source: 'verify'`. A `verifier_issue_raised` event is written per call for audit.
3. If the verify run emits no blocking/concern issues the feature moves to `awaiting_merge`; otherwise feature work control moves to `replanning`. `nit`-severity issues are non-blocking: they still land on `features.verify_issues` and surface in the verification summary, but do not force replanning. See [Verify Nit Task Pool](../feature-candidates/runtime/verify-nit-task-pool.md) for the eventual mechanism to route these into post-merge follow-up work.
4. On approved replan, new/modified tasks land on the same feature branch; persisted `verifyIssues` stay until later verification passes replace them.
5. Return to `ci_check` after approved replan work lands.

If rebase fails during integration:
1. Eject from the merge queue and move feature work control to `replanning`.
2. Persist `VerifyIssue[]` with `source: 'rebase'` and `conflictedFiles` onto `features.verify_issues`.
3. The replanner proposes reconciliation changes that prefer merging upstream changes over discarding them, typically as new or edited tasks plus any needed dependency updates.
4. On re-enqueue, the feature returns through the normal queue after replanning or operator action. More specialized `rebase --onto ...` retry handling remains deferred.

### Typed `VerifyIssue` Shape

`VerifyIssue` is a discriminated union keyed on `source`. Full TypeScript schema lives in [data-model.md](../architecture/data-model.md). Per-source fields at a glance:

- `source: 'verify'` — optional `location`, `description`, optional `suggestedFix`.
- `source: 'ci_check'` — `phase: 'feature' | 'post_rebase'`, `checkName`, `command`, optional `exitCode`, optional truncated `output` (4KB cap), `description`.
- `source: 'rebase'` — `conflictedFiles: string[]`, `description`.

All variants share `id`, `severity: 'blocking' | 'concern' | 'nit'`. Persisted `VerifyIssue[]` payloads are capped at 32KB total with severity-ranked retention (blocking > concern > nit, most-recent first within severity).

See [Warnings](./warnings.md) for the per-source and aggregate replan-loop warning categories.

## Merge Train

Task completion does not land work on `main` directly. Instead:
1. The worker emits a terminal task result; only `completionKind === 'submitted'` is treated as landed task work on the feature branch.
2. After the last task lands, or after approved replan work lands, the feature runs branch checks in `ci_check`.
3. If `ci_check` passes, the feature runs agent-level spec review in `verifying`.
4. If `verifying` passes, feature work control becomes `awaiting_merge`.
5. Only then may collaboration control become `merge_queued`.
6. The merge train serializes feature-branch integration into `main` through the in-process integration executor (see [worker-model.md](../architecture/worker-model.md) for the subprocess and IPC shape).
7. The integration executor: writes the integration marker row (including a JSON snapshot of current verification config), rebases the feature branch onto latest `main`, runs post-rebase `ci_check`, verifies `main` still matches `expectedParentSha`, merges with `git merge --no-ff`, then persists merge SHAs, clears the marker, and marks collaboration control `merged`.
8. On success, summarization/work-complete flow continues later from the normal post-merge lifecycle.
9. On any integration failure (rebase conflict, post-rebase `ci_check` fail, or `main` moving underfoot), the executor ejects the feature from the queue and reroutes to `replanning` with a typed `VerifyIssue[]` payload (see Unified Failure Routing above). No repair task is created directly.
10. After approved replan tasks land, the feature returns through `ci_check` and `verifying`, and may re-enter the merge queue on pass.

Crash recovery between `git merge` and the clearing DB transaction is handled by a startup reconciler that treats git refs as authoritative. See [Integration Crash Recovery](#integration-crash-recovery) below (lands with the executor).

## Conflict Outcome Rules

### Same-Feature Task Conflict

When a same-feature task enters collaboration_control `conflict` after auto-rebase fails:
1. Steer the existing task agent in the real conflicted worktree.
2. If the agent resolves the conflict and later lands the task normally, clear the task's `conflict` collaboration state and continue the normal task completion path.
3. If the agent resolves the merge but still needs additional code changes, treat that as normal task work rather than a continuing collaboration conflict.
4. If the agent makes no meaningful progress, keep the task in `conflict` and escalate to targeted follow-up work, replanning, or user intervention.

### Cross-Feature Integration Conflict

Feature A merges successfully. After its merge, cross-feature overlap release may detect that a downstream feature B (still `branch_open` or `merge_queued`) now conflicts with the new `main`. The conflict is about **B**, not **A**:

1. Feature A completes integration normally — it is already `merged`.
2. The release loop produces `release.kind === 'replan_needed' | 'blocked'` records keyed by `release.featureId === B`.
3. Feature B's work control moves to `replanning` with a synthesized `VerifyIssue[]` of `source: 'rebase'` referencing the conflicted files. If B was already in the queue, it is ejected.
4. Replanner proposes reconciliation work on B's feature branch. On approval, B returns through `ci_check` and `verifying` and may re-enter `merge_queued`.

Integration-time rebase failure of the currently-integrating feature (the executor's own `git rebase`) also routes through `replanning` — see the Merge Train section above.

## Integration Crash Recovery

The integration executor writes a singleton marker row (`integration_state`) at the start of each cycle capturing `expectedParentSha`, `featureBranchPreIntegrationSha`, and a JSON snapshot of current verification config. The success path later persists merge SHAs, clears the marker, and marks collaboration control `merged` in separate steps. A crash between `git merge` and that cleanup can leave the marker present while `main` already points at the merge commit.

At startup, before the scheduler loop begins, the reconciler compares the marker row against actual git refs. Git refs are authoritative:

1. **No marker + `main` unchanged since previous run** — clean resume, no action.
2. **No marker + `main` at an unknown SHA** — an external push landed while the orchestrator was down. Halt the merge train, emit a warning, require operator confirmation before resuming.
3. **Marker present + `main` == `expectedParentSha`** — `git merge` never ran. Clear marker and retry integration from scratch.
4. **Marker present + `main` at a valid merge commit (parent 1 == `expectedParentSha`, parent 2 == post-rebase feature tip)** — `git merge` succeeded but cleanup crashed. Complete the remaining persistence updates from the marker (set `mainMergeSha`, `branchHeadSha`, flip `collabControl=merged`) and clear the marker.
5. **Marker present + any other `main` state** — state is ambiguous. Halt the merge train and require manual intervention.

The reconciler must be idempotent — a second invocation on the same state is a no-op.

## Hard Cancellation

Hard mid-integration cancellation is not implemented in the current inline coordinator. The intended marker-row contract and branch-reset behavior remain deferred design, alongside graceful mid-integration cancellation. See [Feature Candidate: Graceful Integration Cancellation](../feature-candidates/coordination/graceful-integration-cancellation.md).

## Stuck Detection

A task is **stuck** when it repeatedly fails verification and resubmits without making progress. This is a work_control condition, not a dependency-waiting or merge-conflict label.

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
7. Alternatively, the user may move the feature into `replanning`; the replanner proposal enters `await_approval`, and if approved it may edit tasks, add or remove features, or rewire dependencies. Original stuck task returns to `ready` only if approved proposal keeps it and its dependencies are still `done`.

## Help / Approval / Replanning

Task execution runs and feature-phase runs may call `request_help(query)` when they hit a semantic blocker that is not a transient provider failure. `request_help()` pauses the run immediately, stores the query in `payload_json`, and moves the run to `await_response` with manual ownership. The TUI may either answer the request directly through a typed runtime help-response message or attach to the live session and continue it in `running/manual` mode.

Manual drop-in interaction uses the same runtime control path: the orchestrator forwards plain-text `manual_input`, and the worker may stream plain-text `assistant_output` back while the run remains under manual ownership. The operator returns the run to automatic execution by triggering `release_to_scheduler`, which clears manual ownership only when no unanswered `request_help()` state remains on the run. Approval requests likewise stay run-owned: a worker emits `request_approval`, the orchestrator persists the waiting state on `agent_runs`, and later sends a typed `approval_decision` such as `approved`, `approve_always` when supported, `reject`, or `discuss`.

Replanning is triggered when a feature enters the `replanning` phase, either after verify-shaped failure routing in the orchestrator or through the current TUI proposal/approval flow for a selected replanning feature.

The replanner is a pi-sdk `Agent` with the same proposal-graph tools as the planner, plus read access to the current graph state and the failure context. It can:
- Add follow-on features and dependency rewires around retained started work
- Remove not-yet-started future features when proposal rules allow it
- Consolidate future work into retained features by editing metadata and rewiring dependencies
- Add/remove/change dependencies
- Edit task descriptions
- Produce an empty approved proposal when recovery should stop instead of continue, which auto-cancels feature because no tasks remain

Like planning, replanning operates on a temporary proposal graph rather than mutating the authoritative graph directly. Each tool call updates only the proposal graph and appends a tracked modification record so the resulting draft can be reviewed as both a graph snapshot and a mutation log.

A replanning proposal is stored in `payload_json` and surfaced as `await_approval`. If the user approves it, the recorded graph mutation sequence is applied to the authoritative graph and the original stuck task returns to `ready` unless the approved plan explicitly replaces or cancels that task; retained tasks still must satisfy dependency readiness before they dispatch again. If the user rejects it, the authoritative graph stays unchanged.

```typescript
// Replanner prompt includes:
// - Current graph state (serialized)
// - Failed feature + its tasks + last error output
// - Instruction: "Restructure this feature to make it achievable"
```

After replanning approval, the scheduler re-evaluates the frontier and dispatches newly ready tasks.
