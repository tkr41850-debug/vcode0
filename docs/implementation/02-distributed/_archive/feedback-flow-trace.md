# End-to-end Flow Trace — Post-Phase 1-5 (01-baseline)

Audit of the milestone → feature → task → squash-onto-feature → feature-into-main
flow assuming all five phase docs in `docs/implementation/01-baseline/phase-{1..5}-*.md`
are merged as written, in the recommended ship order **5 → 1 → 2 → 3 → 4**.

## Verdict

**Yes-with-caveats.** The five phase docs collectively wire a coherent happy
path: planner proposal → approve → task dispatch → worker submit → squash into
feature → merge train → plumbing CAS into main → worktree disposal. Every
declared hand-off has an owning function, every event a listener, every state
flip a downstream consumer. Two real seams remain ambiguous (S1, S2 below) and
one minor under-specification in payload shape (S3); none is a hard break, but
all should be pinned before code lands.

## Trace

1. **Milestone queued.** Phase: pre-existing.
   Site: `src/compose.ts:87,90` (TUI toggle of `queueMilestone`/`dequeueMilestone`).
   State: `Milestone.steeringQueuePosition` set.
   Phase 3 step 3.1 wraps these calls in `__enterTick`/`__leaveTick`. No flow break.

2. **Planner-host emits feature proposal.** Phase: pre-existing.
   Site: `src/orchestrator/proposals/index.ts:94` (`approveFeatureProposal`).
   State: graph mutated through `applyGraphProposal` (`src/core/proposals/index.ts:497-539`),
   feature transitioned to `executing/branch_open` via `advanceFeatureAfterApproval`.
   Phase 3 step 3.1 caveat: this is invoked from `events.ts:198-326` inside a
   `try/catch` that swallows. With `GVC_ASSERT_TICK_BOUNDARY=1` an out-of-tick
   throw is silently logged (Phase 3 doc lists this as an explicit known caveat).

3. **Task transitions to `ready` and is selected for dispatch.** Phase: pre-existing.
   Site: `src/orchestrator/scheduler/dispatch.ts:445` (`dispatchTaskUnit`) called from
   `dispatchSchedulerReadyWork` at `:814-841`. Selection via `prioritizeReadyWork`
   (`src/core/scheduling/index.ts:431`).
   Phase 3 step 3.2 inserts `hasUnmergedFeatureDep` belt-and-suspenders here.
   No regression on happy path (single-feature flow has no feature deps).

4. **Worktrees ensured + worker forked.** Phase: pre-existing (Phase 1 hardens IPC).
   Sites: `dispatch.ts:459` (`ensureFeatureWorktree`), `:460` (`ensureTaskWorktree`),
   `src/runtime/harness/index.ts:191` (fork with `cwd: worktreeDir`).
   Phase 1 step 1.4 adds heartbeat (`workerHealthTimeoutMs`); Phase 1 step 1.1 adds
   TypeBox schema validation on every NDJSON frame.
   Phase 4 step 4.2 adds `sweepStaleLocks` before the first `ensureFeatureWorktree`,
   wired in `compose.ts` boot sequence (`:249-253`).

5. **Worker executes; calls `submit` tool.** Phase: pre-existing.
   Site: `src/agents/worker/tools/submit.ts:31-46` emits `result` IPC with
   `summary` + `filesChanged`. **Runs no git ops** — the merge belongs to the
   orchestrator (Phase 5 cross-references this constraint).

6. **Orchestrator success handler — squash into feature.** Phase **5**, step 5.1.
   Site: `src/orchestrator/scheduler/events.ts:84-105` (today's success branch
   in `taskLanded` handler).
   Reordered sequence (post-Phase 5):
   a. `activeLocks.releaseByRun(...)`.
   b. **`squashMergeTaskIntoFeature(taskBranch, featureBranch, featureWorktreePath, summary)`**
      — new, in `src/orchestrator/conflicts/git.ts` alongside existing `rebaseTaskWorktree:14-23`.
   c. On `{ ok: true }`: `graph.transitionTask({status:'done', collabControl:'merged'})`,
      `features.onTaskLanded(...)`, `conflicts.reconcileSameFeatureTasks(...)`,
      `completeTaskRun(...)`.
   d. On `{ ok: false, conflict: true }`: enter Phase 5 step 5.2 retry loop.
   What advances: task `running → done/merged`, feature branch acquires one
   commit per task (squash form).
   What could go wrong: see Hand-off issue **H1** (status axis on conflict path).

7. **Conflict-retry loop (inline).** Phase **5**, step 5.2.
   Site: same handler, inline `for` loop bounded by `maxSquashRetries` (camelCase,
   threaded through `OrchestratorPorts.config` per `src/orchestrator/ports/index.ts:81-89`).
   Loop body: `await rebaseTaskWorktree(...)` → `await squashMergeTaskIntoFeature(...)`.
   On exhaustion: append `inbox_items` row (kind `'squash_retry_exhausted'`), call
   `features.rerouteToReplan(featureId, [issue])` with `RebaseVerifyIssue`
   (`source: 'squash'`, `conflictedFiles: <last attempt>`). The inline `await`s
   are honored by Phase 3's tick-boundary counter scheme (counter spans the
   whole tick; `await`s inside the body remain "in-tick").

