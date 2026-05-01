# Feedback Round 3 — Cross-phase consistency review

Independent fresh review of the five 01-baseline phase docs in their current
patched state. Ship order under review: **5 → 1 → 2 → 3 → 4**. Verified
against `src/` at HEAD.

## Verdict

The two prior review rounds resolved every B-blocker and most S-issues
cleanly. However, the **patch that added `inbox_items` writes to Phase 5
step 5.2 introduces a new ship-order regression**: under the recommended
order 5→1, Phase 5 calls `store.appendInboxItem` and writes to `inbox_items`
— neither of which exists in the codebase until Phase 1 step 1.6 ships
migration `011_inbox_items.ts` and adds the Store method. Phase 5's
"(or reuse Phase 1's `'retry_exhausted'` if Phase 1 has shipped)" hedge
gestures at the problem but does not resolve it. The other patches survive
the second look. A few stale line citations and a small order-ambiguity in
the squash-then-disposal chain are nits.

## New issues

### Blocker — Phase 5 forward-references `inbox_items` table and `appendInboxItem` method that Phase 1 introduces

- **Phase doc**: `phase-5-task-integration.md:61` (also `:67`, `:69`, README `:46`).
- **Source**: `src/orchestrator/ports/index.ts:43-58` shows `Store` does not
  define `appendInboxItem`. `src/persistence/migrations/` contains migrations
  001–009; no `010_*` or `011_*` exists yet. `grep -rn appendInboxItem src/`
  returns zero hits.
