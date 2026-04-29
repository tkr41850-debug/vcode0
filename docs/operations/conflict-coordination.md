# Conflict Coordination

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for the high-level architecture overview.

Conflict coordination covers three related questions:

1. when the orchestrator should steer an agent to sync
2. how same-feature overlapping writes pause, resume, or escalate
3. how cross-feature runtime overlap chooses a primary feature and blocks the secondary side

Reservation overlap is advisory. Runtime overlap and failed rebases are the points where active coordination begins.

## Steering Ladder

Surface upstream updates early enough that agents can sync before stale assumptions turn into expensive conflicts, without constantly interrupting productive work.

1. **update available** — awareness only; no persisted state change
2. **sync recommended** — steer at the next stable checkpoint; still no persisted state change
3. **sync required** — pause or redirect into sync work before normal execution continues
4. **conflict steer** — inject exact conflict context after automatic reconciliation fails
5. **halted / no progress** — if follow-up work stalls, escalate to targeted replanning or user intervention

Runtime delivery models that ladder with a typed steering directive:
- `sync_recommended` with `timing: 'next_checkpoint' | 'immediate'`
- `sync_required` with `timing: 'next_checkpoint' | 'immediate'`
- `conflict_steer` with `timing: 'next_checkpoint' | 'immediate'` plus git-owned conflict detail

### Update Available

Use for low-risk awareness only:

- another task has landed on the same feature branch
- no relevant runtime overlap is known
- the task is not at an immediate verification or merge boundary

Action:

- record an event or lightweight UI signal
- do not interrupt the agent yet

### Sync Recommended

Use when syncing soon is likely beneficial, but continuing briefly is still acceptable.

Typical triggers:

- upstream changes intersect reserved write paths
- the task is behind feature HEAD for a meaningful amount of time
- the task is approaching a checkpoint such as end-of-turn, verification, or `submit()`

Action:

- inject a steering message at the next stable checkpoint
- let the agent choose to sync now rather than forcing an immediate stop

### Sync Required

Use when continuing without syncing is likely to waste work or invalidate upcoming verification.

Typical triggers:

- upstream changes intersect paths the task has already edited
- an active path lock collides with landed upstream work
- the task is about to submit, merge back, or run verification against stale branch state
- a write prehook detects runtime overlap that must be coordinated

Action:

- pause or redirect the task into sync work before it continues normal execution
- if auto-rebase succeeds, resume with the updated branch state
- if auto-rebase fails, escalate into explicit conflict steering
- do not move the run to `await_response` unless a human is actually needed; agent-directed sync remains part of normal execution flow

### Conflict Steer

Use when automatic sync or merge cannot safely finish the reconciliation.

Typical triggers:

- `ort` merge or similar auto-rebase fails
- feature-branch replanning is required after integration-time overlap
- repeated attempts show no meaningful progress
- more than 5 minutes pass after steering without meaningful activity

Action:

- preserve real collaboration conflict state
- for same-feature task conflicts, steer the existing task agent in the real conflicted worktree
- for cross-feature integration failures, remove the feature from the merge train and route follow-up work through replanning on the same feature branch
- keep `await_response` reserved for actual human-help/manual-takeover cases rather than normal agent-directed replanning follow-up

## Coordination Protocols

### Same-Feature File Locks

The file-lock system is primarily a same-feature collaboration_control mechanism. It coordinates overlapping writes between task worktrees that belong to the same feature branch.

Detection sources:

- planner reservations — predictive only
- write-prehook path checks — active runtime ownership
- actual git overlap between task worktrees — ground truth

Before runtime overlap handling kicks in, the planner reserves expected edit paths per task and the write-tool prehook tries to claim an active path lock on first write. If the path is already locked by another task in the same feature, treat that as same-feature overlap input.

#### Mechanical Handling

1. Group active worktrees by feature branch.
2. Detect overlapping edited paths.
3. Suspend the lower-priority task in that feature.
4. Persist the suspension reason and affected files.
5. Notify the suspended worker before stopping it.

#### Resolution

When the dominant task completes its work:

1. Merge its task branch into the feature branch.
2. Rebase each suspended task branch onto the updated feature branch.
3. If rebase resolves cleanly, optionally run a cheap sanity check such as `git diff --check`, then resume.
4. If rebase does not resolve cleanly, do not reset files and do not auto-pick `ours` / `theirs`; keep task collaboration control at `conflict` and inject exact conflict context.
5. Only resume the child process after the agent has the updated or conflicted context.

The baseline is intentionally fail-closed:

- Stage 1 is mechanical only and accepts only clean git resolution.
- Stage 2 is agent reconciliation in the real conflicted worktree.
- Destructive resets are not part of the baseline policy.

#### Conflict Context

For same-feature task conflicts, the steering payload should include at least:

- conflict type (`same_feature_task_rebase`)
- task id, feature id, task branch, and rebase target branch or SHA
- overlapped file paths and pause reason
- dominant task summary and changed files
- conflicted or unmerged file list from current git state
- reserved write paths for the task
- relevant dependency outputs already available
- last task verification result, if any