8. **All tasks landed — feature advances through verify.** Phase: pre-existing.
   Site: `src/orchestrator/features/index.ts:28-41` (`onTaskLanded`) → `ci_check`
   → `verify` → `awaiting_merge` (`:133`).
   Phase 5 step 5.3 reclassifies `awaiting_merge` from `featurePhaseCategory ===
   'done'` to `'post'` in `src/core/scheduling/index.ts:113-117`. Three audited
   consumers (`:167`, `:294`, `:600`) now treat such features as in-flight.
   Verified safe: `awaiting_merge` features have `collabControl ∈
   {merge_queued, integrating}`, both excluded by `readyFeatures()`
   (`src/core/graph/queries.ts:35-45`), so no spurious dispatch unit is
   produced. The classification change is purely accounting/metrics.

9. **Merge-train integration with plumbing CAS.** Phase **2**, step 2.1.
   Site: `src/orchestrator/integration/index.ts:158-159` (today's
   `checkout` + `merge --no-ff` pair).
   Replaced with: `merge-base` → `merge-tree --write-tree` → `commit-tree`
   (`-p expectedParentSha -p featureSha`) → `update-ref refs/heads/main
   <merge> <expected>`.
   On CAS failure (stderr: `cannot lock ref`): `rerouteToReplan` with
   `source: 'rebase'` (NOT `'squash'`) and `conflictedFiles: []`.
   Compatibility with reconciler: `src/orchestrator/integration/reconciler.ts:87-90`
   expects `parents[0] === expectedParentSha && parents[1] ===
   (featureBranchPostRebaseSha ?? featureBranchPreIntegrationSha)`. Phase 2's
   `commit-tree -p <expectedParentSha> -p <featureSha>` produces exactly this
   shape (the `featureSha` resolved from the post-rebase feature tip, which
   the coordinator already records as `postRebaseSha` at `:115-117`).
   No mutation of the orchestrator working tree.

10. **`feature_integration_complete` event + cross-feature release.** Phase: pre-existing.
    Site: `src/orchestrator/scheduler/index.ts:215-219` (enqueue), then
    `src/orchestrator/scheduler/events.ts:458-504` handler.
    `IntegrationCoordinator` already called `features.completeIntegration` at
    `:173`, so `events.ts:464`'s guard `feature.collabControl !== 'merged'`
    short-circuits — the second `completeIntegration` is dead weight on the
    happy path (intentional, per the comment at `:459-462`).

11. **Worktree disposal.** Phase **4**, step 4.1.
    Task disposal: hooked at `events.ts:84-105` *after* the new
    `transitionTask(..., 'merged')` succeeds (Phase 4 pinned this order — never
    before, never alongside; failures are async/non-blocking warnings).
    Feature disposal: hooked at `integration/index.ts:173`,
    `integration/reconciler.ts:97`, and (defensively) `events.ts:465`. Includes
    a sweep over `[...graph.tasks.values()].filter(t.featureId === featureId)`
    for any leftover task worktrees. Implementation in `src/runtime/worktree/index.ts`
    via new `removeWorktree(target, branch)` (idempotent).

12. **Feature reaches `work_complete`/`merged`.** Phase: pre-existing.
    Sites: `src/core/merge-train/index.ts:125`
    (`transitionFeature(..., 'merged')`) inside `completeIntegration`; the
    `verifying → awaiting_merge → summarizing → work_complete` ladder in
    `src/orchestrator/features/index.ts:118-149`.

## Hand-off issues

### H1 — Task `status` axis on squash-conflict path is under-specified (serious)

Phase 5 step 5.1 says on `{ ok: false, conflict: true }` "leave the task on its
current `collabControl`" but is silent on `status`. Today the success handler
flips `status: 'running' → 'done'` atomically with the collab change at
`events.ts:87-91`. After Phase 5:

- If the implementer keeps `status: 'running'` until the inline retry loop
  succeeds, the FSM is happy (running → done is allowed at
  `src/core/fsm/index.ts:349`) and the retry can complete cleanly.
- If the implementer flips `status: 'done'` immediately (parallel to the old
  behavior), the conflict-retry loop is operating on a `done` task. On
  exhaustion, `rerouteToReplan` does NOT touch tasks
  (`src/orchestrator/features/index.ts:51-81` has no `transitionTask` calls),
  so the task is stranded as `done/branch_open` while the feature replans.

Patch: Phase 5 step 5.1 should explicitly state "leave `status: 'running'` until
squash succeeds" or "if exhausted, also call
`graph.transitionTask({status: 'failed'})`". Either is fine; pick one and
document.

### H2 — `completeTaskRun` lifecycle on squash exhaustion is unstated (serious)

The today-handler always calls `completeTaskRun(...)` at `events.ts:102-104` to
mark the agent_run `completed`. Phase 5 reorders the success path but does not
explicitly say whether `completeTaskRun` fires on the exhaustion path. Two
plausible reads:

