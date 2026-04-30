# Phase 5 — Task → feature integration (foundational)

## Goal

Wire the missing step that lands task work onto the feature branch. Without it, the entire orchestrator is a no-op end-to-end: tasks commit to their own branch, the orchestrator state-flips them to `merged`, and the eventual `git merge --no-ff feature.featureBranch` into `main` integrates an empty feature branch.

This is the single biggest MVP gap on `main`. Phases 1–4 are defensive hardening; Phase 5 is the load-bearing happy path.

## Background

Verified gaps on `main`, end-to-end flow trace:

- **Top-level planner → feature/task creation**: works. Proposal-host pattern (`src/agents/tools/proposal-host.ts`), approval flow (`src/orchestrator/proposals/index.ts:94`), graph application (`src/core/proposals/index.ts:497-539`). Tested end-to-end in `test/integration/feature-phase-agent-flow.test.ts:514-588`.
- **Task dispatch → worktree → worker spawn**: works. `dispatchTaskUnit` (`src/orchestrator/scheduler/dispatch.ts:445-472`) ensures both feature and task worktrees, harness forks the worker with `cwd: worktreeDir` (`src/runtime/harness/index.ts:191`), `run_command` tool is scoped to the worktree (`src/agents/worker/tools/run-command.ts:141`).
- **Task → feature merge: ABSENT**. The task worktree is created on a **separate branch** (`feat-<name>-<feature-id>-<task-id>`) off the feature branch (`src/runtime/worktree/index.ts:28-32`). The agent commits to the task branch. `submit` (`src/agents/worker/tools/submit.ts:31-46`) emits a `result` IPC frame carrying `summary` + `filesChanged`, and **runs no git operations**. The orchestrator success handler (`src/orchestrator/scheduler/events.ts:84-101`) only flips `task.collabControl` to `'merged'` in memory, calls `features.onTaskLanded` (state-only, `src/orchestrator/features/index.ts:28-41`), and triggers `conflicts.reconcileSameFeatureTasks` — which performs *rebase-onto-feature* (`src/orchestrator/conflicts/git.ts:14-23`), **not** task-into-feature merge. Grep across `src/orchestrator/` and `src/runtime/` for `--squash` / `merge --squash` / branch-merge git commands returns zero hits.
- **Tooling docs claim a squash-merge happens**: `src/agents/worker/tools/confirm.ts:18` and `src/agents/worker/tools/submit.ts:8` both state "the orchestrator drives squash-merge". This is a documentation lie — no such code path exists. The eventual feature-into-main merge at `src/orchestrator/integration/index.ts:159` uses `--no-ff`, not `--squash`, and merges the *feature* branch tip — which has none of the task commits because they were never integrated.
- **Feature → main merge**: works mechanically (`src/orchestrator/integration/index.ts:54-176`, `src/core/merge-train/index.ts:125`) but integrates an empty feature branch given the gap above.
- **Minor data-model gap**: `awaiting_merge` is missing from `POST_EXECUTION_PHASES` in `src/core/scheduling/index.ts:113-117`. `featurePhaseCategory('awaiting_merge')` returns `'done'`. This does not break the merge train (the integration coordinator queries it directly) but is a cross-module inconsistency worth fixing in this phase.

## Steps

The phase ships as **3 commits**. Step 5.1 is the foundational change; 5.2 wires post-task reconciliation; 5.3 tightens the data model. Ship in order.

---

### Step 5.1 — Squash-merge task branch into feature on submit

**What:** add a `mergeTaskIntoFeature(task, feature)` operation that runs `git merge --squash` of the task branch into the feature branch and produces a single commit on the feature branch attributed to the task. Invoke it from the task-success path in `events.ts` **before** `transitionTask(..., 'merged')` — the transition is gated on `{ ok: true }` from the squash. On merge conflict (against other landed tasks), reroute via Step 5.2's inline retry loop (not via `reconcileSameFeatureTasks` — see file note below).

**Files:**

