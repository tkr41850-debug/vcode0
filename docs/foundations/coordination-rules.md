# Coordination Rules

Decision tables for the coordination rule families that govern
lock / claim / suspend / resume / rebase behavior in gvc0.

This layer is canonical: tables are canonical, and
[../operations/conflict-coordination.md](../operations/conflict-coordination.md)
is kept as the narrative reference. If the two disagree, update the narrative
to match the table rather than the other way around.

Each family below has:

- A one-paragraph intent statement
- At least one Markdown decision table
- A "Source of truth" subsection naming the module / function where the rule
  lives in code

---

## Lock

Intent: the **file-lock** system claims active runtime ownership over a write
path during the pi-sdk write pre-hook. It is the first coordination point
hit on every write. Locks are primarily a same-feature mechanism; cross-feature
overlap is routed to the claim + suspend rules further down.

### Lock — write pre-hook path claim

| scenario | path already locked? | same feature? | action | outcome |
| -------- | -------------------- | ------------- | ------ | ------- |
| path free | no | n/a | grant the lock; attach holder `<task_id>` | write proceeds immediately |
| path locked by same task (re-entrant write) | yes | same task | grant (no-op) | write proceeds; lock already held |
| path locked by another task in same feature | yes | same feature, different task | route to same-feature coordination (see [Suspend](#suspend)) | lower-priority task suspended; higher-priority continues |
| path locked by a task in a different feature | yes | different feature | route to cross-feature coordination (see [Claim](#claim) + [Suspend](#suspend)) | secondary feature's tasks suspended; primary continues |
| path locked by a task in a cancelled feature | yes | cancelled holder | ignore stale holder; grant the lock | write proceeds; stale lock reclaimed |

### Lock — release

| trigger | who calls | action |
| ------- | --------- | ------ |
| task run exits (completed / failed / cancelled) | orchestrator `release active locks` path | drop all active locks held by the exiting task |
| task collab transitions to `suspended` | orchestrator `suspend` handler | drop active locks for the suspended task; reservation metadata stays intact |
| task collab transitions to `merged` | orchestrator `merge` handler | drop active locks; reservation metadata cleared |
| shutdown | orchestrator shutdown path | drop all active locks on graceful exit |

### Source of truth

- Runtime claim round-trip in the worker: see the write-prehook documented in
  [../architecture/worker-model.md](../architecture/worker-model.md) and the
  IPC `claim_lock` message.
- Orchestrator-side ActiveLocks registry: `src/orchestrator/` (`ActiveLocks`
  runtime path registry).
- Release-on-exit policy: `src/orchestrator/` task-exit handler.

---

## Claim

Intent: when the scheduler picks ready work, it compares each ready unit's
reserved write paths against the paths currently held by running units. The
claim rules apply a **scheduling penalty** rather than a hard block: overlap
deprioritizes the ready unit and (for cross-feature overlap) emits a warning.

### Claim — reservation overlap at scheduling time

| ready unit overlaps running? | same feature? | priority tier | action |
| ---------------------------- | ------------- | ------------- | ------ |
| no overlap | n/a | any | dispatch normally |
| overlap with running task | same feature | same tier | dispatch with reservation-overlap penalty; penalty breaks ties only |
| overlap with running task | same feature | higher tier (verify/ci_check) | dispatch — tier wins; rely on same-feature [Suspend](#suspend) if runtime overlap follows |
| overlap with running task | different feature | any | apply cross-feature reservation penalty; emit `scheduling-priority` warning; defer if another unit is ready |
| overlap with a `partially_failed` feature's frontier | any | any | partially-failed deprioritization applies in addition to the overlap penalty |

### Claim — priority order on tie-break

See
[../architecture/graph-operations.md § Scheduling Priority Order](../architecture/graph-operations.md#scheduling-priority-order).
Reservation overlap is sort key #5. Retry-eligibility (#6) and age (#7) are
applied after the overlap penalty.

### Source of truth

- Priority sort implementation: `src/core/scheduling/`.
- Overlap computation: `src/core/scheduling/` (combined graph walk + reserved
  path intersection).
- Cross-feature priority policy (primary/secondary selection): documented in
  [../operations/conflict-coordination.md § Cross-Feature Priority Policy](../operations/conflict-coordination.md#cross-feature-priority-policy).

---

## Suspend

Intent: when runtime overlap actually happens (not just a reservation
prediction), the lower-priority task is suspended. Its worker process is
notified, its worktree is preserved, and its active locks are released so
the dominant task can continue.

### Suspend — same-feature overlap

| condition | suspended task run state | worktree state | resume trigger |
| --------- | ------------------------ | -------------- | -------------- |
| write-prehook detects lock held by dominant task in same feature | collab `suspended`, `suspend_reason = "same_feature_path_lock"`, run-state stays `retry_await` | preserved, unchanged | dominant task completes; its branch squash-merges into feature branch; rebase suspended task onto updated feature branch |
| rebase-in-progress for the feature (merge-train or integration repair) | collab `suspended`, `suspend_reason = "rebase_in_progress"` | preserved | rebase completes (merged or ejected to `branch_open`) |

### Suspend — cross-feature overlap

| condition | scope of block | suspended task run state | resume trigger |
| --------- | -------------- | ------------------------ | -------------- |
| write-prehook detects lock held by primary feature's task | **per-feature**: all running secondary-feature tasks suspended | collab `suspended`, `suspend_reason = "cross_feature_overlap"`, `blocked_by_feature_id = <primary>` | primary feature merges into `main`; release handler rebases secondary feature branch |
| secondary feature stays blocked beyond threshold (`Date.now() - suspendedAt > threshold`) | n/a | unchanged | warning raised via `core/warnings/`; human may intervene or raise the threshold |
| rebase of secondary feature fails after primary merge | n/a | stays `suspended` | integration-repair work created on the secondary feature branch; tasks resume only after repair lands |

### Source of truth

- FSM guard: `validateTaskCollabTransition` in
  [`src/core/fsm/index.ts`](../../src/core/fsm/index.ts).
- Suspension metadata columns (`suspendedAt`, `suspendReason`,
  `suspendedFiles`, `blockedByFeatureId`): see
  [../architecture/data-model.md](../architecture/data-model.md).
- Cross-feature runtime block: `Feature.runtimeBlockedByFeatureId` as
  scheduling authority (documented in
  [../operations/conflict-coordination.md § Persistence Notes](../operations/conflict-coordination.md#persistence-notes)).
- Per-feature blocking rationale:
  [../operations/conflict-coordination.md § Cross-Feature Overlap](../operations/conflict-coordination.md#cross-feature-overlap).
- Warning rule: `core/warnings/` — the blocked-too-long rule.

---

## Resume

Intent: the run-state axis has four overlays (`retry_await`, `await_response`,
`await_approval`, `manual` via `RunOwner`) that pause execution. Each has its
own resume trigger. This table is the authoritative list.

### Resume — run-state overlays

| run_state entry | condition that holds the run | resume action |
| --------------- | ---------------------------- | ------------- |
| `retry_await` | transient worker / provider failure; `retryAt` timestamp set by backoff policy | once `retryAt <= now`, scheduler re-marks the run `ready`; priority sort treats retry-eligible runs as pullable (sort key #6) |
| `await_response` | agent called `request_help` — waiting on the inbox for user input | user answers the inbox item; orchestrator clears `await_response` and transitions run to `ready` (or `running` if worker held) |
| `await_approval` | agent proposed an action requiring approval | user approves → run resumes at `ready`; user rejects → run transitions to `cancelled` (or `failed` depending on policy) |
| `manual` (owner = user, status unchanged) | user took ownership via TUI | user returns ownership (TUI action); orchestrator restores `owner = agent` and the run proceeds at its held status |

### Resume — task collab

| suspended cause | resume action |
| --------------- | ------------- |
| same-feature path lock | dominant task merges into feature branch → rebase suspended task's worktree → `suspended → branch_open` → run becomes `ready` |
| cross-feature overlap | primary feature reaches `merged` on `main` → rebase secondary feature branch → clear `runtimeBlockedByFeatureId` + `blocked_by_feature_id` → `suspended → branch_open` per task |
| integration-repair active | repair task lands → clear the `runtimeBlockedByFeatureId` block; resume downstream tasks via the same `suspended → branch_open` path |

### Source of truth

- Run-state overlays: `AgentRunStatus` in `src/core/types/` and
  `validateRunStateTransition` in `src/core/fsm/index.ts`.
- Retry-eligibility sort: `src/core/scheduling/` priority sort (sort key #6).
- `await_*` resume mechanics: orchestrator inbox handler and the pi-sdk
  harness contract (see
  [../architecture/worker-model.md](../architecture/worker-model.md)).
- `manual` ownership resumption: the `RunOwner` column on `agent_runs` and
  the TUI takeover/return flow described in
  [../reference/tui.md](../reference/tui.md).

---

## Rebase

Intent: the merge-train head is the only place where rebase happens in the
steady-state flow. A feature at the head rebases its branch onto latest
`main`, re-runs `ci_check`, and either merges or ejects. Task-level rebase
happens only on suspension resolution (see [Resume](#resume)).

### Rebase — merge-train head

| merge-train state | rebase result | verify result | next state | re-entry? |
| ----------------- | ------------- | ------------- | ---------- | --------- |
| `integrating` | rebase clean (no conflicts) | `ci_check` pass + `verify` pass | collab `merged`, work `awaiting_merge → summarizing` (or `work_complete` in budget mode) | no — terminal |
| `integrating` | rebase clean | `ci_check` or `verify` fail | collab `branch_open`, work `awaiting_merge → replanning` with typed `VerifyIssue[]` | yes, after replan lands |
| `integrating` | rebase conflict (merge markers or unresolvable) | n/a (not run) | collab `conflict`; conflict steering injected on the feature branch | yes, once conflict resolved |
| `conflict` | repair landed; re-enter queue | n/a (deferred to next `integrating`) | collab `conflict → merge_queued` (requires `work = awaiting_merge`) | yes |
| `merge_queued` | ejected for repair without integrating | n/a | collab `merge_queued → branch_open` (requires `work = awaiting_merge`) | yes |

Verify-shaped failures (`verify`, `ci_check` pre-verify or post-rebase, or
rebase itself) all route to `replanning` with a typed `VerifyIssue[]` per
[ARCHITECTURE.md](../../ARCHITECTURE.md#core-thesis).

### Rebase — integration-worker lifecycle

The merge-train executor spawns an **integration-worker** subprocess per
cycle. A marker row persists the "integrating" claim; a startup reconciler
handles the crash window between `git merge --force-with-lease` and the
database state transition.

| marker row state | process alive? | reconciler action |
| ---------------- | -------------- | ----------------- |
| marker absent | n/a | no action |
| marker present, pid alive, HEAD not at target | yes | wait — integration in progress |
| marker present, pid dead, merge SHA visible on `main` | no | advance collab to `merged`; drop marker |
| marker present, pid dead, no merge SHA on `main` | no | treat as failed integration; drop marker; route feature to `conflict` or `branch_open` per verify outcome |

### Source of truth

- Merge-train executor: `src/core/merge-train/` and the in-process executor
  described in
  [../architecture/worker-model.md](../architecture/worker-model.md).
- Integration-worker marker + reconciler: persistence layer
  (`src/persistence/`) + orchestrator startup path.
- Verify-failure routing: shared with
  [../operations/verification-and-recovery.md](../operations/verification-and-recovery.md).

---

## Re-entry

Intent: repair / replan loops cannot run forever. The re-entry cap bounds how
many times a feature can re-enter the merge train before it must be parked
for human review. Default cap is 10; it is configurable per-profile.

### Re-entry — cap behavior

| `reentry_count` | action | routed to |
| --------------- | ------ | --------- |
| 0 (initial enqueue) | enqueue at normal tail | merge queue |
| 1..(cap - 1) | after repair/replan lands, requeue at tail; `reentry_count++` | merge queue |
| == cap | park the feature; do not requeue | inbox item: "merge-train re-entry cap reached" with diagnostics |
| > cap | impossible in normal flow; startup reconciler logs and parks the feature | inbox item |

### Re-entry — count update rules

| trigger | `reentry_count` change | notes |
| ------- | --------------------- | ----- |
| feature first enters `merge_queued` (from `branch_open`) | 0 → 1 | initial entry counts |
| conflict resolved; re-enter from `conflict → merge_queued` | `n → n+1` | each trip through the queue counts |
| integration verify fails; replanning landed; re-enter | `n → n+1` | verify-failure routing counts |
| feature is cancelled / merged | frozen | terminal, not incremented |
| user explicitly unparks a capped feature (rare) | reset to 0 | requires deliberate action |

### Source of truth

- Cap value: configuration (default 10) — see
  [../architecture/budget-and-model-routing.md](../architecture/budget-and-model-routing.md)
  for per-profile overrides.
- Enforcement: orchestrator merge-queue enqueue handler.
- Warning when approaching cap: `core/warnings/` merge-train-reentry rule
  (see [../operations/warnings.md](../operations/warnings.md)).
- Inbox routing when capped: `src/orchestrator/inbox/` (or equivalent).

---

## Related references

- [../operations/conflict-coordination.md](../operations/conflict-coordination.md)
  — narrative reference the tables above distill.
- [../operations/verification-and-recovery.md](../operations/verification-and-recovery.md)
  — verify-shaped failures and the replanning contract.
- [../operations/warnings.md](../operations/warnings.md) — the warning rule
  catalog that surfaces long-blocked / near-cap situations.
- [state-axes.md](./state-axes.md) — the underlying work / collab / run axes
  these rules transition between.
- [execution-flow.md](./execution-flow.md) — where the conflict-check step
  sits inside the scheduler tick.