- "Yes, the worker has already exited successfully — agent_run should be
  `completed` regardless of whether the orchestrator can land the work." Then
  the run is reaped, no leak.
- "No, leave the run open so the replanner can attribute the failure to the
  same run." Then the run leaks unless replan explicitly closes it.

Phase 5 doc is silent. The simpler MVP is the former; codify it.

### H3 — Phase 2 `featureSha` provenance is implicit (nit)

Phase 2 step 2.1 writes `commit-tree <tree> -p <expectedParentSha> -p <featureSha>`
but does not state where `featureSha` is resolved. Reading the surrounding code
(`integration/index.ts:115-117` records `postRebaseSha`), the natural source is
that variable. The plumbing CAS will produce the exact merge shape the
reconciler expects (`parents[1] === expectedMergeParent2 ===
featureBranchPostRebaseSha`) only if the implementer uses `postRebaseSha` and
not a re-resolved tip. A passing test of "`parents[1] === featureSha` after
successful CAS" satisfies this implicitly — but pin the variable name in the
doc to remove the gap.

### H4 — `events.ts:465` feature-disposal site is dead on the happy path (nit)

Phase 4 step 4.1 lists three feature-disposal sites. The events.ts:465 site is
guarded by `if (feature.collabControl !== 'merged')`, and `IntegrationCoordinator.completeIntegration`
at `integration/index.ts:173` always sets the feature to `merged` first. So the
disposal hook there only fires on a recovery edge case (reconciler-driven flow
where the in-memory state is behind the ref). Phase 4 acknowledges this with
"verify whether this is a real production path"; the answer in the current
codebase is "primarily defensive, fires only on a recovery interleave." That's
fine — but state it so the reviewer doesn't flag the site as redundant during
implementation review.

## Clean hand-offs

- **Phase 5 reorder of `events.ts:84-105` does NOT collide with Phase 1's retry
  policy.** Phase 1.5 wraps `events.ts:113-116` (task error) and `:449-451`
  (feature_phase error). Phase 5 reorders the success branch only. The two are
  on independent control-flow paths.

- **Phase 5 squash retry loop is honored by Phase 3 tick guard.** The counter
  scheme at `src/core/graph/index.ts` (Phase 3 step 3.1) increments on tick
  entry and decrements on tick exit; `await`s inside the tick body keep the
  counter at 1, so squash-loop graph mutations satisfy `_assertInTick`.

- **Phase 2 plumbing CAS produces the merge shape the reconciler accepts.**
  `commit-tree -p expectedParentSha -p featureSha` →
  `parents[0] === expectedParentSha && parents[1] === featureSha` matches
  `reconciler.ts:87-90` exactly. The `update-ref` failure mode produces a
  dangling commit, no ref move, mirroring the existing `main_moved` reroute
  path with `conflictedFiles: []`.

- **`awaiting_merge` reclassification is safe.** `featurePhaseCategory` change
  from `'done'` to `'post'` only affects `buildCombinedGraph` virtual-node
  inclusion (line 167), the cross-feature edge wiring (line 294), and
  `unitToNodeId` (line 600). All three operate on `feature_phase` units that
  cannot be produced for `awaiting_merge` features (gated out by
  `readyFeatures()` via `collabControl ∈ {merge_queued, integrating}`).
  Behavior change is purely metric/accounting; no dispatch path is altered.

- **Inbox-row invariant survives the happy path AND the exhaustion path.**
  README cross-phase conventions section codifies "every escalation appends
  `inbox_items`." Phase 5.2 adds `'squash_retry_exhausted'`; Phase 1.7 adds
  `'destructive_action'`; existing Phase 1.6 covers `'semantic_failure'` and
  `'retry_exhausted'`. Happy path appends nothing (correct — no escalation).

- **`source: 'squash'` extension is consistent.** `VerifyIssueSource` union
  at `src/core/types/verification.ts:48` extends to `'verify' | 'ci_check' |
  'rebase' | 'squash'`. Phase 2 keeps `'rebase'` for `main_moved`; Phase 5 uses
  `'squash'` for inherent-conflict exhaustion. Operators can disambiguate at
  planner intake.

- **`maxSquashRetries` and `RetryPolicy` are sibling abstractions, properly
  documented as such.** Phase 5 step 5.2 explicitly carves out the boundary;
  Phase 1 step 1.5 mirrors the carve-out. Neither tries to consume the other.

- **`reconcileSameFeatureTasks` is correctly NOT used for squash conflicts.**
  Phase 5 explicitly notes its filter (`collabControl === 'suspended' AND
  suspendReason === 'same_feature_overlap'`) excludes a just-landed task. The
  retry uses `rebaseTaskWorktree` directly.

- **Worker submit stays git-free.** `src/agents/worker/tools/submit.ts:31-46`
  emits IPC only. Phase 5 cross-checks this in its review prompt.

- **Phase 4 task-disposal ordering is pinned post-feedback.** Disposal runs
  *after* `transitionTask(..., 'merged')` succeeds — never before, never
  alongside. Disposal failures log warn and don't roll back the merge.
