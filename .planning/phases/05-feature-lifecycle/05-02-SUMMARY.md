---
phase: 05
plan: 02
subsystem: feature-lifecycle
tags:
  - integration-test
  - fsm
  - test-fixture
  - e2e
requires:
  - 05-01 (planner acceptance fixtures + faux-planner harness)
provides:
  - test/helpers/feature-lifecycle-fixture.ts (reusable `createFeatureLifecycleFixture()` helper)
  - test/integration/feature-lifecycle-e2e.test.ts (happy-path walk through planning → awaiting_merge)
  - test/unit/core/fsm/feature-boundary-guards.test.ts (pinned FSM guard reason strings)
affects:
  - none (additive — test-only changes + default-concurrency knob flip on the new fixture)
tech-stack-added:
  - faux-provider-driven `LocalWorkerPool` + `InProcessHarness` wiring for feature-lifecycle E2E
patterns:
  - serialize executor turns through the shared faux queue by defaulting `maxConcurrency=1`
  - `process.chdir(tmpDir)` before each run so the worker's `run_command` tool picks up the fixture repo
  - emit `git add` + `git commit` as two separate `run_command` tool calls so the commit command begins with `git commit` and the worker's trailer-injection + `commit_done` path fires
key-files:
  created:
    - test/helpers/feature-lifecycle-fixture.ts
    - test/integration/feature-lifecycle-e2e.test.ts
    - test/unit/core/fsm/feature-boundary-guards.test.ts
  modified: []
decisions:
  - End-state assertion: feature reaches `workControl='awaiting_merge'` with `collabControl` in `{merge_queued, integrating}` — NOT literally `branch_open`. The plan's original end-state language said `branch_open`, but `completePhase('verify')` unconditionally routes through `markAwaitingMerge → enqueueFeatureMerge`, which advances `collabControl` to `merge_queued`, and the next tick's `beginNextIntegration` can further advance it to `integrating`. The plan's intent (feature cleanly exits the work-control phases and enters the merge train) is satisfied by either state.
  - Fixture default concurrency = 1 (not 2). Multiple tasks racing the shared faux queue interleaves assistant messages between executor processes non-deterministically; serializing tasks through a single worker keeps the transcript linear. 05-03 / 05-04 can override via `maxConcurrency`.
  - No intra-feature task dependency in the E2E transcript. `promoteReadyTasks` only runs at proposal-apply time; it is not re-evaluated when an upstream task lands. A dependent task therefore stays `status='pending'` forever in the current codebase. Emitting two independent tasks sidesteps the gap without taking it on as plan scope. Documented inline in the test.
metrics:
  duration: ~35 minutes (post-resume)
  completed: 2026-04-24
---

# Phase 5 Plan 02: Feature-Lifecycle FSM E2E + Boundary Guards Summary

Feature-Lifecycle FSM happy-path E2E integration test plus reusable fixture plus boundary-guard unit tests — all additive, no production code changes, no side-effects on unrelated integration tests.

## What landed

### 1. `test/helpers/feature-lifecycle-fixture.ts` — reusable E2E fixture

`createFeatureLifecycleFixture()` wires everything required to drive a feature through the Phase-5 FSM under real scheduler traffic:

- Tmp git repo (init + seed commit) so the worker's `run_command` tool can produce real commits with gvc0 trailers.
- `InMemoryFeatureGraph` + `InMemoryStore` + `InMemorySessionStore` (no sqlite churn).
- `PiFeatureAgentRuntime` wired against a single shared faux provider registered at the feature's `modelId` (defaults to `claude-haiku-4-5`).
- `LocalWorkerPool` (default `maxConcurrency=1`) + `InProcessHarness` for executor tasks. The pool's `onTaskComplete` enqueues `worker_message` events back into the scheduler so the event-queue path is exercised end-to-end (mirrors `compose.ts`).
- Real `VerificationService` (caller can swap in a stub via the `verification` option).
- `worktree` port stub that returns `<tmpDir>/.gvc0/worktrees/<featureBranch>`; `seedFeature()` materializes that directory so `VerificationService.resolveFeatureWorktree` succeeds during ci_check.

Fixture surface (extensible for 05-03 / 05-04):

