# gsd2 Conflict Steering

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the high-level architecture index.

Conflict steering is the policy layer that decides **when** an agent should be told to sync, **how strongly** that sync should be recommended or required, and **what context** should be injected when automatic reconciliation fails. It complements [File-Lock Conflict Resolution](./file-lock-conflict-resolution.md), which describes the lower-level overlap detection and pause/resume mechanics.

## Goal

Surface upstream updates early enough that agents can sync before stale assumptions turn into expensive conflicts, without constantly interrupting productive work.

The steering policy uses a ladder:
1. upstream update available
2. sync recommended
3. sync required
4. conflict resolution / escalation

## Steering Ladder

### 1. Upstream Update Available

Use for low-risk awareness only.

Typical conditions:
- another task has landed on the same feature branch
- no reserved-path or active-path overlap is currently known
- the task is not at an immediate verification / merge boundary

Action:
- record an event or lightweight UI signal
- do not interrupt the agent yet

### 2. Sync Recommended

Use when upstream changes are relevant and syncing earlier is likely beneficial, but continuing briefly is still acceptable.

Typical triggers:
- upstream changes intersect the task's reserved write paths
- the task is behind feature HEAD for a meaningful amount of time
- the task is approaching a checkpoint such as end-of-turn, verification, or submit

Action:
- inject a steering message at the next stable checkpoint
- let the agent choose to sync now rather than forcing an immediate stop

Example steer:

```text
Feature branch advanced by 2 commits. Updated files intersect your reserved paths:
- src/auth/session.ts
- src/auth/types.ts

Sync is recommended now before continuing or submitting.
```

### 3. Sync Required

Use when continuing without syncing is likely to waste work or produce invalid verification results.

Typical triggers:
- upstream changes intersect paths the task has already edited
- an active path lock collides with landed upstream work
- the task is about to submit, merge back, or run verification against stale branch state
- a write prehook detects a runtime overlap that must be coordinated

Action:
- pause or redirect the task into sync work before it continues normal execution
- if auto-rebase succeeds, resume with the updated branch state
- if auto-rebase fails, escalate into explicit conflict steering

### 4. Conflict Resolution / Escalation

Use when automatic sync or merge cannot safely finish the reconciliation.

Typical triggers:
- `ort` merge or similar auto-rebase fails
- feature-branch repair work is required after integration-time overlap
- repeated attempts show no meaningful progress

Action:
- preserve conflict state
- for same-feature task conflicts, steer the existing task agent in the real conflicted worktree
- for cross-feature integration rebase/check failures, remove the feature from the merge queue and create or steer repair work on the same feature branch
- monitor for progress
- escalate to replanning or user intervention only if repair does not make meaningful progress or the failure appears structural

## Checkpoints for Steering

Steering should happen at stable checkpoints rather than arbitrarily interrupting an edit burst.

Preferred checkpoints:
- after a model turn ends
- before `submit`
- after another task lands on the feature branch
- after a write prehook detects relevant overlap
- after verification failure
- when resuming from pause

The orchestrator should coalesce repeated upstream updates into one steer when possible instead of spamming the agent with multiple small notifications.

## Trigger Sources

The steering policy can use several signal sources, each with different confidence:

- **Planner reservations** — predictive, best for early recommendation and scheduling bias
- **Active path locks** — runtime ownership, best for required sync decisions
- **Actual git overlap** — ground truth for required sync and conflict escalation
- **Verification / submit boundaries** — checkpoints where stale state becomes expensive

Reservations should usually cause recommendation or scheduling penalty before they cause hard interruption. Hard runtime overlap should cause required sync or explicit conflict handling.

## Injected Context

A steering payload should be concrete and actionable. At minimum include:
- current feature branch ref / commit
- the paths that changed upstream
- whether the changed paths intersect reserved paths or already-edited paths
- whether automatic sync succeeded or failed
- the recommended next action (`review`, `sync now`, `resolve conflict now`)

Conflict payloads should additionally include:
- the rebased worktree state
- conflicted file paths
- a summary of what landed upstream
- any verification or merge output relevant to the failure

## Escalation Guidance

The baseline escalation sequence is:
1. **update available** — awareness only
2. **sync recommended** — nudge at next checkpoint
3. **sync required** — pause/redirect into sync before continuing
4. **conflict steer** — inject exact conflict context after auto-sync failure
5. **halted / no progress** — if there is no meaningful activity after steering
6. **repair task / replanning / user intervention** — depending on failure scope

Exact no-progress thresholds may still be tuned, but the orchestrator should prefer early recommendation over late forced conflict when the relevant upstream changes are already known.

## Relationship to Other Docs

- [File-Lock Conflict Resolution](./file-lock-conflict-resolution.md) — overlap detection, suspension, resume, and feature-pair coordination mechanics
- [Worker Model](./worker-model.md) — worktree lifecycle and runtime lock ownership
- [Verification and Recovery](./verification-and-recovery.md) — verification checkpoints and replanning behavior
- [Warnings](./warnings.md) — warning signals for long blocking or churn