- `src/orchestrator/conflicts/git.ts` — add a **new** sibling to the existing `rebaseTaskWorktree` (`:14-23`, which is rebase-only and does not squash): `squashMergeTaskIntoFeature(taskBranch: string, featureBranch: string, featureWorktreePath: string, commitMessage: string): Promise<{ ok: true; sha: string } | { ok: false; conflict: true; conflictedFiles: string[] }>`. Implementation: `simpleGit(featureWorktreePath)` → `checkout featureBranch` (idempotent) → `merge --squash <taskBranch>` → on conflict, capture conflicted files via `status()`, `merge --abort`, and return conflict; on success, `commit -m <message>` and return the new HEAD sha. The `--squash` form leaves a single staged change; the explicit `commit` produces the feature-branch commit. `rebaseTaskWorktree` remains untouched — it is the conflict-resolution primitive Step 5.2 calls between squash retries.
- `src/orchestrator/scheduler/events.ts:84-105` — today, the `taskLanded` handler calls `transitionTask(..., status='done', collabControl='merged')` at `:87` (with `:87` being the `transitionTask` site per Phase 3 audit), then `features.onTaskLanded`, then `conflicts.reconcileSameFeatureTasks`. **Restructure**: first call `squashMergeTaskIntoFeature` (task is still in pre-merge state); only call `transitionTask(..., status: 'done', collabControl: 'merged')` on `{ ok: true, ... }`; then `features.onTaskLanded`. **Task `status` axis on conflict**: on `{ ok: false, conflict: true }`, leave both `status` and `collabControl` unchanged (keep `status: 'running'`). The retry loop in Step 5.2 mutates neither axis until it resolves. The FSM (`src/core/fsm/index.ts:349`) allows `running → done` after a successful retry. On exhaustion, Step 5.2 calls `transitionTask({status: 'failed'})` alongside the inbox+reroute (see Step 5.2 spec). Do **not** flip `status: 'done'` early and rely on retry to "fix" it — the FSM has no `done → running` arc. Note: do **not** call `reconcileSameFeatureTasks` for this case — that function's filter (`src/orchestrator/conflicts/same-feature.ts:65-75`) selects tasks with `collabControl === 'suspended'` AND `suspendReason === 'same_feature_overlap'`, AND excludes the dominant task itself. A just-landed task hitting a squash conflict matches none of these. Use the new `squashMergeTaskIntoFeature` and the existing `rebaseTaskWorktree` directly (Step 5.2).
- `src/agents/worker/tools/confirm.ts` and `src/agents/worker/tools/submit.ts` — update the docstring to match reality (`--squash` from feature worktree against task branch, single commit, summary used as commit message).
- `docs/architecture/worker-model.md` — already documents task→feature squash at `:47,64-79` as if it exists. Verify wording still matches once Step 5.1 is implemented; tighten if any drift remains.

**Tests:**