- `seedFeature(featureId, options?)` — place a feature on the graph with optional task descriptions, workControl/collabControl/featureBranch/description overrides.
- `stepUntil(predicate, options?)` — drive `scheduler.step() + harness.drain()` pairs until the caller-supplied predicate is true or `maxTicks` exceeded.
- `faux.setResponses(...)` — script every LLM turn linearly.
- `workerMessages[]` — every frame that flowed through the pool (useful for `commit_done` / `result` / `error` assertions).
- `teardown()` — dispose pool + faux registration + rm tmp repo.

### 2. `test/integration/feature-lifecycle-e2e.test.ts` — happy-path walk

Drives a single feature through: **planning → executing → ci_check → verifying → awaiting_merge** with real worker commits.

Proves:

1. FSM guards hold under real event-queue traffic — the `verifying → awaiting_merge` boundary advances only once ci_check and verify have both succeeded.
2. Per-phase `AgentRun` rows (`plan`, `ci_check`, `verify`) all land in `runStatus='completed'`.
3. Each worker task produces a real git commit carrying both `gvc0-task-id` and `gvc0-run-id` trailers (asserted via `commit_done` frames with `trailerOk=true` and `sha` matching `[0-9a-f]{7,}`).
4. `feature_phase_completed` events are emitted for `plan`, `ci_check`, and `verify`.

Scope fences (NOT tested — per plan):

- Repair loop (05-04).
- Empty-diff verify (05-03).
- Merge-train promotion (`awaiting_merge → integrating → merged`) — Phase 6.

### 3. `test/unit/core/fsm/feature-boundary-guards.test.ts` — pinned guard reasons

Pins the exact `{ valid, reason }` payload for every boundary-guard path in `validateFeatureWorkTransition`:

| current          | proposed      | collab        | expected reason                                                     |
| ---------------- | ------------- | ------------- | ------------------------------------------------------------------- |
| `verifying`      | `awaiting_merge` | `merge_queued` | `verifying → awaiting_merge requires collabControl=branch_open`     |
| `verifying`      | `awaiting_merge` | `branch_open`  | `{ valid: true }`                                                   |
| `awaiting_merge` | `summarizing`    | `branch_open`  | `awaiting_merge → summarizing requires collabControl=merged`        |
| `awaiting_merge` | `summarizing`    | `merged`       | `{ valid: true }`                                                   |
| `awaiting_merge` | `work_complete`  | `branch_open`  | `awaiting_merge → work_complete requires collabControl=merged`      |
| `awaiting_merge` | `work_complete`  | `merged`       | `{ valid: true }`                                                   |

Each rejection exercises the boundary-specific reason path (not the earlier "cannot advance during conflict" or "cancelled when cancelled" guards). The `verifying → awaiting_merge` rejection uses `merge_queued` as the non-branch_open collab to avoid tripping the conflict guard.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug / transcript fix] Executor transcripts split `git add` + `git commit` into two `run_command` calls**

- **Found during:** Task 2 (first E2E test run)
- **Issue:** Combined `git add task-X.txt && git commit -m "..."` command meant `isGitCommitCommand` saw `git` `add` as the first two tokens, so trailer-injection didn't fire and no `commit_done` frame was emitted. The task still `submit`ted, but the commit_done-consumer assertions failed.
- **Fix:** Split each executor turn into two sequential `run_command` tool calls — the first `git add <file>`, the second `git commit -m "..."`. The second now begins with `git commit`, triggering trailer-injection + `commit_done` emission.
- **Files modified:** `test/integration/feature-lifecycle-e2e.test.ts`
- **Commit:** `26ef100`

**2. [Rule 1 — Bug / fixture default] `maxConcurrency` default flipped from 2 to 1**

- **Found during:** Task 2 (second E2E test run)
- **Issue:** With `maxConcurrency=2`, both tasks dispatched in parallel and raced the shared faux queue — assistant messages interleaved between the two executor processes, leaving one task's `terminalResult` unset (so it ended as `completionKind='implicit'`, keeping `collabControl='branch_open'` instead of advancing to `merged`).
- **Fix:** Defaulted `maxConcurrency` to 1 in the fixture. Tasks serialize through a single worker so each executor turn consumes its scripted assistant responses in order. Caller can still override via `options.maxConcurrency` for scenarios that don't rely on linear faux consumption.
- **Files modified:** `test/helpers/feature-lifecycle-fixture.ts`
- **Commit:** `26ef100`