The injected summary is orientation only. The conflicted worktree remains authoritative.

#### Outcome Rules

After same-feature conflict steering begins:

1. If the agent resolves the conflict and later passes normal task `submit()` verification, clear task collaboration control from `conflict` and continue the normal completion path.
2. If the agent resolves merge markers but ordinary task verification still fails, treat that as normal task work rather than a continuing collaboration conflict.
3. If the agent makes no meaningful progress, keep task collaboration control at `conflict` and escalate to targeted follow-up work, replanning, or user intervention.
4. Treat conflict halting as a state-based rule, not a blind wall-clock timeout: only halt after at least 5 minutes have passed since steering began and there has been no meaningful activity during that window. Ongoing conflict-resolution progress should keep the task in the active conflict path.

### Cross-Feature Overlap

Cross-feature overlap is handled more conservatively than same-feature file locks.

- reservation overlap only applies a scheduling penalty
- runtime overlap from write-prehook checks or git state triggers active coordination

#### Runtime Coordination Algorithm

1. Detect an overlap incident between two features using normalized project-root-relative file paths.
2. The `ConflictCoordinator` receives the overlap incident and both features, applies the cross-feature priority policy (below) to choose **primary** and **secondary**.
3. Persist a runtime feature block on the secondary feature (`runtimeBlockedByFeatureId = <primary feature id>`). `readyFeatures()` and `readyTasks()` treat that block as scheduling authority until release.
4. Suspend all running secondary tasks via `transitionTask()`, transitioning task collab to `suspended` with `suspend_reason = "cross_feature_overlap"`, `blocked_by_feature_id = <primary feature id>`, and any overlapped file paths available from runtime detection.
5. Release active path locks for suspended tasks; reservations remain as planning metadata.
6. Let the primary feature continue normally.
7. If the secondary feature stays blocked for too long (`Date.now() - task.suspendedAt > threshold`), raise a warning via the existing warnings framework.
8. After the primary feature merges into `main`, release handling rebases the blocked secondary feature branch onto updated `main` before any secondary task resumes.
9. If the rebase succeeds, clear the runtime feature block, clear `blocked_by_feature_id` on affected tasks, and resume normal scheduling.
10. If the feature-branch rebase fails, persist typed `VerifyIssue[]` on the secondary feature and route it to `replanning`. Tasks remain suspended until approved replan work lands.
11. If the rebase succeeds but suspended task worktrees still cannot be resumed cleanly, keep the feature blocked and route that failure into the same replanning path.
12. If rebase plus verification succeeds, continue normally; otherwise escalate to replanning.

The baseline uses **per-feature blocking** (all secondary work paused) rather than per-task suspension (only overlapping tasks paused). This is simpler and safer — rebasing the feature branch with no active tasks avoids mid-flight worktree issues, and recovery on rebase failure is straightforward since no tasks need retroactive suspension. The parallelism cost is bounded because cross-feature overlap should be uncommon when reservation-based scheduling penalties are working. See [per-task cross-feature suspension](../feature-candidates/coordination/per-task-cross-feature-suspension.md) for the finer-grained alternative.

## Cross-Feature Priority Policy

Choose primary and secondary once per feature pair, not per file, to avoid split-brain ownership.

Ranking order:

1. explicit dependency predecessor wins
2. higher derived merge-proximity tuple wins: compare `collabRank(feature.collabControl)` first, then `workRank(feature.workControl)`
3. older milestone order and `orderInMilestone` win as stable request-order proxy until dedicated request or branch-open timestamps are modeled durably
4. feature blocking more downstream dependents wins
5. lexical feature id is final tie-breaker in baseline

Deferred ranking signals:

- older feature request or branch-open time should replace milestone-order proxy once durably modeled
- changed-line count remains deferred until a durable feature-level aggregate exists

Baseline derived ranks:

- `collabRank`: `integrating=3`, `merge_queued=2`, `branch_open=1`, `none=0`, `conflict=-1`, `merged=-2`, `cancelled=-2`
- `workRank`: `awaiting_merge=5`, `verifying=4`, `ci_check=3`, `executing=1`, `planning|researching|discussing=0`, `replanning=-1`, `summarizing|work_complete=-1`

## Persistence Notes

Cross-feature blocking is expressed as `Feature.runtimeBlockedByFeatureId` plus `blockedByFeatureId` on suspended task rows. The feature-level runtime block is the scheduling authority; task-level fields are for reconstruction and UI display. Suspension fields (`suspendedAt`, `suspendReason`, `suspendedFiles`, `blockedByFeatureId`) live on task rows and back `suspended` collaboration state. If a feature or task is later cancelled, active warning/release/recovery logic ignores those cancelled rows even if suspension metadata remains for historical or worktree context. The event log remains a debugging and audit surface, not the primary source of current coordination truth.

## Related

- [Worker Model](../architecture/worker-model.md)
- [Verification and Recovery](./verification-and-recovery.md)
- [Warnings](./warnings.md)