- **Hazard**: ship order 5→1→2→3→4. Phase 5 step 5.2 says "**append an
  `inbox_items` row** of `kind: 'squash_retry_exhausted'`" and the test
  `task-squash-retry-cap.test.ts` asserts the row appears. None of the
  prerequisites exist when Phase 5 ships first. Implementer either (a)
  silently drops the inbox call (breaking the README invariant), (b)
  reorders to 1→5 (breaking the foundational-first thesis), or (c) ships
  the migration + Store method as part of Phase 5 (which is not in the
  doc's file list). The "if Phase 1 has shipped" hedge in Phase 5 line 61
  defers the decision rather than making it.
- **Patch direction**: pick one and codify. Recommended: extend Phase 5
  step 5.2's `Files:` list to include the `inbox_items` migration + Store
  port + sqlite-store impl that Phase 1 step 1.6 today owns; have Phase 1
  step 1.6 instead extend the union with `'semantic_failure' |
  'retry_exhausted'` and the wiring from `decideRetry`. The schema and
  table belong to whichever phase ships first, by definition. Update README
  cross-phase conventions and the migration filename comment in
  `phase-1-safety.md:158` to match.

### Serious — Phase 1 step 1.5 description names handlers that do not exist

- **Phase doc**: `phase-1-safety.md:128, 134, 146` ("the `taskFailed` /
  `featurePhaseFailed` handlers").
- **Source**: `src/orchestrator/scheduler/events.ts:58, 152, 185, 388, 439, 458`
  — actual event types are `worker_message`, `feature_phase_complete`,
  `feature_phase_error`, `feature_integration_complete`, etc. There is no
  `taskFailed` or `featurePhaseFailed` symbol anywhere in `src/`.
- **Hazard**: a reviewer running the step-1.5 review subagent prompt at
  L146 will grep for handler names that do not exist and may either (a)
  miss a real retry site or (b) name new handlers that diverge from the
  real ones. The actual sites are: `worker_message → message.type ===
  'error'` (events.ts:108-122) and `event.type === 'feature_phase_error'`
  (events.ts:439-456).
- **Patch**: rewrite L128, L134, and the L146 review prompt to use the
  exact event-type discriminator strings ("the `worker_message` error
  branch and the `feature_phase_error` handler") rather than aliases. The
  prior review's S4 already pointed away from line numbers; finish the job
  by also dropping invented handler names.

### Serious — Phase 5 step 5.2 leaves a stranded `failed` task on the feature graph

- **Phase doc**: `phase-5-task-integration.md:61` ((a) "call
  `transitionTask({status: 'failed'})` for the stuck task").
- **Source**: `src/orchestrator/features/index.ts:51-81` —
  `rerouteToReplan` does not touch tasks. `src/core/fsm/index.ts:351`
  shows `failed → cancelled` is the only outbound transition; `failed` is
  effectively terminal.
- **Hazard**: after exhaustion, the feature transitions to `replanning`
  carrying a task in `running → failed` plus collab `branch_open` (squash
  never succeeded, so no `merged` flip). The replanner has to detect the
  `failed` task and either propose `remove_task` or `cancel` it. Phase 5
  doc and replanner-prompt docs do not state this contract; the integration
  test plan (line 69) only asserts the feature ends `replan_needed`. A
  silently-stranded `failed` task can still match `tasks.values()` filters
  in unrelated codepaths (e.g. Phase 4's leftover-task disposal sweep at
  feature-merge time will see and try to clean a still-`failed` task whose
  worktree may or may not exist depending on whether Phase 4's task
  disposal already fired — which it didn't, because the squash failed).
- **Patch**: add a sentence to Phase 5 step 5.2 stating "the replanner is
  expected to remove or cancel the `failed` task; until that happens, the
  task remains in the graph as a documented stranded entity. Phase 4 task
  worktree for the failed task is not disposed on this path — that
  worktree carries the partial work and is the input the replanner may
  inspect." Optionally, also have the exhaustion path call
  `graph.transitionTask({ collabControl: 'cancelled' })` after `failed` to
  put it in a fully-terminal pair, but that requires confirming the FSM
  permits it (currently `failed/branch_open → failed/cancelled` would need
  to validate a collab transition with `taskStatus === 'failed'` — see
  `validateTaskCollabTransition:406-411`, which only blocks when status is
  already `cancelled`, so the transition is legal).

### Nit — `compose.ts` line citations are 25–40 lines off in two phase docs

- **Phase 1**: `phase-1-safety.md:106` cites `compose.ts:212` and L109
  cites `:194` for the harness construction site. Actual is
  `src/compose.ts:237` (`new PiSdkHarness(sessionStore, projectRoot)`).
- **Phase 4**: `phase-4-recovery.md:41` cites `src/compose.ts:445` for
  the `for...of graph.tasks.values()` idiom. Actual is `:470`.
- **Phase 3**: `phase-3-scheduler.md:14` cites `compose.ts:458` for
  `cancelFeature`. Actual is in `cancelFeatureRunWork` body around `:470+`
  (function declared at `:464`).
- **Patch**: refresh the citations or restate by symbol/function name.
  Not a correctness blocker — the symbols are unique — but the prior round
  flagged exactly this drift class for `events.ts`, and `compose.ts`
  citations have the same issue.

### Nit — Phase 4 doc says project root accumulates `feat-*` directories; actual location is `.gvc0/worktrees/`

- **Phase doc**: `phase-4-recovery.md:13` ("the project root accumulates
  `feat-*` directories").
- **Source**: `src/core/naming/index.ts:44-47` — `worktreePath(branchName)`
  returns `.gvc0/worktrees/${branchName}`. `src/runtime/worktree/index.ts:20-22`
  joins `projectRoot` with `worktreePath(...)`.
- **Hazard**: cosmetic. The disposal logic uses the helper, so the path is
  correct in code. But the framing in Phase 4 Background is slightly
  misleading; an operator reading the doc will look for `feat-*` at the
  repo root and see nothing.
- **Patch**: change "project root" → "`<projectRoot>/.gvc0/worktrees/`" in
  the Background section. One-line edit.

### Nit — Phase 5 step 5.2 test fixture is touched twice in the same phase

- **Phase doc**: `phase-5-task-integration.md:41` (step 5.1 adds
  `two-tasks-conflict-then-resolve.test.ts`); `:68` (step 5.2 extends it).
- **Hazard**: the README cross-phase fixture-coordination note (`:49`)
  only flags `feature-phase-agent-flow.test.ts` for multi-phase touches.
  The `two-tasks-conflict-then-resolve.test.ts` fixture is multi-step
  within a single phase. Two commits in the same phase touching the same
  test file is fine, but it's worth saying so explicitly so the implementer
  doesn't write the file once in step 5.1 and then forget to extend in 5.2.
- **Patch**: add a one-line note in Phase 5 step 5.1 saying step 5.2 will
  extend this same fixture.

### Nit — `featurePhaseCategory` is a private (non-exported) function; "three known consumers" wording suggests external callers

- **Phase doc**: `phase-5-task-integration.md:89` ("Verify three known
  consumers of `featurePhaseCategory` in `src/core/scheduling/index.ts`").
- **Source**: `src/core/scheduling/index.ts:119` declares
  `function featurePhaseCategory(...)` without `export`; `grep -rn
  featurePhaseCategory src/` returns only the four hits inside that file
  (declaration + 3 callers). So "three known consumers" is in fact "every
  consumer in the codebase".
- **Patch**: change the wording from "three known consumers" to "all three
  callsites (the function is module-private)" — a tiny clarification that
  removes the implication that more callers may exist outside the file.

## Re-confirmed clean

- **FSM allows `running → failed`** (`src/core/fsm/index.ts:349`). Phase 5
  step 5.2's exhaustion-path `transitionTask({status: 'failed'})` is a
  legal arc, contrary to the question raised.
- **`completeTaskRun` exists with the expected signature**
  (`src/orchestrator/scheduler/events.ts:20-32`): `(ports, run, owner,
  extra)`. Phase 5's call at exhaustion (line 61(d)) compiles cleanly.
- **`VerifyIssueSource` extension is unambiguously owned by Phase 5**.
  Phase 5 step 5.2 line 61 specifies the union extension to add `'squash'`
  in `src/core/types/verification.ts:48`. Phase 2 doc only emits
  `'rebase'` and does not attempt to extend the union — so under ship
  order 5→2 the type already has `'squash'` available; under any other
  order Phase 2 still works because it uses the existing `'rebase'` value.
  No collision.
- **Phase 4 task-disposal ordering** ("after `transitionTask(...,
  'merged')`") sits cleanly inside Phase 5's restructured success branch
  (`events.ts:84-105`). The squash → transition → onTaskLanded →
  reconcile → completeTaskRun chain has unambiguous insertion points; the
  disposal call goes after the transition, anywhere before
  `completeTaskRun`, with no Phase-5-introduced conflict.
- **`POST_EXECUTION_PHASES` consumers count is correct**.
  `featurePhaseCategory` has exactly 3 callers (`:167`, `:294`, `:600`),
  all in `src/core/scheduling/index.ts`. Phase 5.3's audit covers them.
- **Field naming consistency holds across all five phases** in their
  current state: `maxSquashRetries`, `workerHealthTimeoutMs`,
  `retryPolicy.{baseDelayMs, maxDelayMs, jitterFraction, retryCap,
  transientPatterns}` are all camelCase. No snake_case leaks.
- **Inbox `kind` enumeration is consistent across docs** (modulo the
  blocker above): `semantic_failure | retry_exhausted | destructive_action
  | squash_retry_exhausted`. README `:46` codifies the union; Phase 1.6
  emits the first two; Phase 1.7 emits the third; Phase 5.2 emits the
  fourth.

## Open questions

1. **Inbox table ownership under ship order 5→1.** Should Phase 5 ship the
   `inbox_items` migration and Store method itself, or should the inbox
   call in Phase 5.2 be deferred (under a feature flag or TODO) until
   Phase 1.6 lands? Author preference would resolve the blocker.
2. **`failed` task disposition after squash exhaustion.** Is the
   replanner expected to clean up `failed` tasks (via `remove_task` /
   cancel), or should the orchestrator do it eagerly at exhaustion time
   (e.g. transition `failed/branch_open → failed/cancelled`)? Either
   answer is plausible; the doc currently states neither.
3. **Failed-task worktree disposal timing.** When a task transitions to
   `failed` on squash exhaustion, Phase 4 disposal does not fire (because
   it's keyed on `transitionTask(..., 'merged')`). Is the residual
   worktree useful input for the replanner, or is it dead weight? If the
   former, document it; if the latter, add a disposal hook on the
   `failed` transition path too.