**3. [Rule 1 — Plan deviation] End-state collabControl relaxed from `branch_open` to `{merge_queued, integrating}`**

- **Found during:** Task 2 authoring (transcript design)
- **Issue:** Plan 05-02's must-have says "feature reaches `workControl='awaiting_merge'` with `collabControl='branch_open'`". That is unreachable with the current production code path: `completePhase('verify')` unconditionally calls `markAwaitingMerge`, which calls `mergeTrain.enqueueFeatureMerge` and sets `collabControl='merge_queued'`; the following tick's `beginNextIntegration` can further advance to `integrating`.
- **Fix:** Assert `collabControl` is in `{merge_queued, integrating}` and document the rationale inline. Verifying that the collab value is NOT `branch_open` after verify completes captures the plan's intent (feature cleanly exited work-control phases into the merge train).
- **Files modified:** `test/integration/feature-lifecycle-e2e.test.ts`
- **Commit:** `26ef100`

**4. [Rule 2 — Documented gap] `promoteReadyTasks` not re-evaluated on task completion**

- **Found during:** Task 2 (initial dependent-task transcript)
- **Issue:** Adding an intra-feature dependency (`addDependency({from: 't-2', to: 't-1'})`) left t-2 in `status='pending'` after t-1 landed — there is no codepath that re-evaluates pending→ready promotion once an upstream task hits `done`. `promoteReadyTasks` is only called at proposal-apply time.
- **Fix:** Removed the dependency from the E2E transcript (two independent tasks). Documented the gap as an inline comment so future plans (04-xx revisit, if any) don't rediscover it. NOT fixing in this plan — it's an architectural change outside 05-02's scope (Rule 4 territory), and 05-02's must-have is E2E walk through the Phase-5 FSM, not intra-feature dependency enforcement.
- **Files modified:** `test/integration/feature-lifecycle-e2e.test.ts` (inline comment)
- **Commit:** `26ef100`
- **Follow-up:** Logged as a gap for Phase 4 revisit or a future intra-feature task-DAG plan. Not adding to `deferred-items.md` because 05-02's plan did not scope intra-feature task deps.

## Authentication Gates

None. Fixture uses the faux provider exclusively; no real API calls.

## Test results

- `test/integration/feature-lifecycle-e2e.test.ts`: 1 test pass (~3s faux-driven end-to-end walk).
- `test/unit/core/fsm/feature-boundary-guards.test.ts`: 6 tests pass (all three boundary guards + positive cases).
- `npm run check` (whole repo): 87 suites / 2 skipped, 1641 tests pass, 3 skipped, 10 pre-existing lint warnings (biome `noUnusedImports` in files touched by prior sessions — explicitly scope-fenced out per plan).
- `npm run typecheck`: clean.

## Known Stubs

None. Every piece of test scaffolding is wired to real behavior — real git repo, real `VerificationService`, real `SchedulerLoop`, real `LocalWorkerPool`, real `PiFeatureAgentRuntime`. The only stubbed surfaces are `UiPort` (no-op — none of the asserted code paths call it) and the `worktree` port (returns `path.resolve(tmpDir, worktreePath(...))` instead of shelling to `git worktree add`, because the test does not exercise task-worktree isolation — tasks all run inside the fixture's shared tmp repo).

## Commits

- `479de26` — `test(05-02): add reusable feature-lifecycle E2E fixture`
- `26ef100` — `test(05-02): add feature-lifecycle E2E happy-path test`
- `f01390e` — `test(05-02): pin feature FSM boundary-guard reason strings`

## Self-Check: PASSED

**Files:**
- FOUND: test/helpers/feature-lifecycle-fixture.ts
- FOUND: test/integration/feature-lifecycle-e2e.test.ts
- FOUND: test/unit/core/fsm/feature-boundary-guards.test.ts
- FOUND: .planning/phases/05-feature-lifecycle/05-02-SUMMARY.md

**Commits:**
- FOUND: 479de26 (Task 1: fixture)
- FOUND: 26ef100 (Task 2: E2E test)
- FOUND: f01390e (Task 3: boundary-guard unit tests)