- `test/unit/orchestrator/conflicts/squash-merge.test.ts` — temp-repo fixture: (a) clean squash succeeds, single commit appears on feature branch with the expected message; (b) conflict against an already-landed task is detected, `merge --abort` runs, conflict returned; (c) idempotency: re-running on a no-op task branch (already merged) is a no-op, not an error.
- `test/integration/task-lands-on-feature-branch.test.ts` — drive a faux worker through `submit` with one file changed; assert the feature branch tip has a new commit whose tree contains that file; assert the task branch is left in place (disposal is Phase 4); assert the orchestrator state machine reaches `task.collabControl === 'merged'`.
- `test/integration/two-tasks-conflict-then-resolve.test.ts` — two tasks edit the same file; first lands cleanly, second hits conflict, gets rebased, then squash-merge succeeds on retry. End state: feature branch has both task commits, both tasks `merged`. **Note**: Step 5.2 extends this same fixture with retry-cap assertions; create the file in 5.1, extend it in 5.2.
- Update `test/integration/feature-phase-agent-flow.test.ts` if it asserts feature-branch tip equals main (it shouldn't after this change).

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the task→feature squash-merge: (1) the squash runs in the *feature* worktree, not the task worktree (the task worktree's HEAD is the task branch — running `merge --squash` there is a category error); (2) on conflict, the task is *not* prematurely flipped to `merged` — the state must reflect the unfinished integration so the next tick retries; (3) the commit message is non-empty and traceable to the task id (operators reading `git log` on the feature branch should be able to map each commit back to a task); (4) the feature-into-main integration coordinator at `src/orchestrator/integration/index.ts:159` is unchanged and now sees a non-empty feature branch; (5) `src/agents/worker/tools/submit.ts` does not run any git command itself — the merge belongs to the orchestrator, not the worker; (6) `--squash` is used (not `--no-ff`), so the feature branch gets one commit per task, not a merge-of-a-merge structure that complicates `git log`. Under 500 words.

**Commit:** `feat(conflicts): squash-merge task branch into feature on submit`

---

### Step 5.2 — Squash retry via direct rebase + capped attempts

**What:** when step 5.1's squash returns `conflict: true`, perform the rebase + retry **inline within the same `events.ts` handler**, capped at `maxSquashRetries`. No new SchedulableUnit kind, no new scheduler event type — keep the retry inside the existing tick boundary so the state stays simple. On exhaustion, route through `rerouteToReplan`.

**Files:**

- `src/config.ts` — add a new config field `maxSquashRetries: number` (default 3) alongside the existing retry knobs (camelCase to match the rest of `src/config.ts`; the codebase has zero snake_case config fields). Wire through `OrchestratorPorts.config` (`src/orchestrator/ports/index.ts:81-89`) into the scheduler ctor — that is the channel the `events.ts:84-105` retry site reads from. **Vocabulary boundary with Phase 1**: `maxSquashRetries` is a *sibling* concept to Phase 1's `RetryPolicy`, not a consumer of it. Phase 1's policy classifies transient/semantic worker errors and applies exponential backoff with jitter; Phase 5's loop is a deterministic git-conflict retry inside one tick (no jitter, no exponential delay, no transient classification — every iteration is `rebase → squash`). Phase 1 must explicitly carve out squash-retry as a sibling and Phase 5 must reference Phase 1 to make the boundary visible to readers.
- `src/persistence/migrations/010_inbox_items.ts` — **new TS migration** creating `inbox_items(id, ts, task_id, agent_run_id, feature_id, kind, payload, resolution)`. Indexes: `idx_inbox_items_unresolved WHERE resolution IS NULL`, plus per-`task_id` partial. **Owned by Phase 5** (not Phase 1.6) because Phase 5 ships first per ship order 5→1→2→3→4 and is the first writer; the table must exist before any phase emits an inbox row. Phase 1.6 extends the `kind` union with additional values but does not own the table.
- `src/persistence/db.ts` — register the new migration in the imports + `migrations` array literal (where `Migration001Init` … `Migration009AgentRunHarnessMetadata` are wired).
- `src/orchestrator/ports/index.ts` — extend `Store` with `appendInboxItem(item: InboxItemAppend): void`, `listInboxItems(opts?): InboxItem[]`, `resolveInboxItem(id, resolution): void`. Define the `InboxItemAppend` / `InboxItem` types and the initial `kind` string-literal union (`'squash_retry_exhausted'` for this phase; Phase 1.6 extends with `'semantic_failure' | 'retry_exhausted'`; Phase 1.7 extends with `'destructive_action'`).
- `src/persistence/sqlite-store.ts` — implement the three new Store methods with prepared statements.
- `src/orchestrator/scheduler/events.ts` — in the conflict branch added by Step 5.1, run a bounded loop: `for (let attempt = 0; attempt < maxSquashRetries; attempt++) { await rebaseTaskWorktree(...); const r = await squashMergeTaskIntoFeature(...); if (r.ok) break; }`. The rebase target is `featureBranch` (current tip, freshly resolved each iteration). On loop exhaustion: (a) call `transitionTask({status: 'failed'})` for the stuck task (the FSM has no `done → running` arc, and leaving the task as `running` after the orchestrator gives up would strand it; `failed` is the canonical terminal state for unrecoverable task-side failure); (b) **append an `inbox_items` row** of `kind: 'squash_retry_exhausted'` via `store.appendInboxItem` (the table + method exist from this same step's migration above; do not gate on Phase 1); (c) call `features.rerouteToReplan(featureId, [issue])` (`src/orchestrator/features/index.ts:51`) with a `RebaseVerifyIssue` whose `source: 'squash'` (NOT `'rebase'` — see vocabulary section below), `description` describes "task X failed to squash-merge into feature after N attempts", and `conflictedFiles` is the conflicted set from the **last attempt's** `squashMergeTaskIntoFeature` return; (d) call `completeTaskRun(...)` to close the agent_run row regardless of orchestrator-side outcome (the worker process exited cleanly; the `agent_runs` row should be `completed` so it is not double-counted as in-flight by recovery — replanning will create a new run for the replacement task); (e) **stranded `failed` task disposition**: do NOT dispose the failed task's worktree on this path — Phase 4's disposal hook keys off `transitionTask(..., 'merged')`, which never fires here. The residual worktree carries the partial work and is the input the replanner inspects when proposing a replacement task. The replanner is expected to remove or cancel the `failed` task as part of its proposal (the FSM permits `failed → cancelled` via `validateTaskCollabTransition`); until that happens, the task remains in the graph as a documented stranded entity. **VerifyIssueSource union extension**: `src/core/types/verification.ts:48` currently has `VerifyIssueSource = 'verify' | 'ci_check' | 'rebase'`. This step extends it to `'verify' | 'ci_check' | 'rebase' | 'squash'`. Phase 2's `main_moved` reroute keeps `'rebase'`; Phase 5's squash exhaustion uses `'squash'`. This lets operators disambiguate at planner intake (concurrency loss vs inherent conflict). Update `RebaseVerifyIssue` if needed, or add a sibling `SquashVerifyIssue` type — pick one and document.
- `src/orchestrator/conflicts/git.ts` — `rebaseTaskWorktree` already exists at `:14-23`. No changes needed; just call it from `events.ts`. Do **not** route this through `reconcileSameFeatureTasks` (its filter only matches `suspended/same_feature_overlap` tasks, not just-landed tasks).
- Logging: emit a structured log per attempt ("task X squash retry, attempt N/M") so operators can observe stuck retries. The TUI can pick this up later; for MVP a debug log is sufficient.

**Tests:**

- `test/unit/orchestrator/scheduler/squash-retry-loop.test.ts` — pure-logic unit test for the retry-decision math: cap behavior, rebase-then-retry sequencing, exhaustion path emits both `appendInboxItem` and `rerouteToReplan`. Mock `rebaseTaskWorktree` and `squashMergeTaskIntoFeature` to return scripted conflict/ok sequences. (Integration tests cover the wired-end version below; this unit test isolates the loop.)
- Extend `test/integration/two-tasks-conflict-then-resolve.test.ts` to assert the retry path: first squash conflicts, rebase runs, second squash succeeds — exactly two squash attempts, one rebase between them.
- `test/integration/task-squash-retry-cap.test.ts` — script the rebase to keep producing conflicts (e.g. by holding a phantom conflicting commit on the feature branch that the rebase cannot resolve); assert retries cap at `maxSquashRetries`, no `transitionTask(..., 'merged')` fires, an `inbox_items` row appears with `kind: 'squash_retry_exhausted'` (or `'retry_exhausted'`), and the feature ends in `replan_needed` with `source: 'squash'`.
- Verify the cap behavior: with `maxSquashRetries: 3`, expect exactly 3 squash attempts and 3 rebase attempts, then `appendInboxItem` followed by `rerouteToReplan`.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the squash retry: (1) retry happens after `rebaseTaskWorktree`, not via `reconcileSameFeatureTasks` — that function's filter (`src/orchestrator/conflicts/same-feature.ts:65-75`) only matches `suspended/same_feature_overlap` tasks; using it here would silently no-op; (2) the retry cap is honored (`maxSquashRetries`, default 3) and exhaustion routes to `appendInboxItem` (kind `'squash_retry_exhausted'` or `'retry_exhausted'`) **and** `rerouteToReplan` with `source: 'squash'` (NOT `'rebase'`) and `conflictedFiles` populated from the last attempt's return — not silent task loss, not a `'rebase'`-source collision with Phase 2's `main_moved` reroute; (3) `transitionTask(..., 'merged')` only fires on a successful squash — never inside the conflict branch; (4) `features.onTaskLanded` is also gated on success, not double-fired; (5) the rebase target is the *current* feature-branch tip (re-resolved each loop iteration), not a stale snapshot; (6) `maxSquashRetries` is a real config field added in this phase (`src/config.ts`), camelCase, threaded through `OrchestratorPorts.config`, not a magic number; (7) per-attempt logging emits enough info ("task X squash retry, attempt N/M") for an operator to recognize a stuck loop; (8) `VerifyIssueSource` union in `src/core/types/verification.ts:48` is extended to include `'squash'` (or a sibling `SquashVerifyIssue` is added); (9) the relationship between `maxSquashRetries` and Phase 1's `RetryPolicy` is documented — they are sibling concepts, not consumer/provider. Under 400 words.

**Commit:** `feat(scheduler): retry task squash after same-feature rebase`

---

### Step 5.3 — `awaiting_merge` in `POST_EXECUTION_PHASES`

**What:** add `'awaiting_merge'` to `POST_EXECUTION_PHASES` (`src/core/scheduling/index.ts:113-117`) so `featurePhaseCategory('awaiting_merge')` returns `'post'` instead of `'done'`. This brings the scheduling-graph view of feature state in sync with the merge-train view (which already treats `awaiting_merge` features as in-flight). Without this, any future use of `featurePhaseCategory` for reporting / TUI state / scheduling decisions silently treats merge-queued features as terminal.

**Files:**

- `src/core/scheduling/index.ts` — add `'awaiting_merge'` to the `POST_EXECUTION_PHASES` set. Verify `workControlToAgentRunPhase('awaiting_merge')` (`:144`) still has a sensible mapping (it should not be agent-dispatchable; the merge train owns this state).
- **Verify all three callsites of `featurePhaseCategory` in `src/core/scheduling/index.ts`** — `:167`, `:294`, `:600` (the function is module-private, declared at `:119` without `export`; `grep -rn featurePhaseCategory src/` returns only the declaration + 3 callers, so this is the complete consumer set). For each, trace what changes when `awaiting_merge` flips from `'done'` to `'post'`: scheduling decisions, frontier inclusion, milestone-completion checks. Adjust call sites that were quietly relying on the bug. If any consumer should keep treating `awaiting_merge` as terminal, add an explicit per-site check rather than reverting the category.
- `src/core/scheduling/queries.ts` (if it exists) — same audit.

**Tests:**

- `test/unit/core/scheduling/post-execution-phases.test.ts` — add a case asserting `featurePhaseCategory('awaiting_merge') === 'post'`.
- Re-run any scheduler / TUI test that touches feature-state classification.

**Verification:** `npm run check:fix && npm run check`.

**Review subagent:**

> Verify the data-model fix: (1) every reachable consumer of `featurePhaseCategory` is correct after the change — grep for callers and confirm none expected `awaiting_merge` to be `'done'`; (2) the merge-train integration path is unaffected (it does not go through `featurePhaseCategory`); (3) no test that mocks feature state with `awaiting_merge` regresses. Under 250 words.

**Commit:** `fix(core/scheduling): include awaiting_merge in post-execution phases`

---

## Phase exit criteria

- All three commits land in order.
- `npm run verify` passes.
- A minimal end-to-end smoke (manual or automated) drives: planner produces feature with one task → task runs → squash lands on feature branch → feature joins merge train → integration merges feature into main with the task commit visible in `git log main`.
- Run a final review subagent across all three commits to confirm: the squash is the only mechanism by which task work reaches the feature branch (no parallel rebase-only path silently making it look like work landed); conflict + retry produce deterministic state transitions; the data-model fix is wired without regression. Address findings before declaring the phase complete.

## Notes

- **Phase ordering**: this phase is foundational — without it, Phases 1–4 harden a system that does not actually integrate code. Recommended order: 5 → 1 → 2 → 3 → 4. The README exit criteria reflect this dependency.
- **Phase 4 dependency**: Phase 4's worktree disposal is described as feature-merge-only because no task-squash code path exists today. Once Phase 5 lands, Phase 4 should additionally dispose the *task* worktree on successful squash (not on `work_complete`) — see `feature_branch_lifecycle` memory. Phase 4's review-subagent should re-check this once Phase 5 is in.
- **Out of scope for Phase 5**: replacing `--no-ff` with `--squash` on the feature-into-main step (the feature-into-main merge structure is intentionally preserved as an audit trail of features), introducing a separate "merge worker" process (kept inline in the scheduler tick), and any `onto`-style rebase variants.
- **`IntegrationOutcome` is not extended**. `src/orchestrator/integration/index.ts:16-21` defines `IntegrationOutcome.kind ∈ {merged, rebase_conflict, main_moved, post_rebase_ci_fail, skipped}`. Phase 5's task-squash failure is **not** added to this union because it occurs *before* the feature reaches the integration coordinator (the coordinator only handles feature→main; task→feature is upstream). Task-squash exhaustion routes through `appendInboxItem` + `rerouteToReplan` directly, returning the feature to planning rather than progressing into integration. Documenting this decision so a later refactor does not mistakenly conflate the two layers.
